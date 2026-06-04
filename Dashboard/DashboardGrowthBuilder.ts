import {HistoryFile} from '../History/History.js';

/**
 * One project's installed-package count over time. Reconstructed by
 * replaying the per-project HistoryStore entries; each point captures
 * the count *after* the entry's add/remove deltas land. `null` entries
 * are not produced — projects without history at all are dropped from
 * the response.
 */
export type ProjectGrowthSeries = {
    unid: string;
    name: string;
    points: {timestamp: string; count: number}[];
};

/**
 * Ecosystem-wide installed-package count. Carry-forward sum across
 * non-aligned per-project timestamps: at each unique event time we
 * sum every project's *most recent known count* (0 for projects
 * absent from the timeline up to that point), so the curve grows
 * monotonically as projects join the observed timeline.
 */
export type EcosystemGrowthPoint = {
    timestamp: string;
    count: number;
};

export type DashboardGrowth = {
    series: ProjectGrowthSeries[];
    total: EcosystemGrowthPoint[];
};

/**
 * One project to be folded into the growth response. The caller has
 * already read the HistoryFile — keeps this builder pure / sync /
 * testable without filesystem I/O.
 */
export type GrowthProjectInput = {
    unid: string;
    name: string;
    history: HistoryFile;
};

/**
 * Reconstruct per-project package-count timelines from `HistoryStore`
 * data and roll them up to an ecosystem total. Every method is
 * static — no state, no I/O — so the route handler in
 * `vite.config.ts` and the test suite share the same code path.
 *
 * Reconstruction notes:
 *
 *   - The HistoryStore file holds the final package list
 *     (`lastSnapshot.packages`) plus a sequence of add/remove/update
 *     *deltas*. `update` swaps the version of an existing name, so it
 *     never changes the count; only `added.length - removed.length`
 *     does. The baseline (count before any entry) is therefore
 *     `lastSnapshot.length - Σ (added - removed)`.
 *
 *   - When the GitHistoryBackfill walked a project that had no
 *     committed `package-lock.json` for early commits, it falls back
 *     to `package.json`. Those entries describe *direct deps only*,
 *     while later live snapshots cover transitive deps — a step
 *     change at the lockfile-introduction commit is expected and not
 *     a bug.
 */
export class DashboardGrowthBuilder {

    /**
     * Build the full response from a list of (project, history) pairs.
     * `sinceMs` clips per-project series to events at or after the
     * cutoff *but* always retains the most recent point before the
     * cutoff (carried forward) so the line starts at the cutoff with
     * the correct Y instead of dropping to zero.
     */
    public static build(
        projects: GrowthProjectInput[],
        sinceMs: number = 0
    ): DashboardGrowth {
        const series: ProjectGrowthSeries[] = [];
        for (const p of projects) {
            const points = DashboardGrowthBuilder._replay(p.history);
            if (points.length === 0) {
                continue;
            }
            const clipped = DashboardGrowthBuilder._clipToCutoff(points, sinceMs);
            if (clipped.length === 0) {
                continue;
            }
            series.push({unid: p.unid, name: p.name, points: clipped});
        }
        const total = DashboardGrowthBuilder._ecosystemTotal(series);
        return {series, total};
    }

    /**
     * Walk one HistoryFile forward, emitting (timestamp, count) at
     * each delta. Returns `[]` when there is no observable state
     * (empty file, no lastSnapshot). Public so tests can exercise the
     * replay without going through `build`.
     */
    public static replay(history: HistoryFile): {timestamp: string; count: number}[] {
        return DashboardGrowthBuilder._replay(history);
    }

