import {LockfileReader} from '../Project/Lockfile.js';
import {
    HistoryAdded,
    HistoryBumpType,
    HistoryEntry,
    HistoryRemoved,
    HistoryUpdate
} from './History.js';

/**
 * Where one snapshot's contents came from.
 *  - `committed`: parsed from `package-lock.json` (concrete resolved
 *    versions — full OSV coverage downstream).
 *  - `package-json`: parsed from `package.json` (declared ranges
 *    only — used as a fallback for projects that don't commit a
 *    lockfile so the history view still has data).
 */
export type SnapshotSource = 'committed'|'package-json';

/**
 * One commit's dep state reduced to a set of `name@version` pairs.
 * `version` is a concrete version when `source === 'committed'` and
 * a declared range (e.g. `^4.0.0`) when `source === 'package-json'`.
 * Deduplicated to match `recordSnapshot` semantics — nested installs
 * (or duplicate bucket declarations) collapse to one entry.
 */
export type GitHistorySnapshot = {
    sha: string;
    timestamp: number;
    packages: {name: string; version: string;}[];
    source: SnapshotSource;
};

/**
 * Result of one backfill walk. Both `GitHistoryBackfill` (local) and
 * `RemoteGitHistoryBackfill` (GitHub/Gitea) emit this shape so the
 * SSE handler can dispatch on project type without changing the
 * downstream pipeline.
 *
 * `entries` are sorted oldest-first (ready to splice into
 * `HistoryFile.entries`). `headSha` is the HEAD SHA processed so the
 * next call short-circuits when HEAD hasn't moved. `finalState`
 * carries the lockfile contents at the last visited commit — the
 * store uses it to seed `lastSnapshot` on fresh projects.
 */
export type GitBackfillResult = {
    headSha: string|null;
    entries: HistoryEntry[];
    finalState: {name: string; version: string;}[];
    /**
     * Which file was the actual data source. Lets the SSE handler
     * decide whether to seed `lastSnapshot` from `finalState`
     * (`committed` → safe, concrete versions) or skip the seed
     * (`package-json` → ranges would trip a false diff on the next
     * live `recordSnapshot` call).
     */
    source: SnapshotSource;
};

/**
 * Pure helpers shared between local + remote backfill: parse a
 * lockfile blob → dedupe package list, and convert a chronologically
 * ordered snapshot list → `HistoryEntry[]` deltas. Stateless; all
 * methods are static.
 */
export class BackfillCommon {

    /**
     * Parse a `package.json` blob, flatten the four dep buckets
     * (`dependencies`, `devDependencies`, `peerDependencies`,
     * `optionalDependencies`) into `{name, version: range}` pairs.
     * First-bucket-wins on name collisions — matches the PR-Review
     * builder's npm-semantics choice. Returns `null` when the file
     * is unparseable so the caller can skip the commit.
     *
     * Used as the fallback data source when the project doesn't
     * commit a `package-lock.json`. The version strings here are
     * declared semver ranges, not resolved concrete versions —
     * downstream code that needs to query OSV must filter them out.
     */
    public static parsePackageJsonToPackages(content: string): {name: string; version: string;}[]|null {
        let raw: unknown;
        try {
            raw = JSON.parse(content);
        } catch {
            return null;
        }
        if (!raw || typeof raw !== 'object') {
            return null;
        }
        const obj = raw as Record<string, unknown>;
        const out: {name: string; version: string;}[] = [];
        const seen = new Set<string>();

        const buckets = [
            obj.dependencies,
            obj.devDependencies,
            obj.peerDependencies,
            obj.optionalDependencies
        ];
        for (const bucket of buckets) {
            if (!bucket || typeof bucket !== 'object') {
                continue;
            }
            for (const [name, value] of Object.entries(bucket as Record<string, unknown>)) {
                if (typeof value !== 'string' || seen.has(name)) {
                    continue;
                }
                seen.add(name);
                out.push({name: name, version: value});
            }
        }
        return out;
    }

