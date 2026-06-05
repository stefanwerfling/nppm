import nodeFs from 'fs';
import {DependencyType, PackageManifest} from '../Project/PackageManifest.js';
import {Project} from '../Project/Project.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {
    MisplacedFinding,
    MissingFinding,
    ScanLimit,
    UnusedDepBucket,
    UnusedFinding,
    UnusedReport,
    UnusedSeverity
} from './UnusedReport.js';

/**
 * Filesystem dependencies the detector needs. Real callers pass
 * Node's built-in `fs`; tests pass an in-memory shim with the same
 * shape so the suite stays offline.
 */
export type UnusedFs = {
    existsSync: (p: string) => boolean;
    readdirSync: (p: string) => string[];
    readFileSync: (p: string, enc: 'utf-8') => string;
    statSync: (p: string) => {isDirectory: () => boolean; isFile: () => boolean;};
};

export type UnusedDetectorOptions = {
    /**
     * Package names that count as "used" even if no `import`/`require`
     * touches them. The default covers the well-known npm bin tools
     * that ship CLIs invoked from `scripts: {...}` (vite, vitest, tsx,
     * typescript, eslint, prettier, husky, …). Extend in `nppm.json`
     * for project-specific quirks.
     */
    allowlist?: string[];
    /**
     * Glob-style patterns (`**`, `*`, `?`) for paths that count as
     * "dev-only". A dep imported only from these files is reported as
     * `misplaced` (should be in `devDependencies`), not `unused`.
     */
    devPathGlobs?: string[];
};

/**
 * Source-file extensions we regex-scan. TypeScript JSX is included
 * (React projects); plain TSX/JSX without a TypeScript flavour falls
 * under `.jsx`/`.tsx`. We don't scan `.d.ts` (type-only) or `.json`
 * (config — handled via `scripts` whitelist).
 */
const SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'
]);

/**
 * Directories we never walk into. `node_modules` would dwarf the
 * scan; the others are build outputs / VCS metadata.
 */
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
    'coverage', '.nppm', '.nppm-cache', '.nppm-history', '.next', '.nuxt',
    '.cache', '.parcel-cache', '.turbo', '.vite'
]);

/**
 * Built-in default allowlist. These are the bin-tools that nearly
 * every npm project lists in `devDependencies` and runs from
 * `scripts: {...}` without ever `import`ing them from source. Without
 * this list, the detector would flag them as unused on almost every
 * project.
 */
const DEFAULT_ALLOWLIST: readonly string[] = [
    // bundlers / build tools
    'vite', 'webpack', 'webpack-cli', 'rollup', 'parcel', 'esbuild',
    'swc', '@swc/cli', 'tsup', 'turbo', 'biome', 'dprint',
    // compilers / runners
    'typescript', 'tsx', 'ts-node', 'ts-node-dev', 'tsc',
    // test runners
    'vitest', 'jest', 'mocha', 'ava', 'tap', 'c8', 'nyc',
    'playwright', '@playwright/test', 'cypress',
    // linters / formatters
    'eslint', 'prettier', 'stylelint',
    // git hooks / workflow
    'husky', 'lint-staged', 'commitlint', '@commitlint/cli',
    // process / env helpers
    'npm-run-all', 'concurrently', 'rimraf', 'cross-env', 'dotenv-cli',
    'nodemon', 'pm2',
    // doc / changelog
    'typedoc', 'changeset', '@changesets/cli'
];

const DEFAULT_DEV_PATH_GLOBS: readonly string[] = [
    '**/*.test.*',
    '**/*.spec.*',
    '**/tests/**',
    '**/__tests__/**',
    '**/vite.config.*',
    '**/vitest.config.*',
    '**/tsup.config.*',
    '**/rollup.config.*',
    '**/webpack.config.*',
    '**/jest.config.*',
    '**/playwright.config.*'
];

