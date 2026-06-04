import {ConfigProjectType} from '../Config/Config.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {LockfileReader} from '../Project/Lockfile.js';
import {DependencyType, PackageManifest} from '../Project/PackageManifest.js';
import {Project} from '../Project/Project.js';
import {Registry} from '../Registry/Registry.js';
import {GitHeadFetcher, GitHeadInfo} from '../Releases/GitHeadFetcher.js';
import {MatrixBuilder, MatrixGitLatest, MatrixRowStatus} from './MatrixBuilder.js';

/**
 * One column header in the per-project matrix. `label` is what gets
 * rendered: `'root'` for the project root manifest, otherwise the
 * relative workspace path (`packages/api`, `apps/web`, …).
 */
export type ProjectMatrixWorkspace = {
    label: string;
};

/**
 * One cell in the per-project matrix. No `internalDrift` here — that
 * flag only makes sense in the global matrix where workspaces are
 * collapsed; in this view every workspace gets its own column, so
 * disagreement is directly visible as different versions across cells.
 */
export type ProjectMatrixCell = {
    version: string;
    types: DependencyType[];
    /** Same convention as `MatrixCell.installedVersion`. */
    installedVersion?: string;
};

export type ProjectMatrixRow = {
    name: string;
    cells: Record<string, ProjectMatrixCell>;
    latest: string|null;
    latestPublishedAt: string|null;
    status: MatrixRowStatus;
    /**
     * HEAD-info for git-only rows (every workspace declares the
     * package via a git URL). Shape mirrors the cross-project matrix:
     * `version` + `shortSha` from the upstream repo, populated by
     * `GitHeadFetcher` after the row is built. `undefined` for
     * registry-anchored rows.
     */
    gitLatest?: MatrixGitLatest;
};

export type ProjectMatrixResponse = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    workspaces: ProjectMatrixWorkspace[];
    rows: ProjectMatrixRow[];
};

const ROOT_LABEL = 'root';

/**
 * Per-project matrix assembly. Rows = unique package names across the
 * project's manifests; columns = workspaces (the root manifest is its
 * own column labelled `root`, then one column per declared workspace).
 * A trailing "Latest" column comes from the registry — same pattern
 * as the global matrix.
 *
 * Cells are sparse: if a workspace doesn't declare a given package,
 * its key is absent from `row.cells` (the frontend renders an
 * em-dash). All work is in one static method — the builder holds no
 * state.
 */
export class ProjectMatrixBuilder {

    public static async build(
        projectUnid: string,
        project: Project,
        registry: Registry,
        headFetcher: GitHeadFetcher|null = null
    ): Promise<ProjectMatrixResponse> {
        const manifests = await project.loadManifests();

        // Lockfile lookup for git-pinned cells — same approach as the
        // global matrix.
        let installedByName: Map<string, string>|null = null;
        try {
            const lockfile = await project.loadLockfile();
            if (lockfile) {
                installedByName = LockfileReader.topLevelVersionMap(lockfile);
            }
        } catch {
            // best-effort
        }

        // Workspaces, with `root` always leading so the user's eye
        // lands on the canonical column first.
        const workspaceLabels: string[] = [ROOT_LABEL];
        const labelByManifest = new Map<PackageManifest, string>();

        for (const m of manifests) {
            const label = m.workspace ?? ROOT_LABEL;
            labelByManifest.set(m, label);
            if (label !== ROOT_LABEL && !workspaceLabels.includes(label)) {
                workspaceLabels.push(label);
            }
        }

        // Per-workspace cells, indexed by package name.
        const allNames = new Set<string>();
        const cellsByLabel = new Map<string, Map<string, ProjectMatrixCell>>();
        for (const label of workspaceLabels) {
            cellsByLabel.set(label, new Map());
        }

        for (const manifest of manifests) {
            const label = labelByManifest.get(manifest)!;
            const bucket = cellsByLabel.get(label)!;

            for (const dep of manifest.dependencies) {
                allNames.add(dep.name);

                const existing = bucket.get(dep.name);
                if (existing) {
                    // Multiple buckets within one workspace shouldn't
                    // happen (manifest = single package.json), but be
                    // defensive: union the dep types.
                    if (!existing.types.includes(dep.type)) {
                        existing.types.push(dep.type);
                    }
                } else {
                    const cell: ProjectMatrixCell = {
                        version: dep.version,
                        types: [dep.type]
                    };
                    if (installedByName && GitResolver.isGitVersion(dep.version)) {
                        const v = installedByName.get(dep.name);
                        if (v) {
                            cell.installedVersion = v;
                        }
                    }
                    bucket.set(dep.name, cell);
                }
            }
        }

        // Batched registry lookup — same Registry instance the global
        // matrix uses, so the cache is shared.
        const hits = await registry.fetchMany(Array.from(allNames));

        const rows: ProjectMatrixRow[] = [];
        for (const name of Array.from(allNames).sort()) {
            const cells: Record<string, ProjectMatrixCell> = {};
            const versionsForStatus: string[] = [];

            for (const label of workspaceLabels) {
                const cell = cellsByLabel.get(label)!.get(name);
                if (cell) {
                    cells[label] = cell;
                    versionsForStatus.push(cell.version);
                }
            }

            // Git-only rows: the registry packument for `name` belongs
            // to an unrelated public package — using its `latest`
            // would surface a foreign author's version in the column
            // (the figtree / fundon collision again). Force `latest=null`
            // and stamp `gitLatest` with the stripped origin URL so
            // the HEAD fetcher can fill in version + short SHA below.
            const allCellsGit = versionsForStatus.length > 0
                && versionsForStatus.every((v) => GitResolver.isGitVersion(v));
            const reg = allCellsGit ? null : (hits.get(name) ?? null);
            const latest = reg?.latest ?? null;
            const latestPublishedAt = (latest && reg?.time?.[latest]) ?? null;

            const row: ProjectMatrixRow = {
                name,
                cells,
                latest,
                latestPublishedAt,
                status: MatrixBuilder.computeStatusFromVersions(versionsForStatus, latest)
            };
            if (allCellsGit) {
                row.gitLatest = {
                    version: null,
                    sha: null,
                    shortSha: null,
                    sourceUrl: versionsForStatus[0].replace(/#.*$/, '')
                };
            }
            rows.push(row);
        }

        if (headFetcher) {
            const distinctUrls = new Set<string>();
            for (const r of rows) {
                if (r.gitLatest?.sourceUrl) {
                    distinctUrls.add(r.gitLatest.sourceUrl);
                }
            }
            const resolved = new Map<string, GitHeadInfo|null>();
            await Promise.all(Array.from(distinctUrls).map(async (url) => {
                try {
                    resolved.set(url, await headFetcher.fetch(url));
                } catch {
                    resolved.set(url, null);
                }
            }));
            for (const r of rows) {
                if (r.gitLatest) {
                    const info = resolved.get(r.gitLatest.sourceUrl) ?? null;
                    if (info) {
                        r.gitLatest = {
                            ...r.gitLatest,
                            version: info.version,
                            sha: info.sha,
                            shortSha: info.shortSha
                        };
                    }
                }
            }
        }

        return {
            project: {
                unid: projectUnid,
                name: project.getName(),
                type: project.getType()
            },
            workspaces: workspaceLabels.map((label) => ({label})),
            rows
        };
    }
}