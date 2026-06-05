import {JsonCache} from '../Cache/JsonCache.js';
import {OsvVulnerability} from '../Security/OsvClient.js';
import {Lockfile, LockedPackage} from '../Project/Lockfile.js';
import {Project} from '../Project/Project.js';
import {Registry} from '../Registry/Registry.js';

/**
 * Per-package status the UI colours nodes by.
 *  - `cve`:      OSV-cache reports at least one known vulnerability
 *  - `outdated`: registry has a newer `latest`
 *  - `aligned`:  on or above latest, no known CVEs
 *  - `unknown`:  registry has no info (and no CVEs cached either)
 */
export type DepGraphStatus = 'cve'|'outdated'|'aligned'|'unknown';

/**
 * One node in the flat dep-graph response. `deps` are already
 * resolved to concrete `name@version` keys the frontend can look up
 * in the `packages` map; that means an entry doesn't have to re-do
 * the npm hoisting walk client-side.
 *
 * `deps` may include a synthetic `null` entry when a declared
 * dependency couldn't be resolved (rare — usually means it's a
 * peer/optional that isn't actually installed). We keep it as `name`
 * with `version: ''` so the UI can still render a placeholder.
 */
export type DepGraphNode = {
    name: string;
    version: string;
    status: DepGraphStatus;
    vulnCount: number;
    latestVersion: string|null;
    deps: {name: string; version: string;}[];
};

export type DepGraphResponse = {
    project: {
        unid: string;
        name: string;
        type: string;
    };
    /** Top-level deps declared by the project root. Frontend uses this as the tree's root children. */
    rootDeps: {name: string; version: string;}[];
    /** All resolved packages, keyed by `<name>@<version>`. */
    packages: Record<string, DepGraphNode>;
    /**
     * `true` when the graph was synthesised from the project's
     * `package.json` because no lockfile was available — only the
     * declared top-level deps are present, transitive edges are
     * absent. Drives a notice in the DepTree view so users don't
     * mistake the shallow tree for "this project has no transitive
     * deps".
     */
    fromManifestOnly?: boolean;
};

/**
 * Flat-graph builder. Everything is static — the builder holds no
 * state; one call walks the lockfile + registry once per request.
 */
export class DepGraphBuilder {

    /**
     * Build a flat dependency graph from a project's lockfile. The
     * graph is delivered as a `Map<name@version, node>` rather than a
     * recursive tree because trees with thousands of nodes (kavula
     * has ~1700) explode in size — flat lookup keeps the response
     * under a megabyte even for the worst cases.
     *
     * Resolution: npm's hoisting algorithm. For a dep declared at
     * `node_modules/a/node_modules/b/package.json`, we walk path
     * segments from the dependent's path upward looking for
     * `node_modules/<dep>` until we hit the project root. First match
     * wins.
     *
     * Status:
     *  - reads the *single-query* OSV cache (`osv_<name>@<version>`)
     *    for vuln counts — no network call from inside this path
     *  - reads the registry cache for `latest`
     *  - everything stays best-effort: missing data = `unknown`
     */
    public static async build(
        projectUnid: string,
        project: Project,
        registry: Registry,
        osvCache: JsonCache
    ): Promise<DepGraphResponse|null> {
        const lockfile = await project.loadLockfile();
        if (!lockfile) {
            /*
             * No lockfile: fall back to the declared root manifest so
             * remote projects without a committed package-lock.json
             * (typical for browser extensions and many libraries)
             * still get a shallow first-level view instead of a 404.
             */
            return DepGraphBuilder._buildFromManifest(projectUnid, project, registry);
        }

        const byPath = new Map<string, LockedPackage>();
        for (const pkg of lockfile.packages) {
            byPath.set(pkg.path, pkg);
        }

        const resolveDep = (
            dependentPath: string,
            depName: string
        ): LockedPackage|null => {
            /*
             * Walk upward from the dependent's directory, looking for
             * `node_modules/<depName>` at each level — the same
             * algorithm npm uses at install time.
             */
            let cursor = dependentPath;
            while (true) {
                const probe = DepGraphBuilder._joinNodeModules(cursor, depName);
                const hit = byPath.get(probe);
                if (hit) {
                    return hit;
                }
                const parent = DepGraphBuilder._stripLastSegment(cursor);
                if (parent === cursor) {
                    return null; // already at the root
                }
                cursor = parent;
            }
        };

        /*
         * Pre-resolve a name→pkg map for top-level lookups (used by
         * root deps and by the upward walk when it bottoms out).
         */
        const topLevel = new Map<string, LockedPackage>();
        for (const pkg of lockfile.packages) {
            if (DepGraphBuilder._isTopLevelPath(pkg.path)) {
                topLevel.set(pkg.name, pkg);
            }
        }

        /*
         * For each lockfile package, build its `deps` array resolved
         * to concrete `name@version` keys.
         */
        const packages: Record<string, DepGraphNode> = {};

        for (const pkg of lockfile.packages) {
            const key = `${pkg.name}@${pkg.version}`;
            if (packages[key]) {
                /*
                 * Same `name@version` can appear multiple times
                 * (nested installs at different paths). Keep the
                 * first; deps are package-identity properties, not
                 * path-dependent.
                 */
                continue;
            }

            const resolvedDeps: {name: string; version: string;}[] = [];
            const allDeps = {...pkg.deps, ...pkg.peerDeps, ...pkg.optionalDeps};

            for (const depName of Object.keys(allDeps)) {
                const target = resolveDep(pkg.path, depName)
                    ?? topLevel.get(depName)
                    ?? null;
                if (target) {
                    resolvedDeps.push({name: target.name, version: target.version});
                } else {
                    /*
                     * Unresolved peer / optional / missing — record
                     * as a version-less placeholder so the UI can
                     * flag it.
                     */
                    resolvedDeps.push({name: depName, version: ''});
                }
            }

            const vulnCount = DepGraphBuilder._readVulnCount(osvCache, pkg.name, pkg.version);
            const regHit = await registry.fetchOne(pkg.name);
            const latest = regHit?.latest ?? null;

            packages[key] = {
                name: pkg.name,
                version: pkg.version,
                status: DepGraphBuilder._deriveStatus(pkg.version, latest, vulnCount),
                vulnCount: vulnCount,
                latestVersion: latest,
                deps: resolvedDeps
            };
        }

        /*
         * Root deps come from the project root manifest, not from
         * the lockfile (the lockfile's root entry only knows what was
         * at install time, but the manifest is the canonical "what
         * does the project declare").
         */
        const manifests = await project.loadManifests();
        const rootManifest = manifests.find((m) => m.workspace === undefined);
        const rootDeps: {name: string; version: string;}[] = [];

        if (rootManifest) {
            const seen = new Set<string>();
            for (const dep of rootManifest.dependencies) {
                if (seen.has(dep.name)) {
                    continue;
                }
                seen.add(dep.name);

                const target = topLevel.get(dep.name);
                if (target) {
                    rootDeps.push({name: target.name, version: target.version});
                } else {
                    rootDeps.push({name: dep.name, version: ''});
                }
            }
        }

        return {
            project: {
                unid: projectUnid,
                name: project.getName(),
                type: project.getType()
            },
            rootDeps: rootDeps,
            packages: packages
        };
    }

