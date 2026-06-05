import path from 'path';
import {
    ResolvedTemplate,
    ResolvedTemplateFile,
    ResolvedTemplateWorkspace,
    Template,
    TemplateFile,
    TemplateFileMode,
    TemplatePackageRequirement,
    TemplateRoot,
    TemplateWorkspace
} from './Template.js';

/**
 * Where the per-template `files/` source content lives. The resolver
 * needs this to pre-fill `ResolvedTemplateFile.sourcePath` so callers
 * can read the file content without re-walking the catalogue layout.
 */
export type TemplateSourceResolver = (templateId: string) => string;

/**
 * Flatten a chain of templates into a single `ResolvedTemplate`. Two
 * separate kinds of "chain" feed in here:
 *
 *  1. The `extends` graph of a single template — `backend-2026
 *     extends ["base", "node-modern"]` resolves to
 *     `[base..., node-modern..., backend-2026]` (depth-first, later
 *     wins on conflicts).
 *
 *  2. The per-project list — a project says `templates: ["base",
 *     "backend-2026"]`, and the resolver concatenates each fully-
 *     flattened template chain so later projects-list entries win
 *     over earlier ones.
 *
 * Conflicts: per-bucket packages, root keys, `mode`, and `forbidden`
 * all use last-writer-wins (`forbidden` accumulates as a union, not
 * a replace, because removing a forbidden entry is a deliberate
 * decision the user can make in the leaf template by *not declaring*
 * it — the union still allows it to be added back). Cycles raise.
 */
export class TemplateResolver {

    private readonly _catalogue: Map<string, Template>;
    private readonly _filesDirFor: TemplateSourceResolver;

    constructor(catalogue: Map<string, Template>, filesDirFor?: TemplateSourceResolver) {
        this._catalogue = catalogue;
        // Default resolver maps `<id>` → `nppm-templates/<id>/files`
        // relative to wherever the tests instantiate from. The
        // backend overrides this via the second arg with the on-disk
        // path computed from `templateLoader.getFilesDir(id)`.
        this._filesDirFor = filesDirFor ?? ((id) => path.join('nppm-templates', id, 'files'));
    }

    /**
     * Resolve one or more template ids against the catalogue and
     * return a fully merged `ResolvedTemplate`. Unknown ids raise so
     * the caller can surface "template not found in catalogue" to the
     * user instead of silently dropping the rule set.
     */
    public resolve(ids: string[]): ResolvedTemplate {
        if (ids.length === 0) {
            return TemplateResolver._empty();
        }
        const seen = new Set<string>();
        const flatChain: Template[] = [];
        for (const id of ids) {
            this._flatten(id, flatChain, seen, new Set<string>());
        }
        return this._merge(flatChain);
    }

    private _flatten(
        id: string,
        out: Template[],
        seen: Set<string>,
        visiting: Set<string>
    ): void {
        if (seen.has(id)) {
            return;
        }
        if (visiting.has(id)) {
            throw new Error(`cycle in template extends: ${[...visiting, id].join(' -> ')}`);
        }
        const tpl = this._catalogue.get(id);
        if (!tpl) {
            throw new Error(`unknown template "${id}"`);
        }
        visiting.add(id);
        for (const parent of tpl.extends ?? []) {
            this._flatten(parent, out, seen, visiting);
        }
        visiting.delete(id);
        seen.add(id);
        out.push(tpl);
    }

    private _merge(chain: Template[]): ResolvedTemplate {
        const out: ResolvedTemplate = {
            id: chain.length === 1 ? chain[0].id : chain[chain.length - 1].id,
            name: chain[chain.length - 1].name ?? chain[chain.length - 1].id,
            mode: 'additive',
            packages: {runtime: {}, dev: {}, peer: {}, optional: {}},
            forbidden: [],
            root: {},
            files: [],
            workspaces: [],
            sourceIds: chain.map((t) => t.id)
        };
        const forbidden = new Set<string>();
        const filesByPath = new Map<string, ResolvedTemplateFile>();
        const workspacesByPath = new Map<string, ResolvedTemplateWorkspace>();
        for (const t of chain) {
            if (t.mode === 'strict' || t.mode === 'additive') {
                out.mode = t.mode;
            }
            const pkgs = t.packages;
            if (pkgs) {
                TemplateResolver._mergeBucket(out.packages.runtime, pkgs.runtime);
                TemplateResolver._mergeBucket(out.packages.dev, pkgs.dev);
                TemplateResolver._mergeBucket(out.packages.peer, pkgs.peer);
                TemplateResolver._mergeBucket(out.packages.optional, pkgs.optional);
            }
            for (const name of t.forbidden ?? []) {
                forbidden.add(name);
            }
            if (t.root) {
                TemplateResolver._mergeRoot(out.root, t.root);
            }
            for (const f of t.files ?? []) {
                filesByPath.set(f.path, this._resolveFile(t.id, f));
            }
            for (const ws of t.workspaces ?? []) {
                const existing = workspacesByPath.get(ws.path);
                workspacesByPath.set(ws.path, this._mergeWorkspace(existing, ws, t.id));
            }
        }
        out.forbidden = [...forbidden].sort();
        out.files = [...filesByPath.values()];
        out.workspaces = [...workspacesByPath.values()];
        return out;
    }

