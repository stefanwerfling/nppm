import nodeFs from 'fs';
import path from 'path';
import {JsonCache} from '../Cache/JsonCache.js';
import {Project} from '../Project/Project.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {
    SourceEdge,
    SourceFile,
    SourceFileKind,
    SourceGraphData
} from './SourceGraph.js';

/**
 * Filesystem facade the builder relies on. Tests pass an in-memory
 * shim with the same shape so the suite stays off-disk.
 */
export type SourceGraphFs = {
    existsSync: (p: string) => boolean;
    readdirSync: (p: string) => string[];
    readFileSync: (p: string, enc: 'utf-8') => string;
    statSync: (p: string) => {
        isDirectory: () => boolean;
        isFile: () => boolean;
        mtimeMs?: number;
    };
};

/**
 * Source-file extensions the walker picks up. Matches `UnusedDetector`
 * so the two views see the same file set. `.d.ts` is excluded — it
 * carries only types and would clutter the graph without adding
 * meaningful import edges.
 */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Directories we never walk into. Same list as `UnusedDetector` so
 * users don't get surprised when the two views disagree about which
 * files count.
 */
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
    'coverage', '.nppm', '.nppm-cache', '.nppm-history', '.next', '.nuxt',
    '.cache', '.parcel-cache', '.turbo', '.vite'
]);

/**
 * File extensions that — when a relative import omits the extension —
 * are tried in order. TypeScript-first because most projects targeting
 * the source-graph view will be TS. `index.<ext>` is tried as a
 * directory-style fallback.
 */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Bump when the cached shape changes so old entries are invalidated
 * the next time the builder runs.
 */
const CACHE_KEY_PREFIX = 'sg_v3_';

/**
 * Walks a local project's source files, regex-extracts every relative
 * `import` / `require` / `import()` / `export … from` specifier, and
 * resolves them back to graph nodes. Bare specifiers (npm package
 * deps) are ignored — those live in the existing dep-graph pipeline.
 *
 * The walk runs entirely on disk and never hits the network, so a
 * cold scan over a 5k-file repo finishes in well under a second.
 * Results are cached per project, keyed by an mtime-based fingerprint
 * so an edit to one source file invalidates the cache without
 * touching the others.
 */
export class SourceGraphBuilder {

    private readonly _cache: JsonCache|null;
    private readonly _fs: SourceGraphFs;

    public constructor(cache: JsonCache|null, fs?: SourceGraphFs) {
        this._cache = cache;
        this._fs = fs ?? {
            existsSync: nodeFs.existsSync,
            readdirSync: (p: string): string[] => nodeFs.readdirSync(p),
            readFileSync: (p: string, enc: 'utf-8'): string => nodeFs.readFileSync(p, enc),
            statSync: (p: string): nodeFs.Stats => nodeFs.statSync(p)
        };
    }

