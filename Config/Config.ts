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
 * Maintainer-scanner tuning. All values are days. Defaults reflect the
 * empirical attack patterns (event-stream/ua-parser-js/coa had short
 * handover gaps; long silence + new publisher is *usually* a legitimate
 * community takeover of an abandoned package). Override per project
 * when you know better — e.g. a security-sensitive monorepo may want
 * `quickHandoverDays: 90` to also flag medium-length handovers as risk.
 *
 *  - `quickHandoverDays`  → ≤ this gap on a mature package = risk
 *  - `suspiciousGapDays`  → ≤ this gap (but > quickHandover) = warn
 *  - anything above is treated as a community takeover (info + note)
 *  - `matureVersions`     → minimum predecessor count for risk/warn;
 *                           young packages always soften to warn/info
 *  - `trustWindow`        → number of recent versions inspected for the
 *                           trust set
 */
export const SchemaConfigSecurityMaintainer = Vts.object({
    quickHandoverDays: Vts.optional(Vts.number()),
    suspiciousGapDays: Vts.optional(Vts.number()),
    matureVersions: Vts.optional(Vts.number()),
    trustWindow: Vts.optional(Vts.number())
});

/**
 * License-scanner policy. Defaults to the SPDX-built-in classification
 * (no allow/deny, unknowns stay unknown). Compliance-strict teams can:
 *  - widen `allowlist` to e.g. `["MIT", "Apache-2.0", "BSD-*", "ISC"]`
 *    to force everything else into the non-permissive buckets,
 *  - tighten `denylist` to e.g. `["AGPL-*", "GPL-3.0-only"]` to mark
 *    those as proprietary even if they appear inside an OR-expression,
 *  - set `treatUnknownAs` to `"proprietary"` so any package without a
 *    recognised license forces a manual review.
 *
 * Patterns support a trailing `*` wildcard (`BSD-*` matches every
 * BSD-* SPDX id) and exact matches; case sensitive (SPDX convention).
 */
export const SchemaConfigSecurityLicense = Vts.object({
    allowlist: Vts.optional(Vts.array(Vts.string())),
    denylist: Vts.optional(Vts.array(Vts.string())),
    treatUnknownAs: Vts.optional(Vts.string())
});

/**
 * Unused-deps detector policy. `allowlist` is *union*ed with the
 * built-in default (vite/tsx/eslint/…), so users only need to add
 * project-specific bin-tools. `devPathGlobs` *replaces* the default
 * when non-empty so opinionated teams can shrink the dev-path set.
 */
export const SchemaConfigSecurityUnused = Vts.object({
    allowlist: Vts.optional(Vts.array(Vts.string())),
    devPathGlobs: Vts.optional(Vts.array(Vts.string()))
});

export const SchemaConfigSecurity = Vts.object({
    maintainer: Vts.optional(SchemaConfigSecurityMaintainer),
    license: Vts.optional(SchemaConfigSecurityLicense),
    unused: Vts.optional(SchemaConfigSecurityUnused)
});

/**
 * Top-level nppm.json schema.
 */
export const SchemaConfig = Vts.object({
    projects: Vts.array(SchemaConfigProject),
    server: Vts.optional(SchemaConfigServer),
    browser: Vts.optional(SchemaConfigBrowser),
    registry: Vts.optional(SchemaConfigRegistry),
    cache: Vts.optional(SchemaConfigCache),
    security: Vts.optional(SchemaConfigSecurity)
});

export type Config = ExtractSchemaResultType<typeof SchemaConfig>;