/**
 * Detects three classes of dependency-hygiene problem in a local
 * project:
 *
 *  - **unused**     — declared in package.json, no import/require in
 *                     source, not in `scripts: {...}`, not on the
 *                     allowlist. Almost certainly safe to remove.
 *  - **misplaced**  — only imported from dev paths (tests, configs)
 *                     but listed in `dependencies` instead of
 *                     `devDependencies`.
 *  - **missing**    — imported from source but not in any bucket.
 *                     Usually a transitive leak.
 *
 * Pure FS + regex: no AST parser, no network. Remote projects
 * (GitHub/Gitea) return `supported: false` because the contents-API
 * walk would explode the rate-limit budget for v1.
 */
export class UnusedDetector {

    private readonly _allowlist: ReadonlySet<string>;
    private readonly _devGlobs: readonly RegExp[];
    private readonly _fs: UnusedFs;

    constructor(opts: UnusedDetectorOptions = {}, fs?: UnusedFs) {
        /*
         * Allowlist: built-in defaults + user additions. Union, not
         * override — losing the bin-tool defaults would re-introduce
         * a wall of false positives.
         */
        this._allowlist = new Set([
            ...DEFAULT_ALLOWLIST,
            ...opts.allowlist ?? []
        ]);

        /*
         * Dev-path globs: user list *replaces* the default if non-
         * empty (otherwise an opinionated user couldn't shrink the
         * dev-path set), but is empty means "use defaults".
         */
        const globs = opts.devPathGlobs && opts.devPathGlobs.length > 0
            ? opts.devPathGlobs
            : DEFAULT_DEV_PATH_GLOBS;
        this._devGlobs = globs.map((g) => UnusedDetector._globToRegex(g));

        /*
         * Optional FS injection so the test suite stays offline /
         * off-disk. The production wiring leaves `fs` undefined and
         * we fall back to Node's built-in.
         */
        this._fs = fs ?? {
            existsSync: nodeFs.existsSync,
            readdirSync: (p: string) => nodeFs.readdirSync(p),
            readFileSync: (p: string, enc: 'utf-8') => nodeFs.readFileSync(p, enc),
            statSync: nodeFs.statSync
        };
    }

