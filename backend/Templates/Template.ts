import {ExtractSchemaResultType, Vts} from 'vts';

/**
 * Per-package requirement inside a template's package bucket. `version`
 * is an npm range — if omitted, the entry only enforces "the package
 * must be present" (drift on version isn't reported). `required` flips
 * the missing-finding from `warn` to `risk`.
 */
export const SchemaTemplatePackageRequirement = Vts.object({
    version: Vts.optional(Vts.string()),
    required: Vts.optional(Vts.boolean())
});

export type TemplatePackageRequirement =
    ExtractSchemaResultType<typeof SchemaTemplatePackageRequirement>;

/**
 * The four npm dependency buckets a template can pin. Same names as
 * `DependencyType` enum values so the compliance checker can match
 * straight against `PackageDependency.type`.
 */
export const SchemaTemplatePackages = Vts.object({
    runtime: Vts.optional(Vts.object2(Vts.string(), SchemaTemplatePackageRequirement)),
    dev: Vts.optional(Vts.object2(Vts.string(), SchemaTemplatePackageRequirement)),
    peer: Vts.optional(Vts.object2(Vts.string(), SchemaTemplatePackageRequirement)),
    optional: Vts.optional(Vts.object2(Vts.string(), SchemaTemplatePackageRequirement))
});

export type TemplatePackages = ExtractSchemaResultType<typeof SchemaTemplatePackages>;

/**
 * Root-`package.json` metadata the template can pin. Each field is
 * checked independently — absent fields aren't enforced. `scripts` /
 * `engines` are key-value maps; the checker flags any key the template
 * declares that the project lacks or has set differently.
 */
export const SchemaTemplateRoot = Vts.object({
    engines: Vts.optional(Vts.object2(Vts.string(), Vts.string())),
    scripts: Vts.optional(Vts.object2(Vts.string(), Vts.string())),
    private: Vts.optional(Vts.boolean()),
    type: Vts.optional(Vts.string()),
    packageManager: Vts.optional(Vts.string())
});

export type TemplateRoot = ExtractSchemaResultType<typeof SchemaTemplateRoot>;

/**
 * One file the template ships at `nppm-templates/<id>/files/<path>`.
 * `path` is the project-relative target (e.g. `.eslintrc.json` or
 * `packages/api/tsconfig.json`); `mode` controls what the apply step
 * does:
 *
 *  - `create` — write only if the project doesn't have the file.
 *    Already-present files report drift (warn) but are never
 *    overwritten.
 *  - `report-only` — never write. Just surface drift as info.
 *  - `merge-json` — JSON shape-merge. Project must include every key
 *    the template declares; apply rewrites the project file with the
 *    deep-merged result. Non-JSON files in this mode degrade to
 *    `create`.
 */
export const SchemaTemplateFile = Vts.object({
    path: Vts.string(),
    mode: Vts.optional(Vts.string())
});

export type TemplateFile = ExtractSchemaResultType<typeof SchemaTemplateFile>;

export type TemplateFileMode = 'create'|'report-only'|'merge-json';

/**
 * One workspace contract the template enforces against the project's
 * workspaces (paths must match an entry in the project's `workspaces`
 * array). Same shape as the top-level contract minus `id`/`extends` —
 * a workspace can declare its own package buckets, forbidden list,
 * root metadata, and files relative to the workspace directory.
 */
export const SchemaTemplateWorkspace = Vts.object({
    path: Vts.string(),
    packages: Vts.optional(SchemaTemplatePackages),
    forbidden: Vts.optional(Vts.array(Vts.string())),
    root: Vts.optional(SchemaTemplateRoot),
    files: Vts.optional(Vts.array(SchemaTemplateFile))
});

export type TemplateWorkspace = ExtractSchemaResultType<typeof SchemaTemplateWorkspace>;

/**
 * Top-level template file shape. Phase-2: `files` + `workspaces` are
 * now fully wired; older templates without them still parse.
 */
