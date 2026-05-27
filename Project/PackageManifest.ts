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
};