    public async scan(project: Project): Promise<UnusedReport> {
        const projectMeta = {
            unid: '',
            name: project.getName(),
            type: project.getType()
        };

        /*
         * Remote projects need a contents-API per-file fetch; that's
         * too expensive for v1. Return a sentinel report so the UI
         * can render "not supported here" instead of failing.
         */
        if (!(project instanceof ProjectLocal)) {
            return {
                project: projectMeta,
                supported: false,
                unsupportedReason: 'Remote projects (GitHub/Gitea) are not scanned in v1 — please check out locally.',
                unused: [],
                misplaced: [],
                missing: [],
                scanLimits: [],
                filesScanned: 0
            };
        }

        const root = project.getRoot();
        const manifests = await project.loadManifests();

        /*
         * Per-package collection across the whole project:
         *   importsByName.get(pkg) → array of source files that mention it
         */
        const importsByName = new Map<string, string[]>();
        const scanLimits: ScanLimit[] = [];
        let filesScanned = 0;

        /*
         * One pass over the file tree — same scan covers all
         * workspaces because workspaces all live under `root`.
         */
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
                const full = `${dir}/${entry}`;
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
                const ext = UnusedDetector._fileExtension(entry);
                if (!SOURCE_EXTENSIONS.has(ext)) {
                    continue;
                }

                filesScanned++;
                let content: string;
                try {
                    content = this._fs.readFileSync(full, 'utf-8');
                } catch {
                    continue;
                }

                const relPath = full.slice(root.length + 1);
                const {specs, dynamicHits} = UnusedDetector._scanImports(content);

                if (dynamicHits > 0) {
                    scanLimits.push({
                        file: relPath,
                        reason: `${dynamicHits} dynamic import()/require() — variable spec, not resolvable`
                    });
                }

                for (const spec of specs) {
                    const name = UnusedDetector._specToPackageName(spec);
                    if (!name) {
                        continue;
                    }
                    let list = importsByName.get(name);
                    if (!list) {
                        list = [];
                        importsByName.set(name, list);
                    }
                    list.push(relPath);
                }
            }
        };
        walk(root);

        /*
         * Union of declared deps across all workspaces. The detector
         * works against the *project as a whole*; a workspace-only
         * dep imported only in that workspace is still "used".
         */
        const declared = UnusedDetector._collectDeclared(manifests);

        /*
         * Workspace package names — these resolve to local source, not
         * to a node_modules install, so imports of them are not
         * "missing" even though they don't show up in deps.
         */
        const workspaceNames = new Set<string>();
        for (const m of manifests) {
            if (m.workspace !== undefined) {
                workspaceNames.add(m.name);
            }
        }

        /*
         * Names that appear inside `scripts: {...}` command bodies
         * (e.g. `"build": "tsc -p ."` → `tsc` counts as used).
         */
        const scriptHits = UnusedDetector._collectScriptHits(manifests, declared);

        const unused: UnusedFinding[] = [];
        const misplaced: MisplacedFinding[] = [];

        for (const [name, info] of declared.entries()) {
            const imports = importsByName.get(name) ?? [];
            const isAllowlisted = this._allowlist.has(name);
            const isInScripts = scriptHits.has(name);
            const isUsedByTypesConsumer = UnusedDetector._isTypesUsedTransitively(name, importsByName);

            // Bucket 1: zero imports at all.
            if (imports.length === 0) {
                if (isAllowlisted) {
                    unused.push({
                        name: name,
                        declaredIn: info.bucket,
                        severity: UnusedSeverity.info,
                        reason: 'On the allowlist (bin tool / build step) — not safe to remove'
                    });
                    continue;
                }
                if (isInScripts) {
                    unused.push({
                        name: name,
                        declaredIn: info.bucket,
                        severity: UnusedSeverity.info,
                        reason: 'Referenced in `scripts: {...}` — invoked via CLI'
                    });
                    continue;
                }
                if (isUsedByTypesConsumer) {
                    unused.push({
                        name: name,
                        declaredIn: info.bucket,
                        severity: UnusedSeverity.info,
                        reason: '`@types/X` package — implicitly used by consumer X'
                    });
                    continue;
                }
                unused.push({
                    name: name,
                    declaredIn: info.bucket,
                    severity: UnusedSeverity.risk,
                    reason: 'Not imported anywhere, not in `scripts:`, not on the allowlist'
                });
                continue;
            }

            /*
             * Bucket 2: imported, but only from dev-paths AND
             * declared as a regular dep.
             */
            if (info.bucket === 'dependency') {
                const allDev = imports.every((path) => this._isDevPath(path));
                if (allDev) {
                    misplaced.push({
                        name: name,
                        firstImport: imports[0]
                    });
                }
            }
        }

        /*
         * Missing deps: every name in importsByName that isn't
         * declared, isn't a workspace, and isn't a Node-builtin.
         */
        const missing: MissingFinding[] = [];
        for (const [name, paths] of importsByName.entries()) {
            if (declared.has(name)) {
                continue;
            }
            if (workspaceNames.has(name)) {
                continue;
            }
            if (UnusedDetector._isNodeBuiltin(name)) {
                continue;
            }
            missing.push({name: name, firstImport: paths[0]});
        }

        unused.sort((a, b) => a.name.localeCompare(b.name));
        misplaced.sort((a, b) => a.name.localeCompare(b.name));
        missing.sort((a, b) => a.name.localeCompare(b.name));

        return {
            project: projectMeta,
            supported: true,
            unused: unused,
            misplaced: misplaced,
            missing: missing,
            scanLimits: scanLimits,
            filesScanned: filesScanned
        };
    }

    /**
     * Regex pass over the file content. Returns the list of import
     * specifiers found (`'foo'`, `'@scope/foo/sub'`, `'./local'`)
     * plus a count of dynamic-spec patterns we couldn't resolve
     * (`import(name)` where `name` is a variable).
     */
    private static _scanImports(content: string): {specs: string[]; dynamicHits: number;} {
        const specs: string[] = [];

        /*
         * Strip line-comments and block-comments. Naive but adequate
         * — strings with `//` inside are rare enough that the
         * false-positive risk is lower than the false-negative risk
         * of e.g. an `// import 'foo'` line being counted as a real
         * import.
         */
        const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

        // ES module `import ... from 'name'` / bare `import 'name'`.
        const reImport = /(?:^|[\s;])import(?:\s+(?:type\s+)?[^'"]*?from)?\s*['"]([^'"]+)['"]/g;
        let m: RegExpExecArray|null;
        while ((m = reImport.exec(stripped)) !== null) {
            specs.push(m[1]);
        }

        // Dynamic `import('name')`.
        const reDyn = /(?:^|[\s({,=])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((m = reDyn.exec(stripped)) !== null) {
            specs.push(m[1]);
        }

        // CommonJS `require('name')`.
        const reReq = /(?:^|[\s({,=])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((m = reReq.exec(stripped)) !== null) {
            specs.push(m[1]);
        }

        // Re-export `export ... from 'name'` (ESM).
        const reReExport = /(?:^|[\s;])export\s+(?:\*|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/g;
        while ((m = reReExport.exec(stripped)) !== null) {
            specs.push(m[1]);
        }

        /*
         * Count dynamic specs we can't resolve. Best-effort
         * approximation; we don't need to extract anything, just
         * flag the file as partially scanned.
         */
        const reDynVar = /(?:^|[\s({,=])(?:import|require)\s*\(\s*[A-Za-z_$]/g;
        let dynamicHits = 0;
        while (reDynVar.exec(stripped) !== null) {
            dynamicHits++;
        }

        return {specs: specs, dynamicHits: dynamicHits};
    }

    /**
     * Turn an import specifier into the package name it would
     * resolve to. Relative / absolute paths return `null`. Scoped
     * names keep both segments (`@s/p/sub` → `@s/p`); bare names
     * drop the path tail (`p/sub` → `p`).
     */
    private static _specToPackageName(spec: string): string|null {
        if (spec.length === 0) {
            return null;
        }
        if (spec.startsWith('.') || spec.startsWith('/')) {
            return null;
        }
        // node: prefix → built-in, not an npm dep.
        if (spec.startsWith('node:')) {
            return null;
        }
        const parts = spec.split('/');
        if (spec.startsWith('@')) {
            return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
        }
        return parts[0];
    }

    /**
     * Walk every workspace's manifest and build a map
     *   name → { bucket }
     * with the most-restrictive bucket winning when the same name
     * appears in multiple workspaces. Order: dependency >
     * peerDependency > optionalDependency > devDependency. (Promoting
     * a devDependency to dependency is a tighter declaration, so it
     * wins.)
     */
    private static _collectDeclared(
        manifests: PackageManifest[]
    ): Map<string, {bucket: UnusedDepBucket;}> {
        const out = new Map<string, {bucket: UnusedDepBucket;}>();
        const rank: Record<UnusedDepBucket, number> = {
            dependency: 3,
            peerDependency: 2,
            optionalDependency: 1,
            devDependency: 0
        };
        for (const m of manifests) {
            for (const dep of m.dependencies) {
                const bucket = UnusedDetector._bucketOf(dep.type);
                const existing = out.get(dep.name);
                if (!existing || rank[bucket] > rank[existing.bucket]) {
                    out.set(dep.name, {bucket: bucket});
                }
            }
        }
        return out;
    }

    private static _bucketOf(t: DependencyType): UnusedDepBucket {
        switch (t) {
            case DependencyType.dependency: return 'dependency';
            case DependencyType.dev: return 'devDependency';
            case DependencyType.peer: return 'peerDependency';
            case DependencyType.optional: return 'optionalDependency';
        }
    }

    /**
     * Scan `scripts: {...}` bodies for tokens that match a declared
     * package name. Each script body is split on shell-meta chars
     * (space, pipe, &&, ||, ;, parens, redirects, backticks) and
     * every resulting token is checked against the declared names.
     *
     * Also handles a few well-known bin-aliases where the bin name
     * doesn't match the package name (`tsc` → `typescript`, `tsx` →
     * `tsx`, `nx` → `nx`, …) — only `tsc` is asymmetric in practice.
     */
    private static _collectScriptHits(
        manifests: PackageManifest[],
        declared: Map<string, {bucket: UnusedDepBucket;}>
    ): Set<string> {
        const hits = new Set<string>();

        const binAliases: Record<string, string> = {
            tsc: 'typescript',
            tsserver: 'typescript'
        };

        for (const m of manifests) {
            for (const body of Object.values(m.scripts)) {
                const tokens = body.split(/[\s|&;()`<>]+/);
                for (const token of tokens) {
                    if (token.length === 0) {
                        continue;
                    }
                    if (declared.has(token)) {
                        hits.add(token);
                    }
                    const aliased = binAliases[token];
                    if (aliased && declared.has(aliased)) {
                        hits.add(aliased);
                    }
                }
            }
        }
        return hits;
    }

    /**
     * Heuristic: `@types/foo` is "used" if `foo` is imported. Strips
     * the prefix and looks up — works for `@types/node` ↔ Node
     * builtins (already filtered), `@types/react` ↔ `react`, etc.
     */
    private static _isTypesUsedTransitively(
        name: string,
        importsByName: Map<string, string[]>
    ): boolean {
        if (!name.startsWith('@types/')) {
            return false;
        }
        const target = name.slice('@types/'.length);
        // Scoped: @types/babel__core ↔ @babel/core
        if (target.includes('__')) {
            const [scope, ...rest] = target.split('__');
            const scoped = `@${scope}/${rest.join('__')}`;
            return importsByName.has(scoped);
        }
        if (target === 'node') {
            return true;
        }
        return importsByName.has(target);
    }

    private static _isNodeBuiltin(name: string): boolean {
        /*
         * Common Node built-ins. `node:` prefix is already filtered
         * upstream; this catches bare names. Not exhaustive — false
         * negatives here surface as `missing` findings, which is the
         * safe direction.
         */
        const builtins = new Set([
            'fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util',
            'stream', 'buffer', 'child_process', 'events', 'querystring',
            'zlib', 'assert', 'cluster', 'dgram', 'dns', 'net', 'tls',
            'tty', 'readline', 'repl', 'vm', 'worker_threads',
            'perf_hooks', 'process', 'string_decoder', 'timers',
            'inspector', 'module', 'async_hooks', 'console', 'constants'
        ]);
        return builtins.has(name);
    }

    private _isDevPath(path: string): boolean {
        for (const re of this._devGlobs) {
            if (re.test(path)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Tiny glob → RegExp converter. Supports `**` (any depth incl.
     * none), `*` (any chars except `/`), `?` (single non-slash char).
     * Everything else is treated as a literal. Anchored at both
     * ends.
     */
    private static _globToRegex(glob: string): RegExp {
        let out = '^';
        let i = 0;
        while (i < glob.length) {
            const ch = glob[i];
            if (ch === '*' && glob[i + 1] === '*') {
                // `**` matches any path including empty
                out += '.*';
                i += 2;
                // skip a trailing slash so `**/foo` matches `foo`
                if (glob[i] === '/') {
                    i++;
                }
                continue;
            }
            if (ch === '*') {
                out += '[^/]*';
                i++;
                continue;
            }
            if (ch === '?') {
                out += '[^/]';
                i++;
                continue;
            }
            if ('.+^${}()|[]\\'.includes(ch)) {
                out += `\\${  ch}`;
            } else {
                out += ch;
            }
            i++;
        }
        out += '$';
        return new RegExp(out);
    }

    private static _fileExtension(path: string): string {
        const dot = path.lastIndexOf('.');
        return dot >= 0 ? path.slice(dot).toLowerCase() : '';
    }

}