import {ExtractSchemaResultType, Vts} from 'vts';

/**
 * Body schema for `POST /api/templates/sources`. Single key, but
 * lifted into a schema for consistency with the rest of the API
 * surface and so the URL-shape check sits in one place.
 */
export const SchemaApiAddTemplateSource = Vts.object({
    url: Vts.string()
});

export type SchemaApiAddTemplateSourceType = ExtractSchemaResultType<typeof SchemaApiAddTemplateSource>;

/**
 * Body schema for `POST /api/projects/:id/compliance/apply`. `targets`
 * is the subset of finding target-strings the user ticked in the
 * Apply modal — each one is matched against the freshly-checked
 * compliance report at apply time.
 */
export const SchemaApiComplianceApply = Vts.object({
    targets: Vts.array(Vts.string())
});

export type SchemaApiComplianceApplyType = ExtractSchemaResultType<typeof SchemaApiComplianceApply>;