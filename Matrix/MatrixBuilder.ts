import {ConfigProjectType} from '../Config/Config.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {LockfileReader} from '../Project/Lockfile.js';
import {PackageManifest, DependencyType} from '../Project/PackageManifest.js';
import {Project} from '../Project/Project.js';
import {Registry} from '../Registry/Registry.js';

/**
 * Row-level status the frontend colours on.
 *  - aligned: every project that has the package uses the same version
 *             range AND it resolves to the registry's `latest`
 *  - outdated: every project agrees, but registry has a newer latest
 *  - drift: at least two projects disagree on the version range
 *  - unknown: registry lookup failed and there is no internal drift
 */
export enum MatrixRowStatus {
    aligned = 'aligned',
    outdated = 'outdated',
    drift = 'drift',
    unknown = 'unknown'
}

/**
 * One package's appearance in one project. `internalDrift` is `true`
 * when the project's own workspaces declared different version ranges
 * for the same dependency — that gets a small badge in the cell so
 * the user knows the column-level summary glosses over an
 * inconsistency.
 */
export type MatrixCell = {
    version: string;
    types: DependencyType[];
    internalDrift: boolean;
    /**
     * Concrete version pulled from the project's lockfile. Only set
     * when `version` is a git URL — gives the UI something humanly
     * readable to show next to the raw URL.
     */
    installedVersion?: string;
};

export type MatrixRow = {
    name: string;
    cells: Record<string, MatrixCell>;
    latest: string|null;
    latestPublishedAt: string|null;
    status: MatrixRowStatus;
};

export type MatrixProject = {
    unid: string;
    name: string;
    type: ConfigProjectType;
    error?: string;
};

export type MatrixResponse = {
    projects: MatrixProject[];
    rows: MatrixRow[];
};

/**
 * Cross-project matrix assembly. All methods are static — the builder
 * holds no state; it just walks projects + registry once per request.
 */
export class MatrixBuilder {

    /**
     * Strip range modifiers (`^`, `~`, `>=`, `=`, leading `v`,
     * whitespace) so we can compare an installed range against
     * `latest`. Deliberately lossy: caret/tilde widening collapses to
     * "same". A user wanting strict equality pins exact versions
     * anyway.
     */
    public static cleanRange(range: string): string {
        return range
            .trim()
            .replace(/^[\^~=v]+/, '')
            .replace(/^>=\s*/, '')
            .split(/\s/)[0];
    }

    /**
     * Status decision parameterised over plain version strings so the
     * per-project view can reuse it without forging fake `MatrixCell`
     * shapes (those carry an `internalDrift` flag that doesn't apply
     * when workspaces are *not* collapsed).
     */
    public static computeStatusFromVersions(
        versions: string[],
        latest: string|null
    ): MatrixRowStatus {
        const cleaned = new Set<string>();
        for (const v of versions) {
            cleaned.add(MatrixBuilder.cleanRange(v));
        }

        if (cleaned.size > 1) {
            return MatrixRowStatus.drift;
        }

        if (latest === null) {
            return MatrixRowStatus.unknown;
        }

        const single = cleaned.values().next().value;
        if (single === undefined) {
            return MatrixRowStatus.unknown;
        }

        return single === MatrixBuilder.cleanRange(latest)
            ? MatrixRowStatus.aligned
            : MatrixRowStatus.outdated;
    }

