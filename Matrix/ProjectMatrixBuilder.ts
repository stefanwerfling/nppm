import {ConfigProjectType} from '../Config/Config.js';
import {isGitVersion} from '../Fingerprint/GitResolver.js';
import {topLevelVersionMap} from '../Project/Lockfile.js';
import {DependencyType, PackageManifest} from '../Project/PackageManifest.js';
import {Project} from '../Project/Project.js';
import {Registry} from '../Registry/Registry.js';
import {computeStatusFromVersions, MatrixRowStatus} from './MatrixBuilder.js';

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
 * Build the per-project matrix view: rows are unique package names
 * across the project's manifests, columns are the workspaces (the
 * root manifest is its own column labelled `root`, then one column
 * per declared workspace). A trailing "Latest" column comes from the
 * registry — same pattern as the global matrix.
 *
 * Cells are sparse: if a workspace doesn't declare a given package,
 * its key is absent from `row.cells` (the frontend renders an em-dash).
 */
export async function buildProjectMatrix(
    projectUnid: string,
    project: Project,
    registry: Registry
): Promise<ProjectMatrixResponse> {
    const manifests = await project.loadManifests();

    // Lockfile lookup for git-pinned cells — same approach as the
    // global matrix.
    let installedByName: Map<string, string>|null = null;
    try {
        const lockfile = await project.loadLockfile();
        if (lockfile) {
            installedByName = topLevelVersionMap(lockfile);
        }
    } catch {
        // best-effort
    }

    // Workspaces, with `root` always leading so the user's eye lands
    // on the canonical column first.
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
                if (installedByName && isGitVersion(dep.version)) {
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

        const reg = hits.get(name) ?? null;
        const latest = reg?.latest ?? null;
        const latestPublishedAt = (latest && reg?.time?.[latest]) ?? null;

        rows.push({
            name,
            cells,
            latest,
            latestPublishedAt,
            status: computeStatusFromVersions(versionsForStatus, latest)
        });
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