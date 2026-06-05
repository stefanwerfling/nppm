/**
 * Dependency kinds tracked across all sources. `dependency` = `dependencies`,
 * `dev` = `devDependencies`, `peer` = `peerDependencies`, `optional` =
 * `optionalDependencies`. The matrix view groups/filters on this.
 */
export enum DependencyType {
    dependency = 'dependency',
    dev = 'dev',
    peer = 'peer',
    optional = 'optional'
}

/**
 * One row of `<dep-name, version-range>` enriched with metadata about
 * which manifest declared it and as what kind of dependency. A single
 * package can appear multiple times if e.g. a workspace pins a different
 * range than the root.
 */
export type PackageDependency = {
    name: string;
    version: string;
    type: DependencyType;
    workspace?: string;
};

/**
 * Parsed package.json for a single workspace (or the root). The
 * `workspace` field is undefined for the root manifest and otherwise
 * holds the relative path inside the project (e.g. `packages/api`).
 */
export type PackageManifest = {
    name: string;
    version: string;
    workspace?: string;
    dependencies: PackageDependency[];
    /**
     * Raw `scripts: {...}` map from the package.json (npm-run-script
     * commands). Populated by the project loaders so the
     * `UnusedDetector` can mark deps referenced from script bodies
     * (e.g. `"build": "vite build"` → `vite` counts as used) without
     * a second filesystem read. Empty for projects that don't declare
     * any scripts.
     */
    scripts: Record<string, string>;
    /**
     * Root-`package.json` metadata fields the Templates compliance
     * checker enforces against. Only the root manifest (workspace =
     * undefined) typically populates these; per-workspace package.json
     * may also set them — the checker only inspects the root.
     */
    engines?: Record<string, string>;
    /**
     * `private: true|false` flag from package.json. Undefined when
     * the package.json omits it entirely.
     */
    isPrivate?: boolean;
    /**
     * `"type"` field (`"module"` / `"commonjs"`). Undefined when
     * absent.
     */
    moduleType?: string;
    /**
     * `"packageManager"` field (e.g. `"npm@10.5.0"`). Undefined when
     * absent.
     */
    packageManager?: string;
};