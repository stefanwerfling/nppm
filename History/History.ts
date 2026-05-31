/**
 * One package change in a single snapshot. `bumpType` is detected from
 * the version strings via semver; pre-release versions or non-numeric
 * version strings yield `null`. `reason` is a free-form human label —
 * currently auto-generated from `bumpType` plus an optional CVE hint
 * but reserved for user-supplied overrides later.
 */
export type HistoryBumpType = 'major'|'minor'|'patch'|'none';

export type HistoryUpdate = {
    name: string;
    fromVersion: string;
    toVersion: string;
    bumpType: HistoryBumpType|null;
    reason: string;
};

export type HistoryAdded = {
    name: string;
    version: string;
};

export type HistoryRemoved = {
    name: string;
    version: string;
};

/**
 * Where the entry came from. `snapshot` is the live nppm path —
 * recorded whenever the lockfile endpoint runs. `git` is reconstructed
 * by walking the project's git log for `package-lock.json`; the field
 * lets the UI render git-backfilled entries with a distinct badge so
 * the user can tell which deltas were observed live vs reconstructed.
 *
 * Optional so pre-existing history files (written before the
 * backfill landed) still parse cleanly — readers default missing
 * values to `snapshot`.
 */
export type HistoryEntrySource = 'snapshot'|'git';

/**
 * One entry in the per-project history file. Each entry captures the
 * delta against the *previous* entry's package set, not the absolute
 * package list — keeps the file size manageable when most snapshots
 * are no-ops. `timestamp` is unix-ms.
 *
 * The initial entry (when there's no prior snapshot) has all current
 * packages in `added` and empty `removed`/`updated`. Subsequent
 * entries only fire when at least one of the three lists is non-empty.
 */
export type HistoryEntry = {
    timestamp: number;
    lockfileSource: string;
    added: HistoryAdded[];
    removed: HistoryRemoved[];
    updated: HistoryUpdate[];
    source?: HistoryEntrySource;
    /**
     * For `source: 'git'` entries, the SHA of the commit that produced
     * the delta. Lets the UI link out and lets `backfillFromGit` de-dupe
     * re-runs without scanning timestamps.
     */
    commitSha?: string;
};

/**
 * Whole-file shape persisted per project. `lastSnapshot` is the most
 * recent full package set; we keep it so the next diff is O(N)
 * without replaying every historical entry. `entries` is sorted
 * oldest-first; the UI reverses to newest-first.
 *
 * `gitBackfilledHead` records the HEAD SHA at the time
 * `backfillFromGit` last ran. The next backfill attempt skips the
 * walk entirely when HEAD hasn't moved — keeps repeat opens of the
 * vulnerability-timeline view cheap. Cleared (`null`) on a fresh
 * file.
 */
export type HistoryFile = {
    projectKey: string;
    projectName: string;
    lastSnapshot: {
        timestamp: number;
        packages: {name: string; version: string}[];
    }|null;
    entries: HistoryEntry[];
    gitBackfilledHead?: string|null;
};