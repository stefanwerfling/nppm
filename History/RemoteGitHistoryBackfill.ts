import {ProjectRemote} from '../Project/ProjectRemote.js';
import {
    BackfillCommon,
    GitBackfillResult,
    GitHistorySnapshot,
    SnapshotSource
} from './BackfillCommon.js';

/**
 * Async sibling of `GitHistoryBackfill` for GitHub/Gitea projects.
 * Lists every commit on the configured ref that touched
 * `package-lock.json` (via the host's commits API, paginated), fetches
 * the file contents at each commit (via the contents API at that SHA),
 * and produces the same `GitBackfillResult` shape — so the SSE handler
 * can dispatch on project type without changing the downstream
 * pipeline.
 *
 * Source-selection rule (matches `GitHistoryBackfill`): if ANY commit
 * on the configured ref touched `package-lock.json`, the lockfile
 * path wins outright. Only when the remote repo has never committed
 * a lockfile do we fall back to walking `package.json` for declared
 * deps. Mixing would create false `^4.0.0 → 4.17.20` transitions at
 * the boundary commit.
 *
 * Rate-limit caveat: GitHub gives anonymous callers 60 requests / hour.
 * One backfill costs `1 + ceil(commits/100) + uniqueCommits` requests
 * (HEAD + commit list pages + one file fetch per commit). Without a
 * `GH_TOKEN`, projects with >50 lockfile commits will hit the limit
 * mid-walk; the caller is expected to surface the resulting throw as
 * "backfill aborted — set GH_TOKEN".
 */
export class RemoteGitHistoryBackfill {

    /**
     * `true` when the project exposes the commit-listing API. Always
     * true for GitHub/Gitea projects in v1 — the method exists for
     * symmetry with the local class and for future host types that
     * might lack a public commits endpoint.
     */
    public isAvailable(project: ProjectRemote): boolean {
        return typeof project.listCommitsForFile === 'function';
    }

    /**
     * Returns the HEAD SHA of the project's configured ref, or null
     * when the API is unreachable. Used by the SSE handler to decide
     * whether to skip the walk (HEAD unchanged since last backfill).
     */
    public async headSha(project: ProjectRemote): Promise<string|null> {
        try {
            return await project.getHeadSha();
        } catch {
            return null;
        }
    }

    /**
     * Walk every commit on the configured ref that touched
     * `package-lock.json` (or `package.json` as a fallback when no
     * lockfile was ever committed), fetch each file revision, diff
     * consecutive snapshots, and return chronological entries.
     * `onProgress` fires after each commit's file fetch so the SSE
     * caller can drive a progress bar.
     */
    public async build(
        project: ProjectRemote,
        onProgress?: (current: number, total: number) => void
    ): Promise<GitBackfillResult> {
        const headSha = await this.headSha(project);

        // Lockfile-first. When non-empty, ignore package.json
        // entirely — same-commit transitions between the two would
        // create false diffs.
        const lockSnapshots = await this._collectSnapshots(
            project,
            'package-lock.json',
            'committed',
            onProgress
        );
        if (lockSnapshots.length > 0) {
            const {entries, finalState} = BackfillCommon.snapshotsToEntries(lockSnapshots);
            return {headSha, entries, finalState, source: 'committed'};
        }

        // No committed lockfile anywhere — fall back to tracking
        // declared-deps drift via package.json. Versions are ranges,
        // not concrete; downstream code (TimelineBuilder) filters
        // them out of OSV stats.
        const pkgSnapshots = await this._collectSnapshots(
            project,
            'package.json',
            'package-json',
            onProgress
        );
        if (pkgSnapshots.length === 0) {
            return {headSha, entries: [], finalState: [], source: 'committed'};
        }

        const {entries, finalState} = BackfillCommon.snapshotsToEntries(pkgSnapshots);
        return {headSha, entries, finalState, source: 'package-json'};
    }

    /**
     * Walk every commit that touched `file`, fetch + parse each
     * revision, and return one snapshot per parseable commit
     * (commits where the fetch fails or the file isn't parseable
     * drop out silently). Empty list when the API is unreachable or
     * the file was never committed on the ref.
     */
    private async _collectSnapshots(
        project: ProjectRemote,
        file: string,
        source: SnapshotSource,
        onProgress?: (current: number, total: number) => void
    ): Promise<GitHistorySnapshot[]> {
        let commits;
        try {
            commits = await project.listCommitsForFile(file);
        } catch {
            return [];
        }
        if (commits === null || commits.length === 0) {
            return [];
        }

        const snapshots: GitHistorySnapshot[] = [];
        for (let i = 0; i < commits.length; i++) {
            const c = commits[i];
            let content: string|null;
            try {
                content = await project.fetchFileAtRef(file, c.sha);
            } catch {
                onProgress?.(i + 1, commits.length);
                continue;
            }
            if (content === null) {
                onProgress?.(i + 1, commits.length);
                continue;
            }

            const packages = source === 'committed'
                ? BackfillCommon.parseLockfileToPackages(content)
                : BackfillCommon.parsePackageJsonToPackages(content);
            onProgress?.(i + 1, commits.length);
            if (packages === null) {
                continue;
            }

            snapshots.push({sha: c.sha, timestamp: c.timestamp, packages, source});
        }
        return snapshots;
    }
}