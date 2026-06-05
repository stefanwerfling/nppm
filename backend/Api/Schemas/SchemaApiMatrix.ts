import {ExtractSchemaResultType, Vts} from 'vts';

/**
 * Shared body shape for the three batched matrix-badge lookups:
 *   - POST /api/matrix/security    (OSV vuln-id batch)
 *   - POST /api/matrix/heuristics  (lifecycle scripts + code patterns)
 *   - POST /api/matrix/bundles     (bundlephobia size + dep count)
 *
 * All three accept `{packages: [{name, version}]}` and return one
 * result per coordinate. Keeping the schema shared avoids three
 * identical declarations.
 */
export const SchemaApiMatrixBatchRequest = Vts.object({
    packages: Vts.array(Vts.object({
        name: Vts.string(),
        version: Vts.string()
    }))
});

export type SchemaApiMatrixBatchRequestType = ExtractSchemaResultType<typeof SchemaApiMatrixBatchRequest>;

/**
 * One row from the Bulk-Upgrade Wizard — covers both preview and
 * apply. `workspace` is optional (empty = project root). `depType`
 * stays `Vts.string()` to mirror the per-project upgrade schema; the
 * route handlers narrow via `PackageJsonEditor` on the live manifest.
 */
export const SchemaApiBulkUpgradePick = Vts.object({
    projectUnid: Vts.string(),
    workspace: Vts.optional(Vts.string()),
    name: Vts.string(),
    depType: Vts.string(),
    fromRange: Vts.string(),
    toRange: Vts.string()
});

/**
 * Body schema for `POST /api/matrix/upgrade/preview` and
 * `POST /api/matrix/upgrade/apply`. The apply variant adds an
 * optional `mode` field; the preview ignores it.
 */
export const SchemaApiBulkUpgradeRequest = Vts.object({
    picks: Vts.array(SchemaApiBulkUpgradePick),
    mode: Vts.optional(Vts.string())
});

export type SchemaApiBulkUpgradeRequestType = ExtractSchemaResultType<typeof SchemaApiBulkUpgradeRequest>;