    private _resolveFile(templateId: string, file: TemplateFile): ResolvedTemplateFile {
        return {
            path: file.path,
            mode: TemplateResolver._normalizeFileMode(file.mode),
            sourcePath: path.join(this._filesDirFor(templateId), file.path)
        };
    }

    private _mergeWorkspace(
        existing: ResolvedTemplateWorkspace|undefined,
        from: TemplateWorkspace,
        sourceId: string
    ): ResolvedTemplateWorkspace {
        const base: ResolvedTemplateWorkspace = existing ?? {
            path: from.path,
            sourceId,
            packages: {runtime: {}, dev: {}, peer: {}, optional: {}},
            forbidden: [],
            root: {},
            files: []
        };
        if (from.packages) {
            TemplateResolver._mergeBucket(base.packages.runtime, from.packages.runtime);
            TemplateResolver._mergeBucket(base.packages.dev, from.packages.dev);
            TemplateResolver._mergeBucket(base.packages.peer, from.packages.peer);
            TemplateResolver._mergeBucket(base.packages.optional, from.packages.optional);
        }
        if (from.forbidden && from.forbidden.length > 0) {
            const u = new Set(base.forbidden);
            for (const n of from.forbidden) {
                u.add(n);
            }
            base.forbidden = [...u].sort();
        }
        if (from.root) {
            TemplateResolver._mergeRoot(base.root, from.root);
        }
        if (from.files) {
            // Workspace files share the per-template `files/` directory
            // — paths are workspace-relative but stored under the
            // template's source folder using the workspace path as a
            // sub-folder. The applier joins them with the project's
            // workspace root.
            const filesByPath = new Map<string, ResolvedTemplateFile>(
                base.files.map((f) => [f.path, f])
            );
            for (const f of from.files) {
                filesByPath.set(f.path, {
                    path: f.path,
                    mode: TemplateResolver._normalizeFileMode(f.mode),
                    sourcePath: path.join(
                        this._filesDirFor(sourceId),
                        from.path,
                        f.path
                    )
                });
            }
            base.files = [...filesByPath.values()];
        }
        // Track the template that last touched this workspace —
        // ownership reported in the UI tooltip.
        base.sourceId = sourceId;
        return base;
    }

    private static _normalizeFileMode(raw: string|undefined): TemplateFileMode {
        if (raw === 'create' || raw === 'merge-json' || raw === 'report-only') {
            return raw;
        }
        return 'create';
    }

    private static _mergeBucket(
        into: Record<string, TemplatePackageRequirement>,
        from: Record<string, TemplatePackageRequirement>|undefined
    ): void {
        if (!from) {
            return;
        }
        for (const [name, req] of Object.entries(from)) {
            into[name] = {...into[name], ...req};
        }
    }

    private static _mergeRoot(into: TemplateRoot, from: TemplateRoot): void {
        if (from.engines) {
            into.engines = {...(into.engines ?? {}), ...from.engines};
        }
        if (from.scripts) {
            into.scripts = {...(into.scripts ?? {}), ...from.scripts};
        }
        if (from.private !== undefined) {
            into.private = from.private;
        }
        if (from.type !== undefined) {
            into.type = from.type;
        }
        if (from.packageManager !== undefined) {
            into.packageManager = from.packageManager;
        }
    }

    private static _empty(): ResolvedTemplate {
        return {
            id: '',
            name: '',
            mode: 'additive',
            packages: {runtime: {}, dev: {}, peer: {}, optional: {}},
            forbidden: [],
            root: {},
            files: [],
            workspaces: [],
            sourceIds: []
        };
    }
}