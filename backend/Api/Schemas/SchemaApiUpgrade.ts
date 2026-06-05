import {ExtractSchemaResultType, Vts} from 'vts';

/**
 * Body schema for `POST /api/projects/:id/upgrade/preview` and
 * `POST /api/projects/:id/upgrade/apply`. `workspace` is optional;
 * empty means the project root. `mode` is only meaningful on apply
 * (preview ignores it).
 */
export const SchemaApiUpgradeRequest = Vts.object({
    name: Vts.string(),
    depType: Vts.string(),
    fromRange: Vts.optional(Vts.string()),
    toRange: Vts.string(),
    workspace: Vts.optional(Vts.string()),
    mode: Vts.optional(Vts.string())
});

export type SchemaApiUpgradeRequestType = ExtractSchemaResultType<typeof SchemaApiUpgradeRequest>;

/**
 * Body schema for `POST /api/projects/:id/lifecycle-scripts/run`.
 * `name` is the node_modules child whose lifecycle hooks should
 * re-run; the handler shells out to `npm rebuild <name>` under the
 * project root.
 */
export const SchemaApiLifecycleRunRequest = Vts.object({
    name: Vts.string()
});

export type SchemaApiLifecycleRunRequestType = ExtractSchemaResultType<typeof SchemaApiLifecycleRunRequest>;