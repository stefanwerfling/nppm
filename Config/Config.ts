import {ExtractSchemaResultType, Vts} from 'vts';

/**
 * Project source kinds the config may declare. `local` reads a directory
 * on disk (with npm workspaces); `github` and `gitea` are scaffolded for
 * later phases and currently rejected by the loader.
 */
export enum ConfigProjectType {
    local = 'local',
    github = 'github',
    gitea = 'gitea'
}

/**
 * Local directory project — `path` is resolved against the nppm process
 * root.
 */
export const SchemaConfigProjectLocal = Vts.object({
    name: Vts.optional(Vts.string()),
    type: Vts.equal(ConfigProjectType.local),
    path: Vts.string()
});

/**
 * GitHub-hosted project — phase 3.
 */
export const SchemaConfigProjectGithub = Vts.object({
    name: Vts.optional(Vts.string()),
    type: Vts.equal(ConfigProjectType.github),
    repo: Vts.string(),
    ref: Vts.optional(Vts.string()),
    token: Vts.optional(Vts.string())
});

/**
 * Gitea-hosted project — phase 3.
 */
export const SchemaConfigProjectGitea = Vts.object({
    name: Vts.optional(Vts.string()),
    type: Vts.equal(ConfigProjectType.gitea),
    url: Vts.string(),
    ref: Vts.optional(Vts.string()),
    token: Vts.optional(Vts.string())
});

/**
 * One project entry — union over the supported source kinds.
 */
export const SchemaConfigProject = Vts.or([
    SchemaConfigProjectLocal,
    SchemaConfigProjectGithub,
    SchemaConfigProjectGitea
]);

export type ConfigProject = ExtractSchemaResultType<typeof SchemaConfigProject>;

export const SchemaConfigServer = Vts.object({
    port: Vts.optional(Vts.number()),
    limit: Vts.optional(Vts.string())
});

export const SchemaConfigBrowser = Vts.object({
    open: Vts.optional(Vts.boolean())
});

/**
 * Registry section — phase 2. Public npmjs.org by default; users with
 * private registries can point this at their own. `auth` is reserved
 * for the bearer token used against private registries.
 */
export const SchemaConfigRegistry = Vts.object({
    url: Vts.optional(Vts.string()),
    auth: Vts.optional(Vts.string())
});

/**
 * Disk cache settings. `dir` is resolved against the nppm process
 * root; missing TTL falls back to 60 minutes.
 */
export const SchemaConfigCache = Vts.object({
    dir: Vts.optional(Vts.string()),
    ttlMinutes: Vts.optional(Vts.number())
});

/**
 * Top-level nppm.json schema.
 */
export const SchemaConfig = Vts.object({
    projects: Vts.array(SchemaConfigProject),
    server: Vts.optional(SchemaConfigServer),
    browser: Vts.optional(SchemaConfigBrowser),
    registry: Vts.optional(SchemaConfigRegistry),
    cache: Vts.optional(SchemaConfigCache)
});

export type Config = ExtractSchemaResultType<typeof SchemaConfig>;