    public async build(project: Project): Promise<SourceGraphData> {
        const projectMeta = {
            unid: '',
            name: project.getName(),
            type: project.getType()
        };

        if (!(project instanceof ProjectLocal)) {
            return {
                project: projectMeta,
                supported: false,
                unsupportedReason: 'Remote projects (GitHub/Gitea) are not scanned in v1 — please check out locally.',
                files: [],
                edges: [],
                unresolved: 0,
                filesScanned: 0
            };
        }

        const root = project.getRoot();
        const collected: {abs: string; rel: string; mtime: number;}[] = [];
        this._collect(root, collected);

        /*
         * Cache fingerprint: count + max(mtime) over the discovered
         * files. Cheap to compute, catches the common cases (an edit
         * bumps mtime; an add/remove changes the count). False sharing
         * is possible if a touched file's mtime equals the previous
         * max, but the result is at most one stale render — a hard
         * refresh re-scans.
         */
        let maxMtime = 0;
        for (const f of collected) {
            if (f.mtime > maxMtime) {
                maxMtime = f.mtime;
            }
        }
        const cacheKey = `${CACHE_KEY_PREFIX}${project.getKey()}__${collected.length}__${maxMtime}`;
        const cached = this._cache?.get<SourceGraphData>(cacheKey);
        if (cached) {
            return {...cached, project: projectMeta};
        }

        /*
         * Workspace bridge map: package-name → workspace-root abs
         * path. A bare specifier like `@scope/foo` matching a known
         * workspace gets routed to that workspace's entry file
         * (index/main convention) so the graph shows the actual
         * cross-workspace import edge instead of leaving the two
         * sides as visually disconnected clusters.
         */
        const workspaceRoots = new Map<string, string>();
        try {
            const manifests = await project.loadManifests();
            for (const m of manifests) {
                if (m.workspace !== undefined && m.name && m.name !== '<unnamed>') {
                    workspaceRoots.set(m.name, path.join(root, m.workspace));
                }
            }
        } catch {
            /* manifests broken — fall back to no workspace bridge */
        }

        /*
         * Resolve a content-addressable set of known files. Used both
         * for the node list and for resolving relative specifiers.
         */
        const idToAbs = new Map<string, string>();
        const absToId = new Map<string, string>();
        const files: SourceFile[] = [];
        for (const {abs, rel} of collected) {
            const id = rel.split(path.sep).join('/');
            idToAbs.set(id, abs);
            absToId.set(abs, id);
        }

        /*
         * Pre-pass: read each file once and record both its content
         * (so the main pass doesn't need a second readFileSync) and
         * its re-export table. The re-export table is what lets the
         * workspace bridge route `import {X} from '@scope/pkg'`
         * straight to the file that defines X, instead of dumping
         * every cross-workspace import on the barrel `index.ts`.
         */
        const contentByAbs = new Map<string, string>();
        const reExportsByAbs = new Map<string, Map<string, string[]>>();
        for (const {abs} of collected) {
            let content: string;
            try {
                content = this._fs.readFileSync(abs, 'utf-8');
            } catch {
                continue;
            }
            contentByAbs.set(abs, content);
            const re = SourceGraphBuilder._scanReExports(content);
            if (re.size > 0) {
                reExportsByAbs.set(abs, re);
            }
        }

        const edges: SourceEdge[] = [];
        const edgeSeen = new Set<string>();
        let unresolved = 0;

        const addEdge = (fromId: string, toId: string): void => {
            if (fromId === toId) {
                return;
            }
            const key = `${fromId}${toId}`;
            if (edgeSeen.has(key)) {
                return;
            }
            edgeSeen.add(key);
            edges.push({from: fromId, to: toId});
        };

        for (const {abs, rel} of collected) {
            const id = rel.split(path.sep).join('/');
            const kind = SourceGraphBuilder._kindOf(id);
            const content = contentByAbs.get(abs);
            if (content === undefined) {
                continue;
            }

            const loc = SourceGraphBuilder._countLines(content);
            files.push({id: id, kind: kind, loc: loc});

            const {imports, dynamicHits} = SourceGraphBuilder._scanImportsDetailed(content);
            unresolved += dynamicHits;

            const here = path.dirname(abs);
            for (const imp of imports) {
                let entryAbs: string|null = null;
                let isWorkspaceBare = false;
                if (SourceGraphBuilder._isRelative(imp.spec)) {
                    entryAbs = this._resolve(here, imp.spec);
                } else {
                    entryAbs = this._resolveWorkspace(imp.spec, workspaceRoots);
                    if (!entryAbs) {
                        /*
                         * Bare specifier that doesn't match a known
                         * workspace — external npm dep, handled by
                         * the dep-graph view, not this one.
                         */
                        continue;
                    }
                    isWorkspaceBare = true;
                }
                if (!entryAbs) {
                    unresolved++;
                    continue;
                }

                /*
                 * Workspace bridge + named imports: walk the barrel's
                 * re-export chain so the edge lands on the file that
                 * actually defines each imported symbol. Fall back to
                 * the entry file for default / namespace imports
                 * (where we can't tell which symbols got pulled in).
                 */
                if (isWorkspaceBare && imp.named.length > 0) {
                    let routedAny = false;
                    for (const symbol of imp.named) {
                        const definingAbs = this._traceSymbol(
                            entryAbs, symbol, reExportsByAbs, new Set()
                        );
                        const target = definingAbs ?? entryAbs;
                        const targetId = absToId.get(target);
                        if (targetId) {
                            addEdge(id, targetId);
                            routedAny = true;
                        }
                    }
                    if (routedAny) {
                        continue;
                    }
                }

                const entryId = absToId.get(entryAbs);
                if (!entryId) {
                    unresolved++;
                    continue;
                }
                addEdge(id, entryId);
            }
        }

        files.sort((a, b) => a.id.localeCompare(b.id));
        edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

        const result: SourceGraphData = {
            project: projectMeta,
            supported: true,
            files: files,
            edges: edges,
            unresolved: unresolved,
            filesScanned: files.length
        };

        if (this._cache) {
            this._cache.set(cacheKey, result);
        }

        return result;
    }

