import {ExtractSchemaResultType, Vts} from 'vts';
import {ConfigProjectType} from '../../Config/Config.js';

/*
 * Body shapes for POST /api/projects and PUT /api/projects/:id. The
 * wire-level union is discriminated by `type`; per-variant required
 * fields (path / repo / url) are enforced here, soft fields (name,
 * hidden, templates) sit on every variant. Fields belonging to
 * other variants are tolerated and ignored — the frontend's edit
 * modal keeps every field in its form regardless of the active type.
 */
const _COMMON = {
    name: Vts.optional(Vts.string()),
    hidden: Vts.optional(Vts.boolean()),
    templates: Vts.optional(Vts.array(Vts.string()))
};

const _TOLERATED = {
    /*
     * Allow-but-ignore: keys that belong to other variants of the
     * union show up here when the frontend submits a form with all
     * inputs still rendered. Marking them optional prevents the
     * validator from rejecting the body just because the user
     * filled a "url" in once for gitea and now switched to local.
     */
    path: Vts.optional(Vts.string()),
    repo: Vts.optional(Vts.string()),
    url: Vts.optional(Vts.string()),
    ref: Vts.optional(Vts.string()),
    token: Vts.optional(Vts.string())
};

export const SchemaApiProjectMutationLocal = Vts.object({
    type: Vts.equal(ConfigProjectType.local),
    path: Vts.string(),
    ..._COMMON,
    repo: _TOLERATED.repo,
    url: _TOLERATED.url,
    ref: _TOLERATED.ref,
    token: _TOLERATED.token
});

export const SchemaApiProjectMutationGithub = Vts.object({
    type: Vts.equal(ConfigProjectType.github),
    repo: Vts.string(),
    ..._COMMON,
    path: _TOLERATED.path,
    url: _TOLERATED.url,
    ref: Vts.optional(Vts.string()),
    token: Vts.optional(Vts.string())
});

export const SchemaApiProjectMutationGitea = Vts.object({
    type: Vts.equal(ConfigProjectType.gitea),
    url: Vts.string(),
    ..._COMMON,
    path: _TOLERATED.path,
    repo: _TOLERATED.repo,
    ref: Vts.optional(Vts.string()),
    token: Vts.optional(Vts.string())
});

export const SchemaApiProjectMutation = Vts.or([
    SchemaApiProjectMutationLocal,
    SchemaApiProjectMutationGithub,
    SchemaApiProjectMutationGitea
]);

export type SchemaApiProjectMutationType = ExtractSchemaResultType<typeof SchemaApiProjectMutation>;

/**
 * Body schema for `PATCH /api/projects/:id/visibility`. Trivial,
 * single-key — but lifted into a schema for consistency with the rest
 * of the API surface.
 */
export const SchemaApiProjectVisibility = Vts.object({
    hidden: Vts.boolean()
});

export type SchemaApiProjectVisibilityType = ExtractSchemaResultType<typeof SchemaApiProjectVisibility>;