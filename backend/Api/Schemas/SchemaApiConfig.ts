import {ExtractSchemaResultType, Vts} from 'vts';
import {
    SchemaConfigActions,
    SchemaConfigBrowser,
    SchemaConfigCache,
    SchemaConfigRegistry,
    SchemaConfigSecurity,
    SchemaConfigServer,
    SchemaConfigUi
} from '../../Config/Config.js';

/**
 * Body schema for `PUT /api/config`. Mirrors `ApiConfigSettings` in the
 * shared wire types — every section is optional so the frontend can
 * patch any subset without having to round-trip the unchanged
 * sections. Re-uses the sub-schemas from `Config.ts` so the wire
 * accepts exactly what `nppm.json` accepts at boot.
 *
 * The `projects` array is intentionally absent — projects are managed
 * by `/api/projects` routes; this body cannot touch them.
 */
export const SchemaApiConfigMutation = Vts.object({
    server: Vts.optional(SchemaConfigServer),
    browser: Vts.optional(SchemaConfigBrowser),
    registry: Vts.optional(SchemaConfigRegistry),
    cache: Vts.optional(SchemaConfigCache),
    security: Vts.optional(SchemaConfigSecurity),
    actions: Vts.optional(SchemaConfigActions),
    ui: Vts.optional(SchemaConfigUi)
});

export type SchemaApiConfigMutationType = ExtractSchemaResultType<typeof SchemaApiConfigMutation>;