    /**
     * Parse a `package-lock.json` blob, dedupe by `name@version`, and
     * return the package list ready to diff. Returns `null` when the
     * file is unparseable (v1 lockfile, broken JSON, binary). Callers
     * skip the commit in that case so one bad commit doesn't kill the
     * whole walk.
     */
    public static parseLockfileToPackages(content: string): {name: string; version: string;}[]|null {
        try {
            const lockfile = LockfileReader.parse(content, 'committed');
            const seen = new Set<string>();
            const out: {name: string; version: string;}[] = [];
            for (const p of lockfile.packages) {
                const key = `${p.name}@${p.version}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                out.push({name: p.name, version: p.version});
            }
            return out;
        } catch {
            return null;
        }
    }

    /**
     * Forward-replay a chronological snapshot list, producing one
     * `HistoryEntry` per non-empty diff. `finalState` is the package
     * list at the last visited commit (used by `HistoryStore` to seed
     * `lastSnapshot` on fresh projects). Each snapshot carries its
     * own `source` so a single backfill run could in principle mix
     * sources — in practice `GitHistoryBackfill` keeps them uniform.
     */
    public static snapshotsToEntries(snapshots: GitHistorySnapshot[]): {
        entries: HistoryEntry[];
        finalState: {name: string; version: string;}[];
    } {
        const entries: HistoryEntry[] = [];
        let prev: {name: string; version: string;}[] = [];

        for (const snap of snapshots) {
            const entry = BackfillCommon.diffSnapshots(
                prev,
                snap.packages,
                snap.timestamp,
                snap.sha,
                snap.source
            );
            if (entry !== null) {
                entries.push(entry);
            }
            prev = snap.packages;
        }

        return {entries: entries, finalState: prev};
    }

    /**
     * Compute one `HistoryEntry` representing the delta from `prev`
     * to `next`. Returns `null` when nothing changed (consecutive
     * commits with identical content — e.g. a merge commit that
     * didn't actually touch deps). `lockfileSource` carries through
     * to the entry so the UI can render package-json-derived deltas
     * with a distinct badge.
     */
    public static diffSnapshots(
        prev: {name: string; version: string;}[],
        next: {name: string; version: string;}[],
        timestamp: number,
        sha: string,
        source: SnapshotSource = 'committed'
    ): HistoryEntry|null {
        const prevByName = new Map<string, string>();
        for (const p of prev) {
            prevByName.set(p.name, p.version);
        }
        const nextByName = new Map<string, string>();
        for (const p of next) {
            nextByName.set(p.name, p.version);
        }

        const added: HistoryAdded[] = [];
        const removed: HistoryRemoved[] = [];
        const updated: HistoryUpdate[] = [];

        for (const [name, version] of nextByName) {
            const p = prevByName.get(name);
            if (p === undefined) {
                added.push({name: name, version: version});
            } else if (p !== version) {
                const bumpType = BackfillCommon.detectBumpType(p, version);
                updated.push({
                    name: name,
                    fromVersion: p,
                    toVersion: version,
                    bumpType: bumpType,
                    reason: BackfillCommon.describeReason(bumpType)
                });
            }
        }
        for (const [name, version] of prevByName) {
            if (!nextByName.has(name)) {
                removed.push({name: name, version: version});
            }
        }

        if (added.length === 0 && removed.length === 0 && updated.length === 0) {
            return null;
        }

        added.sort((a, b) => a.name.localeCompare(b.name));
        removed.sort((a, b) => a.name.localeCompare(b.name));
        updated.sort((a, b) => a.name.localeCompare(b.name));

        return {
            timestamp: timestamp,
            lockfileSource: source,
            added: added,
            removed: removed,
            updated: updated,
            source: 'git',
            commitSha: sha
        };
    }

    public static describeReason(bumpType: HistoryBumpType|null): string {
        if (bumpType === null) {
            return 'Version scheme unknown';
        }
        if (bumpType === 'none') {
            return 'Version unchanged';
        }
        return `${bumpType}-bump`;
    }

    public static detectBumpType(from: string, to: string): HistoryBumpType|null {
        const a = BackfillCommon._parseTriple(from);
        const b = BackfillCommon._parseTriple(to);
        if (!a || !b) {
            return null;
        }
        if (b[0] !== a[0]) {
            return 'major';
        }
        if (b[1] !== a[1]) {
            return 'minor';
        }
        if (b[2] !== a[2]) {
            return 'patch';
        }
        return 'none';
    }

    private static _parseTriple(v: string): [number, number, number]|null {
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    }

}