    /**
     * Manifest-only fallback. Walks the project root's declared deps,
     * looks up `latest` for each via the registry, and emits one node
     * per dep with an empty `deps[]` (no transitive resolution
     * available without a lockfile). Returns `null` when even the
     * root manifest is missing — that's a hard error worth surfacing
     * upstream as 404.
     */
    private static async _buildFromManifest(
        projectUnid: string,
        project: Project,
        registry: Registry
    ): Promise<DepGraphResponse|null> {
        let manifests;
        try {
            manifests = await project.loadManifests();
        } catch {
            return null;
        }
        const rootManifest = manifests.find((m) => m.workspace === undefined);
        if (!rootManifest) {
            return null;
        }

        const rootDeps: {name: string; version: string;}[] = [];
        const packages: Record<string, DepGraphNode> = {};
        const seen = new Set<string>();

        for (const dep of rootManifest.dependencies) {
            if (seen.has(dep.name)) {
                continue;
            }
            seen.add(dep.name);
            const declared = dep.version;
            rootDeps.push({name: dep.name, version: declared});

            const key = `${dep.name}@${declared}`;
            if (packages[key]) {
                continue;
            }
            const regHit = await registry.fetchOne(dep.name);
            const latest = regHit?.latest ?? null;
            /*
             * CVE lookup needs an exact installed version which the
             * manifest doesn't carry — leave at 0 / unknown so the
             * shallow view doesn't lie about safety.
             */
            packages[key] = {
                name: dep.name,
                version: declared,
                status: DepGraphBuilder._deriveStatus(declared, latest, 0),
                vulnCount: 0,
                latestVersion: latest,
                deps: []
            };
        }

        return {
            project: {
                unid: projectUnid,
                name: project.getName(),
                type: project.getType()
            },
            rootDeps: rootDeps,
            packages: packages,
            fromManifestOnly: true
        };
    }

    private static _isTopLevelPath(path: string): boolean {
        /*
         * `node_modules/foo` or `node_modules/@scope/foo` — no
         * further `node_modules/` segments.
         */
        const segments = path.split('/');
        let nm = 0;
        for (const s of segments) {
            if (s === 'node_modules') {
                nm++;
            }
        }
        return nm === 1;
    }

    private static _joinNodeModules(basePath: string, depName: string): string {
        /*
         * `basePath` is the dependent's path; we want the *directory*
         * it lives in plus `/node_modules/<depName>`. For
         * `node_modules/a/node_modules/b` that's
         * `node_modules/a/node_modules/<depName>`.
         */
        if (basePath === '') {
            return `node_modules/${depName}`;
        }
        return `${basePath}/node_modules/${depName}`;
    }

    private static _stripLastSegment(path: string): string {
        /*
         * `node_modules/a/node_modules/b` → `node_modules/a` so the
         * next upward probe lands at
         * `node_modules/a/node_modules/<dep>`. For a top-level
         * `node_modules/a` (or `@scope/a`), strip back to empty so
         * the next probe is `node_modules/<dep>` (i.e. hoisted).
         */
        const nmIdx = path.lastIndexOf('/node_modules/');
        if (nmIdx === -1) {
            return ''; // top-level — next walk hits the root
        }
        return path.slice(0, nmIdx);
    }

    private static _readVulnCount(cache: JsonCache, name: string, version: string): number {
        type Wrap = {data: OsvVulnerability[]|null;};
        const hit = cache.get<Wrap>(`osv_${name}@${version}`);
        if (!hit || hit.data === null) {
            return 0;
        }
        return hit.data.length;
    }

    private static _deriveStatus(current: string, latest: string|null, vulnCount: number): DepGraphStatus {
        if (vulnCount > 0) {
            return 'cve';
        }
        if (latest === null) {
            return 'unknown';
        }
        return current === latest ? 'aligned' : 'outdated';
    }

}