import {execFileSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {BackfillCommon, GitBackfillResult, GitHistorySnapshot, SnapshotSource} from './BackfillCommon.js';

/**
 * Pluggable shell for the git commands we need. The default uses
 * `execFileSync`; tests inject an in-memory fake so the suite stays
 * offline and doesn't shell out. All methods are sync because the
 * sequential per-commit replay doesn't benefit from concurrency and
 * the API stays straightforward.
 */
export type GitRunner = {
    /** True when `<cwd>/.git` exists (file or directory — submodules use a file). */
    isRepo: (cwd: string) => boolean;
    /**
     * `<sha>,<unix-seconds>` per commit that touched the file, one per
     * line, oldest-first. Empty string when the file is untracked or
     * the repo is empty.
     */
    log: (cwd: string, file: string) => string;
    /** File contents at a specific ref. Throws on missing/binary commits. */
    show: (cwd: string, ref: string, file: string) => string;
    /** HEAD SHA of the repo. Used as the backfill watermark. */
    headSha: (cwd: string) => string;
};

/*
 * Re-export the shared types so existing imports keep working. The
 * types live in `BackfillCommon` because the remote backfill shares
 * them; this module's public surface stays unchanged.
 */
export type {GitBackfillResult, GitHistorySnapshot};

/**
 * Walks a local project's git log for `package-lock.json` and
 * reconstructs the history of dependency sets at every commit that
 * touched it.
 *
 * Caveats:
 *  - Local projects only. Remote sources (GitHub/Gitea) use
 *    `RemoteGitHistoryBackfill` instead.
 *  - `lockfileVersion` 0 / 1 commits are skipped (LockfileReader.parse
 *    rejects them). The commit drops out silently — the user sees
 *    one less entry, not a crash.
 *  - File renames are not followed (`--follow` is omitted). Most
 *    projects don't rename `package-lock.json`; commits before a
 *    rename would resolve as "missing file" and get skipped.
 */
export class GitHistoryBackfill {

    private readonly _runner: GitRunner;

    constructor(runner?: GitRunner) {
        this._runner = runner ?? GitHistoryBackfill._defaultRunner();
    }

    /**
     * True when the directory looks like a git repo. Cheaper than
     * actually calling `git status` since we only need a yes/no.
     */
    public isAvailable(cwd: string): boolean {
        return this._runner.isRepo(cwd);
    }

    /**
     * HEAD SHA of the repo. Returned to callers so they can decide
     * whether to re-run the walk (skipped when the SHA hasn't moved
     * since the last backfill).
     */
    public headSha(cwd: string): string|null {
        if (!this._runner.isRepo(cwd)) {
            return null;
        }
        try {
            const sha = this._runner.headSha(cwd).trim();
            return sha || null;
        } catch {
            return null;
        }
    }

    /**
     * Walk every commit that touched `package-lock.json` (or
     * `package.json` as a fallback when no lockfile was ever
     * committed), parse each file, diff consecutive snapshots, and
     * return the resulting chronological `HistoryEntry[]`.
     * `onProgress` fires once per commit so the SSE caller can drive
     * a progress bar.
     *
     * Source-selection rule: if ANY commit touched
     * `package-lock.json`, the lockfile path wins outright — even
     * commits from when only `package.json` existed get dropped.
     * Mixing the two would produce confusing `^4.0.0 → 4.17.20`
     * transitions at the boundary. The fallback path only kicks in
     * when the repo has never committed a lockfile.
     */
    public build(
        cwd: string,
        onProgress?: (current: number, total: number) => void
    ): GitBackfillResult {
        if (!this.isAvailable(cwd)) {
            return {headSha: null, entries: [], finalState: [], source: 'committed'};
        }

        const headSha = this.headSha(cwd);

        /*
         * Lockfile-first. When non-empty, ignore package.json
         * entirely — same-commit transitions between the two would
         * create false diffs.
         */
        const lockSnapshots = this._listSnapshots(cwd, 'package-lock.json', 'committed', onProgress);
        if (lockSnapshots.length > 0) {
            const {entries, finalState} = BackfillCommon.snapshotsToEntries(lockSnapshots);
            return {headSha: headSha, entries: entries, finalState: finalState, source: 'committed'};
        }

        /*
         * No committed lockfile anywhere in history — fall back to
         * tracking declared-deps drift via package.json.
         */
        const pkgSnapshots = this._listSnapshots(cwd, 'package.json', 'package-json', onProgress);
        if (pkgSnapshots.length === 0) {
            return {headSha: headSha, entries: [], finalState: [], source: 'committed'};
        }

        const {entries, finalState} = BackfillCommon.snapshotsToEntries(pkgSnapshots);
        return {headSha: headSha, entries: entries, finalState: finalState, source: 'package-json'};
    }

    private _listSnapshots(
        cwd: string,
        file: string,
        source: SnapshotSource,
        onProgress?: (current: number, total: number) => void
    ): GitHistorySnapshot[] {
        let log: string;
        try {
            log = this._runner.log(cwd, file).trim();
        } catch {
            return [];
        }
        if (!log) {
            return [];
        }

        const lines = log.split('\n').filter((l) => l.length > 0);
        const out: GitHistorySnapshot[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const idx = line.indexOf(',');
            if (idx < 0) {
                continue;
            }
            const sha = line.slice(0, idx).trim();
            const secs = parseInt(line.slice(idx + 1).trim(), 10);
            if (!sha || !Number.isFinite(secs)) {
                continue;
            }

            let content: string;
            try {
                content = this._runner.show(cwd, sha, file);
            } catch {
                onProgress?.(i + 1, lines.length);
                continue;
            }

            const packages = source === 'committed'
                ? BackfillCommon.parseLockfileToPackages(content)
                : BackfillCommon.parsePackageJsonToPackages(content);
            onProgress?.(i + 1, lines.length);
            if (packages === null) {
                continue;
            }

            out.push({sha: sha, timestamp: secs * 1000, packages: packages, source: source});
        }
        return out;
    }

    private static _defaultRunner(): GitRunner {
        const opts = {
            encoding: 'utf-8' as const,
            /*
             * Big lockfiles balloon up. 128 MB is the upper bound for
             * realistic monorepo lockfiles.
             */
            maxBuffer: 128 * 1024 * 1024,
            /*
             * Inherit the shell environment but swallow stderr — git
             * chatter on missing refs would otherwise spam the dev log.
             */
            stdio: ['ignore', 'pipe', 'ignore'] as ('ignore'|'pipe')[]
        };
        return {
            isRepo: (cwd) => fs.existsSync(path.join(cwd, '.git')),
            log: (cwd, file) => execFileSync(
                'git',
                ['log', '--reverse', '--format=%H,%ct', '--', file],
                {...opts, cwd: cwd}
            ),
            show: (cwd, ref, file) => execFileSync(
                'git',
                ['show', `${ref}:${file}`],
                {...opts, cwd: cwd}
            ),
            headSha: (cwd) => execFileSync(
                'git',
                ['rev-parse', 'HEAD'],
                {...opts, cwd: cwd}
            )
        };
    }

}