export const SchemaTemplate = Vts.object({
    id: Vts.string(),
    name: Vts.optional(Vts.string()),
    extends: Vts.optional(Vts.array(Vts.string())),
    mode: Vts.optional(Vts.string()),
    packages: Vts.optional(SchemaTemplatePackages),
    forbidden: Vts.optional(Vts.array(Vts.string())),
    root: Vts.optional(SchemaTemplateRoot),
    files: Vts.optional(Vts.array(SchemaTemplateFile)),
    workspaces: Vts.optional(Vts.array(SchemaTemplateWorkspace))
});

export type Template = ExtractSchemaResultType<typeof SchemaTemplate>;

/**
 * One resolved file ship, with the source-disk path pre-resolved so
 * the apply / checker can read the bytes without re-deriving the
 * `nppm-templates/<id>/files/<path>` location every time.
 */
export type ResolvedTemplateFile = {
    path: string;
    mode: TemplateFileMode;
    /** Absolute path on disk where the template content lives. */
    sourcePath: string;
};

/**
 * One resolved workspace contract. Shape mirrors the top-level
 * contract minus `id` / `extends`. `sourceId` records the template
 * the workspace section came from (for ownership tooltips).
 */
export type ResolvedTemplateWorkspace = {
    path: string;
    sourceId: string;
    packages: {
        runtime: Record<string, TemplatePackageRequirement>;
        dev: Record<string, TemplatePackageRequirement>;
        peer: Record<string, TemplatePackageRequirement>;
        optional: Record<string, TemplatePackageRequirement>;
    };
    forbidden: string[];
    root: TemplateRoot;
    files: ResolvedTemplateFile[];
};

/**
 * Resolution outcome from `TemplateResolver` — what the checker
 * actually consumes. `extends` is gone (already flattened), `id`/`name`
 * carry through unchanged. `sourceIds` lists every template id whose
 * contribution survived the merge in order, so the UI can show
 * "Effective template = base ← node-modern ← backend-2026".
 */
export type ResolvedTemplate = {
    id: string;
    name: string;
    mode: 'additive'|'strict';
    packages: {
        runtime: Record<string, TemplatePackageRequirement>;
        dev: Record<string, TemplatePackageRequirement>;
        peer: Record<string, TemplatePackageRequirement>;
        optional: Record<string, TemplatePackageRequirement>;
    };
    forbidden: string[];
    root: Required<Pick<TemplateRoot, never>> & TemplateRoot;
    files: ResolvedTemplateFile[];
    workspaces: ResolvedTemplateWorkspace[];
    sourceIds: string[];
};

/**
 * One actionable item from a compliance run. `severity` is the unified
 * ladder the matrix badge collapses to (`info|warn|risk`); `kind` lets
 * the UI route to the right icon + label.
 */
export type ComplianceFindingKind =
    'missing'
    |'divergent'
    |'forbidden'
    |'extra'
    |'bucket-wrong'
    |'root-missing'
    |'root-divergent'
    |'file-missing'
    |'file-drift'
    |'workspace-missing';

export type ComplianceSeverity = 'info'|'warn'|'risk';

export type ComplianceFinding = {
    kind: ComplianceFindingKind;
    severity: ComplianceSeverity;
    /**
     * What the finding addresses. For package findings: `<bucket>:<name>`
     * (e.g. `runtime:express`). For root findings: `<group>.<key>`
     * (e.g. `engines.node`, `scripts.test`).
     */
    target: string;
    /**
     * Range / value as the template declares it. Absent when the
     * template doesn't pin one (the `missing-but-not-versioned` case).
     */
    expected?: string;
    /**
     * What the project actually has. Absent for `missing` /
     * `root-missing` (there's nothing to report).
     */
    actual?: string;
    /**
     * Which template in the merged chain owns this finding. Helps the
     * UI tooltip ("declared by `base`") so the user knows where to
     * change the rule.
     */
    sourceId: string;
};

/**
 * Compliance result for one project against its resolved template
 * chain. `templateIds` echoes the chain that was applied; `findings`
 * is the flat list (UI groups by `kind`/`severity`). `worst` is the
 * single severity badge for the cross-project matrix; `null` means
 * everything green.
 */
export type ComplianceReport = {
    templateIds: string[];
    findings: ComplianceFinding[];
    worst: ComplianceSeverity|null;
};