    private static _replay(history: HistoryFile): {timestamp: string; count: number}[] {
        if (!history.lastSnapshot) {
            return [];
        }
        const finalCount = history.lastSnapshot.packages.length;
        let netDelta = 0;
        for (const e of history.entries) {
            netDelta += e.added.length - e.removed.length;
        }
        const baseline = finalCount - netDelta;

        const out: {timestamp: string; count: number}[] = [];

        // Anchor the baseline at one millisecond before the first
        // entry so the line has a flat start instead of a vertical
        // jump from 0 → baseline at entry_0. When there are no
        // entries, the baseline equals the lastSnapshot and one point
        // suffices.
        if (history.entries.length === 0) {
            out.push({
                timestamp: new Date(history.lastSnapshot.timestamp).toISOString(),
                count: finalCount
            });
            return out;
        }

        const firstTs = history.entries[0].timestamp;
        out.push({
            timestamp: new Date(firstTs - 1).toISOString(),
            count: baseline
        });

        let running = baseline;
        for (const e of history.entries) {
            running += e.added.length - e.removed.length;
            out.push({
                timestamp: new Date(e.timestamp).toISOString(),
                count: running
            });
        }

        // Append the latest snapshot timestamp when it post-dates the
        // last entry — the snapshot can advance without a delta when
        // the user re-ran `npm install` and the lockfile didn't
        // actually change. Avoids the trend chart looking stale at the
        // right edge.
        const lastEntryTs = history.entries[history.entries.length - 1].timestamp;
        if (history.lastSnapshot.timestamp > lastEntryTs) {
            out.push({
                timestamp: new Date(history.lastSnapshot.timestamp).toISOString(),
                count: finalCount
            });
        }
        return out;
    }

    /**
     * Drop points older than `sinceMs`, but keep the most recent
     * point before the cutoff as the carry-forward anchor at the left
     * edge. `sinceMs <= 0` returns the input untouched.
     */
    private static _clipToCutoff(
        points: {timestamp: string; count: number}[],
        sinceMs: number
    ): {timestamp: string; count: number}[] {
        if (sinceMs <= 0) {
            return points;
        }
        let anchor: {timestamp: string; count: number}|null = null;
        const inside: {timestamp: string; count: number}[] = [];
        for (const p of points) {
            const t = new Date(p.timestamp).getTime();
            if (t < sinceMs) {
                anchor = p;
            } else {
                inside.push(p);
            }
        }
        if (inside.length === 0) {
            // Range falls entirely after the last event — carry the
            // last known count forward as a single point so the
            // project's line is still visible.
            return anchor ? [anchor] : [];
        }
        if (anchor) {
            // Re-stamp the anchor to the cutoff so the line starts
            // exactly at the left edge instead of one tick beyond it.
            return [
                {timestamp: new Date(sinceMs).toISOString(), count: anchor.count},
                ...inside
            ];
        }
        return inside;
    }

    /**
     * Carry-forward sum across all per-project series. At each unique
     * event timestamp, sum the most recently known count per project
     * (0 if the project hasn't appeared yet). Same timestamp emits
     * one consolidated point (last write wins per unid for that
     * instant).
     */
    private static _ecosystemTotal(series: ProjectGrowthSeries[]): EcosystemGrowthPoint[] {
        type Event = {ts: number; unid: string; count: number};
        const events: Event[] = [];
        for (const s of series) {
            for (const p of s.points) {
                events.push({ts: new Date(p.timestamp).getTime(), unid: s.unid, count: p.count});
            }
        }
        events.sort((a, b) => a.ts - b.ts);

        const latest = new Map<string, number>();
        const out: EcosystemGrowthPoint[] = [];
        let i = 0;
        while (i < events.length) {
            // Drain all events that share this exact timestamp so the
            // emitted total reflects every per-project update at that
            // instant, not just the first one in encounter order.
            const ts = events[i].ts;
            while (i < events.length && events[i].ts === ts) {
                latest.set(events[i].unid, events[i].count);
                i++;
            }
            let sum = 0;
            for (const v of latest.values()) {
                sum += v;
            }
            out.push({timestamp: new Date(ts).toISOString(), count: sum});
        }
        return out;
    }
}