    /**
     * Walk the project tree, pushing every source-file path into
     * `out`. Hidden entries (`.`) and the `SKIP_DIRS` set are pruned
     * exactly like in `UnusedDetector`, so the two views agree on
     * which files count.
     */
    private _collect(root: string, out: {abs: string; rel: string; mtime: number;}[]): void {
        const walk = (dir: string): void => {
            let entries: string[];
            try {
                entries = this._fs.readdirSync(dir);
            } catch {
                return;
            }
            for (const entry of entries) {
                if (SKIP_DIRS.has(entry) || entry.startsWith('.')) {
                    continue;
                }
                const full = path.join(dir, entry);
                let stat;
                try {
                    stat = this._fs.statSync(full);
                } catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    walk(full);
                    continue;
                }
                if (!stat.isFile()) {
                    continue;
                }
                const ext = SourceGraphBuilder._fileExtension(entry);
                if (!SOURCE_EXTENSIONS.has(ext)) {
                    continue;
                }
                out.push({
                    abs: full,
                    rel: path.relative(root, full),
                    mtime: stat.mtimeMs ?? 0
                });
            }
        };
        walk(root);
    }

    /**
     * Strip JS comments so the import / re-export regexes don't
     * match the inside of a comment block.
     */
    private static _stripComments(content: string): string {
        return content
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
    }

    /**
     * Detailed import-statement parser. Beyond `_scanImports`'s flat
     * spec list, this records *which symbols* each import pulls in —
     * so the workspace bridge can route the edge straight to the
     * file where the imported class actually lives instead of
     * stopping at the barrel `index.ts`.
     *
     * Recognises five shapes:
     *  - `import 'spec'`                 (side-effect only)
     *  - `import D from 'spec'`          (default)
     *  - `import {A, B as C} from 'spec'`(named — A and B, not C)
     *  - `import * as N from 'spec'`     (namespace)
     *  - `import D, {A} from 'spec'`     (default + named)
     */
    private static _scanImportsDetailed(content: string): {
        imports: {spec: string; named: string[]; hasDefault: boolean; isNamespace: boolean;}[];
        dynamicHits: number;
    } {
        const out: {spec: string; named: string[]; hasDefault: boolean; isNamespace: boolean;}[] = [];
        const stripped = SourceGraphBuilder._stripComments(content);

        /*
         * Match `import <clause> from '<spec>'` where the clause
         * captures everything except the `from` keyword. We then
         * post-process the clause text to figure out what it is.
         */
        const reImport = /(?:^|[\s;])import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gu;
        let m: RegExpExecArray|null;
        while ((m = reImport.exec(stripped)) !== null) {
            const parsed = SourceGraphBuilder._parseImportClause(m[1]);
            out.push({spec: m[2], ...parsed});
        }

        // Bare side-effect import: `import 'spec';`
        const reBare = /(?:^|[\s;])import\s+['"]([^'"]+)['"]/gu;
        while ((m = reBare.exec(stripped)) !== null) {
            out.push({spec: m[1], named: [], hasDefault: false, isNamespace: false});
        }

        // Dynamic / require / re-exports: spec-only, no symbol info.
        const reDyn = /(?:^|[\s({,=])import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
        while ((m = reDyn.exec(stripped)) !== null) {
            out.push({spec: m[1], named: [], hasDefault: false, isNamespace: false});
        }
        const reReq = /(?:^|[\s({,=])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
        while ((m = reReq.exec(stripped)) !== null) {
            out.push({spec: m[1], named: [], hasDefault: false, isNamespace: false});
        }
        const reReExport = /(?:^|[\s;])export\s+(?:\*|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/gu;
        while ((m = reReExport.exec(stripped)) !== null) {
            out.push({spec: m[1], named: [], hasDefault: false, isNamespace: false});
        }

        const reDynVar = /(?:^|[\s({,=])(?:import|require)\s*\(\s*[A-Za-z_$]/gu;
        let dynamicHits = 0;
        while (reDynVar.exec(stripped) !== null) {
            dynamicHits++;
        }

        return {imports: out, dynamicHits: dynamicHits};
    }

    /**
     * Parse the clause portion of `import <clause> from '...'`:
     *
     *   "X"                  → default
     *   "{A, B as C}"        → named [A, B]    (A and B are the *exported* names)
     *   "* as N"             → namespace
     *   "D, {A}"             → default + named [A]
     *   "type X" / "type {A}"→ same shapes, leading `type` stripped
     *
     * For "B as C": we only keep `B` because that's what the *source
     * module* exports under — the symbol the re-export map is keyed
     * on. `C` is just the local alias in the importing file.
     */
    private static _parseImportClause(raw: string): {
        named: string[]; hasDefault: boolean; isNamespace: boolean;
    } {
        let clause = raw.replace(/^type\s+/u, '').trim();
        const named: string[] = [];
        const namedMatch = clause.match(/\{([^}]+)\}/u);
        if (namedMatch) {
            for (const part of namedMatch[1].split(',')) {
                const idMatch = part.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)/u);
                if (idMatch) {
                    named.push(idMatch[1]);
                }
            }
            clause = clause.replace(/\{[^}]+\}/u, '').replace(/,\s*$/u, '').replace(/^\s*,/u, '').trim();
        }
        let isNamespace = false;
        let hasDefault = false;
        if (/\*\s+as\s+[A-Za-z_$]/u.test(clause)) {
            isNamespace = true;
        } else if (/^[A-Za-z_$][A-Za-z0-9_$]*\s*,?\s*$/u.test(clause)) {
            hasDefault = true;
        }
        return {named: named, hasDefault: hasDefault, isNamespace: isNamespace};
    }

    /**
     * Build the re-export map for one file: every `export {X} from
     * './sub';` adds an entry `X → './sub'`. `export * from './sub';`
     * adds the sentinel `'*' → './sub'` so the resolver knows to
     * recurse into wildcards. The map lets the workspace bridge
     * route an `import {X} from '@scope/pkg'` straight to the file
     * that actually defines `X`, not just the barrel that re-exports
     * it.
     */
    private static _scanReExports(content: string): Map<string, string[]> {
        const out = new Map<string, string[]>();
        const add = (sym: string, spec: string): void => {
            let arr = out.get(sym);
            if (!arr) {
                arr = [];
                out.set(sym, arr);
            }
            if (!arr.includes(spec)) {
                arr.push(spec);
            }
        };
        const stripped = SourceGraphBuilder._stripComments(content);

        // `export {A, B as C} from 'spec'` — re-exports A as A and B as C
        const reNamed = /(?:^|[\s;])export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gu;
        let m: RegExpExecArray|null;
        while ((m = reNamed.exec(stripped)) !== null) {
            const spec = m[2];
            for (const part of m[1].split(',')) {
                const t = part.trim();
                const aliasMatch = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/u);
                if (aliasMatch) {
                    add(aliasMatch[2], spec);
                    continue;
                }
                const idMatch = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/u);
                if (idMatch) {
                    add(idMatch[1], spec);
                }
            }
        }

        // `export * from 'spec'` — sentinel for "anything exported by spec"
        const reStar = /(?:^|[\s;])export\s+\*\s+from\s+['"]([^'"]+)['"]/gu;
        while ((m = reStar.exec(stripped)) !== null) {
            add('*', m[1]);
        }

        return out;
    }

    /**
     * Regex pass: ESM `import`, dynamic `import()`, CJS `require()`,
     * and `export … from`. Lifted from `UnusedDetector` so the two
     * scanners stay structurally identical.
     */
    private static _scanImports(content: string): {specs: string[]; dynamicHits: number;} {
        const specs: string[] = [];
        const stripped = content
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

        const reImport = /(?:^|[\s;])import(?:\s+(?:type\s+)?[^'"]*?from)?\s*['"]([^'"]+)['"]/gu;
        let m: RegExpExecArray|null;
        while ((m = reImport.exec(stripped)) !== null) {
            specs.push(m[1]);
        }

        const reDyn = /(?:^|[\s({,=])import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
        while ((m = reDyn.exec(stripped)) !== null) {
            specs.push(m[1]);
        }

        const reReq = /(?:^|[\s({,=])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
        while ((m = reReq.exec(stripped)) !== null) {
            specs.push(m[1]);
        }

        const reReExport = /(?:^|[\s;])export\s+(?:\*|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/gu;
        while ((m = reReExport.exec(stripped)) !== null) {
            specs.push(m[1]);
        }

        const reDynVar = /(?:^|[\s({,=])(?:import|require)\s*\(\s*[A-Za-z_$]/gu;
        let dynamicHits = 0;
        while (reDynVar.exec(stripped) !== null) {
            dynamicHits++;
        }

        return {specs: specs, dynamicHits: dynamicHits};
    }

    /**
     * Resolve a relative specifier (`./foo`, `../bar`) starting from
     * `fromDir`. Mirrors the node resolution rules we care about:
     *  1. Exact path with the spec's own extension.
     *  2. Spec + each of `RESOLVE_EXTENSIONS`.
     *  3. Spec as directory + `/index.<ext>`.
     * Returns the absolute path on success, `null` otherwise.
     *
     * TS-aware mapping: `./foo.js` in source-on-disk usually maps to
     * `./foo.ts` — the toolchain rewrites extensions at build time.
     * The .js → .ts fallback is the load-bearing case for TypeScript
     * projects with `--moduleResolution=NodeNext`.
     */
    private _resolve(fromDir: string, spec: string): string|null {
        const base = path.resolve(fromDir, spec);

        if (this._fileExists(base)) {
            return base;
        }

        for (const ext of RESOLVE_EXTENSIONS) {
            const candidate = `${base}${ext}`;
            if (this._fileExists(candidate)) {
                return candidate;
            }
        }

        /*
         * `./foo.js` → `./foo.ts` (and friends). Try stripping a
         * known JS-family extension, then re-appending each candidate.
         */
        const trailing = SourceGraphBuilder._fileExtension(base);
        if (['.js', '.jsx', '.mjs', '.cjs'].includes(trailing)) {
            const stripped = base.slice(0, -trailing.length);
            for (const ext of RESOLVE_EXTENSIONS) {
                const candidate = `${stripped}${ext}`;
                if (this._fileExists(candidate)) {
                    return candidate;
                }
            }
        }

        for (const ext of RESOLVE_EXTENSIONS) {
            const candidate = path.join(base, `index${ext}`);
            if (this._fileExists(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * Walk a barrel file's re-export table for the file that
     * actually defines `symbol`. The barrel only re-routes — it
     * doesn't store the implementation — so we keep following
     * `export {X} from './sub'` chains until we hit a file that
     * doesn't re-export `symbol` (= the definition lives there) or
     * we run out of leads. `visited` carries the cycle guard.
     */
    private _traceSymbol(
        fileAbs: string,
        symbol: string,
        reExportsByAbs: Map<string, Map<string, string[]>>,
        visited: Set<string>
    ): string|null {
        if (visited.has(fileAbs)) {
            return null;
        }
        visited.add(fileAbs);
        const here = path.dirname(fileAbs);
        const table = reExportsByAbs.get(fileAbs);
        if (!table) {
            return fileAbs;
        }
        for (const spec of table.get(symbol) ?? []) {
            const targetAbs = SourceGraphBuilder._isRelative(spec)
                ? this._resolve(here, spec)
                : null;
            if (!targetAbs) {
                continue;
            }
            const deeper = this._traceSymbol(targetAbs, symbol, reExportsByAbs, visited);
            if (deeper) {
                return deeper;
            }
        }
        for (const spec of table.get('*') ?? []) {
            const targetAbs = SourceGraphBuilder._isRelative(spec)
                ? this._resolve(here, spec)
                : null;
            if (!targetAbs) {
                continue;
            }
            const deeper = this._traceSymbol(targetAbs, symbol, reExportsByAbs, visited);
            if (deeper) {
                return deeper;
            }
        }
        return fileAbs;
    }

    /**
     * Bridge bare specifiers (`@scope/pkg`, `@scope/pkg/sub/x`) into
     * the workspace they actually point to. Without this hook,
     * monorepos render as visually disconnected clusters even though
     * one workspace imports another via its package name. The
     * longest-prefix match wins so `@scope/pkg-extras` beats
     * `@scope/pkg` on `@scope/pkg-extras/x`.
     *
     * Resolution rules:
     *  - Bare `@scope/pkg` → try the workspace's entry file (`main`
     *    field convention: `src/index.<ext>`, `index.<ext>`,
     *    `src/main.<ext>`, `main.<ext>`).
     *  - `@scope/pkg/sub/x` → resolve `sub/x` relative to the
     *    workspace root using the regular `_resolve` rules.
     *  - No match → `null` (caller treats it as an external dep).
     */
    private _resolveWorkspace(spec: string, workspaces: Map<string, string>): string|null {
        if (workspaces.size === 0) {
            return null;
        }
        let bestName: string|null = null;
        let bestSub: string = '';
        for (const name of workspaces.keys()) {
            if (spec === name) {
                if (bestName === null || name.length > bestName.length) {
                    bestName = name;
                    bestSub = '';
                }
                continue;
            }
            if (spec.startsWith(`${name}/`)) {
                if (bestName === null || name.length > bestName.length) {
                    bestName = name;
                    bestSub = spec.slice(name.length + 1);
                }
            }
        }
        if (bestName === null) {
            return null;
        }
        const wsRoot = workspaces.get(bestName)!;
        if (bestSub === '') {
            for (const sub of ['src/index', 'index', 'src/main', 'main']) {
                for (const ext of RESOLVE_EXTENSIONS) {
                    const candidate = path.join(wsRoot, `${sub}${ext}`);
                    if (this._fileExists(candidate)) {
                        return candidate;
                    }
                }
            }
            return null;
        }
        return this._resolve(wsRoot, `./${bestSub}`);
    }

    private _fileExists(p: string): boolean {
        if (!this._fs.existsSync(p)) {
            return false;
        }
        try {
            return this._fs.statSync(p).isFile();
        } catch {
            return false;
        }
    }

    private static _isRelative(spec: string): boolean {
        return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
    }

    /**
     * Classify a project-relative path so the renderer can colour it.
     * Test / config files come first because they often live deep in
     * `src/` and the "source" fallback would otherwise mask them.
     */
    private static _kindOf(rel: string): SourceFileKind {
        const lower = rel.toLowerCase();
        if (/(^|\/)__tests__\//u.test(lower) || /\.test\.[^/]+$/u.test(lower) || /\.spec\.[^/]+$/u.test(lower)) {
            return 'test';
        }
        if (/(^|\/)tests?\//u.test(lower)) {
            return 'test';
        }
        if (/\.config\.[^/]+$/u.test(lower) || /(^|\/)(vite|vitest|tsup|rollup|webpack|jest|playwright)\.config\.[^/]+$/u.test(lower)) {
            return 'config';
        }
        if (/^(main|index|cli)\.[^/]+$/u.test(lower) || /(^|\/)(main|index)\.[^/]+$/u.test(lower)) {
            return 'entry';
        }
        return 'source';
    }

    private static _countLines(content: string): number {
        if (content.length === 0) {
            return 0;
        }
        let n = 1;
        for (let i = 0; i < content.length; i++) {
            if (content.charCodeAt(i) === 10) {
                n++;
            }
        }
        return n;
    }

    private static _fileExtension(p: string): string {
        const dot = p.lastIndexOf('.');
        const sep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        if (dot < 0 || dot < sep) {
            return '';
        }
        return p.slice(dot).toLowerCase();
    }

}