    /**
     * Top-level builder: load each project's manifests, fold them
     * into per-project cells, union the package names, ask the
     * registry for `latest` of every name in one batch, then assemble
     * the response.
     */
    public static async build(
        registeredProjects: Map<string, Project>,
        registry: Registry
    ): Promise<MatrixResponse> {
        const projects: MatrixProject[] = [];
        const perProjectCells = new Map<string, Map<string, MatrixCell>>();
        const allPackageNames = new Set<string>();

        for (const [unid, project] of registeredProjects.entries()) {
            // Hidden projects skip the cross-project matrix entirely
            // — they're still in the treeview and have working per-
            // project routes, but they don't pollute the matrix
            // columns or pull registry metadata that nobody asked
            // about.
            if (project.isHidden()) {
                continue;
            }
            const meta: MatrixProject = {
                unid,
                name: project.getName(),
                type: project.getType()
            };

            try {
                const manifests = await project.loadManifests();
                const cells = MatrixBuilder._buildProjectCells(manifests);

                // Pull a `name → installed version` map from the
                // project's lockfile so cells that pin a git URL can
                // surface the concrete version next to it.
                // Best-effort — lockfile failures don't block the
                // matrix.
                try {
                    const lockfile = await project.loadLockfile();
                    if (lockfile) {
                        const installed = LockfileReader.topLevelVersionMap(lockfile);
                        for (const [name, cell] of cells) {
                            if (GitResolver.isGitVersion(cell.version)) {
                                const v = installed.get(name);
                                if (v) {
                                    cell.installedVersion = v;
                                }
                            }
                        }
                    }
                } catch {
                    // best-effort; matrix still renders without
                }

                perProjectCells.set(unid, cells);

                for (const name of cells.keys()) {
                    allPackageNames.add(name);
                }
            } catch (e) {
                meta.error = (e as Error).message;
                perProjectCells.set(unid, new Map());
            }

            projects.push(meta);
        }

        // single batched registry call for the union — Registry
        // handles concurrency + cache so this is fast on a warm cache.
        const registryHits = await registry.fetchMany(Array.from(allPackageNames));

        const rows: MatrixRow[] = [];

        for (const pkgName of Array.from(allPackageNames).sort()) {
            const rowCells: Record<string, MatrixCell> = {};

            for (const [unid, cells] of perProjectCells.entries()) {
                const cell = cells.get(pkgName);

                if (cell) {
                    rowCells[unid] = cell;
                }
            }

            // Git-only rows: every declaration points at a git URL, so
            // the registry entry of the same name is either missing
            // or — worse — an unrelated package that happens to
            // share the name (the figtree / fundon collision). Force
            // `latest = null` so the UI shows "git" instead of the
            // foreign latest, and so the row status comes out as
            // drift / unknown rather than a fake "outdated" against
            // a version that doesn't belong to this package.
            const allCellsGit = Object.values(rowCells).every(
                (c) => GitResolver.isGitVersion(c.version)
            );
            const reg = allCellsGit ? null : (registryHits.get(pkgName) ?? null);
            const latest = reg?.latest ?? null;
            const latestPublishedAt = (latest && reg?.time?.[latest]) ?? null;

            rows.push({
                name: pkgName,
                cells: rowCells,
                latest,
                latestPublishedAt,
                status: MatrixBuilder._computeStatus(rowCells, latest)
            });
        }

        return {projects, rows};
    }

    /**
     * Aggregate one project's manifests into a single per-package
     * cell. If the project's own workspaces disagree,
     * `internalDrift` is set and the cell's `version` shows the
     * *root* manifest's version (falling back to the first workspace
     * that declares it).
     */
    private static _buildProjectCells(manifests: PackageManifest[]): Map<string, MatrixCell> {
        const out = new Map<string, MatrixCell>();

        const collected = new Map<string, {versions: Set<string>; types: Set<DependencyType>; rootVersion: string|null}>();

        for (const manifest of manifests) {
            const isRoot = manifest.workspace === undefined;

            for (const dep of manifest.dependencies) {
                let entry = collected.get(dep.name);

                if (!entry) {
                    entry = {versions: new Set(), types: new Set(), rootVersion: null};
                    collected.set(dep.name, entry);
                }

                entry.versions.add(dep.version);
                entry.types.add(dep.type);

                if (isRoot) {
                    entry.rootVersion = dep.version;
                }
            }
        }

        for (const [name, entry] of collected.entries()) {
            // prefer the root version for the displayed cell so the
            // user sees what the "project as a whole" is pinning; if
            // there's no root manifest declaration, pick any.
            const display = entry.rootVersion ?? Array.from(entry.versions)[0];

            out.set(name, {
                version: display,
                types: Array.from(entry.types),
                internalDrift: entry.versions.size > 1
            });
        }

        return out;
    }

    /**
     * Decide row status from the cells + registry data. See
     * `MatrixRowStatus` for semantics.
     */
    private static _computeStatus(
        cells: Record<string, MatrixCell>,
        latest: string|null
    ): MatrixRowStatus {
        const cleaned = new Set<string>();

        for (const cell of Object.values(cells)) {
            cleaned.add(MatrixBuilder.cleanRange(cell.version));
        }

        if (cleaned.size > 1) {
            return MatrixRowStatus.drift;
        }

        if (latest === null) {
            return MatrixRowStatus.unknown;
        }

        const single = cleaned.values().next().value;

        if (single === undefined) {
            return MatrixRowStatus.unknown;
        }

        return single === MatrixBuilder.cleanRange(latest)
            ? MatrixRowStatus.aligned
            : MatrixRowStatus.outdated;
    }
}