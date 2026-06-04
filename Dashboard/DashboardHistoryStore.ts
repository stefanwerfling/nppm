import fs from 'fs';
import path from 'path';
import {DashboardResponse, ScannerId} from './DashboardBuilder.js';

/**
 * One compact daily record of the dashboard scan, derived from the
 * full `DashboardResponse`. We persist only the averages the trend
 * surfaces use — not the per-cell findings — so a year of history
 * stays well under a megabyte even on a 20-project ecosystem.
 *
 * `overall` is the average over the per-project averages (each
 * project's `avg` is the mean of its non-N/A cell scores). `null`
 * means no project produced any scored cell.
 */
export type DashboardHistoryEntry = {
    timestamp: string;
    overall: number|null;
    /**
     * Sum of every project's `sizeBytes` at scan time. `null` when no
     * project produced a size aggregate (registry offline, all git
     * deps, …). Drives the Dashboard Trend tab's "Size" metric.
     */
    totalSizeBytes: number|null;
    /**
     * Ecosystem-deduped sum of last-week npm download counts across
     * every distinct package name installed by *any* project. A name
     * shared by three projects is counted once here — the metric
     * tracks the reach of the deduplicated dep tree, not its
     * cumulative ownership.
     */
    totalDownloadsLastWeek: number|null;
    perProject: {
        unid: string;
        name: string;
        avg: number|null;
        /**
         * Installed-bytes footprint for this project at scan time.
         * `null` when not computed (e.g. column.error). The number
         * is a best-effort floor — packages whose registry entry
         * lacks `unpackedSize` (very old releases, git deps) are
         * silently skipped from the sum.
         */
        sizeBytes: number|null;
        /**
         * Within-project deduped sum of last-week downloads. A package
         * pulled through multiple paths counts once. `null` when not
         * computed at scan time (e.g. the column errored before the
         * downloads fetch ran).
         */
        downloadsLastWeek: number|null;
    }[];
    perScanner: {scanner: ScannerId; avg: number|null}[];
};

/**
 * Per-day persistence of dashboard scan averages, mirroring the
 * `HistoryStore` shape (atomic write-then-rename, one file per
 * logical key). One file per UTC date in
 * `<projectRoot>/.nppm-history/dashboard/YYYY-MM-DD.json` — the last
 * scan of a given day wins so re-running the scan multiple times in
 * a day doesn't bloat the trend line.
 *
 * Lives under `.nppm-history/` (not `.nppm-cache/`) so the user can
 * commit it if they want a long-term ecosystem-health record under
 * source control. Same rationale as `HistoryStore`.
 */
export class DashboardHistoryStore {

    private readonly _dir: string;

    constructor(dir: string) {
        this._dir = dir;
        fs.mkdirSync(dir, {recursive: true});
    }

    /**
     * Compute the compact entry from a full `DashboardResponse` and
     * persist it under the timestamp's UTC date. Failure to write is
     * non-fatal — the caller decides whether to surface it.
     */
    public recordScan(
        dashboard: DashboardResponse,
        timestampIso: string,
        ecosystemDownloadsDeduped: number|null = null
    ): DashboardHistoryEntry {
        const entry = DashboardHistoryStore.summarize(
            dashboard, timestampIso, ecosystemDownloadsDeduped
        );
        const file = path.join(this._dir, `${DashboardHistoryStore._dateKey(timestampIso)}.json`);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entry));
        fs.renameSync(tmp, file);
        return entry;
    }

    /**
     * Return every persisted entry within the last `days` days,
     * sorted chronologically (oldest first). `days <= 0` returns the
     * empty list — callers route to an empty-state UI.
     */
    public readRange(days: number): DashboardHistoryEntry[] {
        if (days <= 0 || !fs.existsSync(this._dir)) {
            return [];
        }
        const cutoffMs = Date.now() - days * 86400_000;
        const out: DashboardHistoryEntry[] = [];
        for (const name of fs.readdirSync(this._dir)) {
            if (!name.endsWith('.json')) {
                continue;
            }
            const file = path.join(this._dir, name);
            try {
                const raw = fs.readFileSync(file, 'utf-8');
                const parsed = JSON.parse(raw) as DashboardHistoryEntry;
                const t = new Date(parsed.timestamp).getTime();
                if (Number.isNaN(t) || t < cutoffMs) {
                    continue;
                }
                out.push(parsed);
            } catch {
                // Corrupt file — skip it; next scan overwrites it.
            }
        }
        out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        return out;
    }

    /**
     * Last (most recent) entry across every persisted day, or `null`
     * when none exist. Used by the macro-donut to compute a delta
     * against the immediately-previous scan without forcing the
     * caller to know the file layout.
     */
    public readPrevious(beforeTimestampIso: string): DashboardHistoryEntry|null {
        if (!fs.existsSync(this._dir)) {
            return null;
        }
        const beforeMs = new Date(beforeTimestampIso).getTime();
        if (Number.isNaN(beforeMs)) {
            return null;
        }
        let best: DashboardHistoryEntry|null = null;
        let bestMs = -Infinity;
        for (const name of fs.readdirSync(this._dir)) {
            if (!name.endsWith('.json')) {
                continue;
            }
            try {
                const raw = fs.readFileSync(path.join(this._dir, name), 'utf-8');
                const parsed = JSON.parse(raw) as DashboardHistoryEntry;
                const t = new Date(parsed.timestamp).getTime();
                if (Number.isNaN(t) || t >= beforeMs) {
                    continue;
                }
                if (t > bestMs) {
                    best = parsed;
                    bestMs = t;
                }
            } catch {
                // ignore
            }
        }
        return best;
    }

    /**
     * Reduce a full dashboard response to the compact entry shape.
     * Public so tests can stay self-contained without writing to
     * disk — and so the route handler can build the in-memory entry
     * for the SSE end event without a round-trip through disk.
     */
    public static summarize(
        dashboard: DashboardResponse,
        timestampIso: string,
        ecosystemDownloadsDeduped: number|null = null
    ): DashboardHistoryEntry {
        const perProject: {unid: string; name: string; avg: number|null; sizeBytes: number|null; downloadsLastWeek: number|null}[] = [];
        const scannerSum = new Map<ScannerId, {sum: number; n: number}>();
        let overallSum = 0;
        let overallN = 0;
        let totalSize = 0;
        let anySize = false;
        let anyDownloads = false;

        for (const col of dashboard.columns) {
            let projSum = 0;
            let projN = 0;
            for (const [scanner, cell] of Object.entries(col.cells) as [ScannerId, {score: number|null}][]) {
                if (cell.score === null) {
                    continue;
                }
                projSum += cell.score;
                projN++;
                let bucket = scannerSum.get(scanner);
                if (!bucket) {
                    bucket = {sum: 0, n: 0};
                    scannerSum.set(scanner, bucket);
                }
                bucket.sum += cell.score;
                bucket.n++;
            }
            const avg = projN > 0 ? Math.round(projSum / projN) : null;
            if (avg !== null) {
                overallSum += avg;
                overallN++;
            }
            const sizeBytes = typeof col.sizeBytes === 'number' ? col.sizeBytes : null;
            if (sizeBytes !== null) {
                totalSize += sizeBytes;
                anySize = true;
            }
            const downloadsLastWeek = typeof col.downloadsLastWeek === 'number'
                ? col.downloadsLastWeek
                : null;
            if (downloadsLastWeek !== null) {
                anyDownloads = true;
            }
            perProject.push({
                unid: col.project.unid,
                name: col.project.name,
                avg,
                sizeBytes,
                downloadsLastWeek
            });
        }

        const perScanner: {scanner: ScannerId; avg: number|null}[] = [];
        for (const [scanner, bucket] of scannerSum) {
            perScanner.push({scanner, avg: Math.round(bucket.sum / bucket.n)});
        }
        perScanner.sort((a, b) => a.scanner.localeCompare(b.scanner));

        // Total downloads prefers the caller's deduped value (only
        // it knows the per-name dedupe across the whole fleet).
        // Falls back to the per-project sum only when the caller has
        // no downloads info at all — gives the metric *some* shape
        // for tests / future paths that don't compute downloads.
        let totalDl: number|null = null;
        if (ecosystemDownloadsDeduped !== null) {
            totalDl = ecosystemDownloadsDeduped;
        } else if (anyDownloads) {
            totalDl = perProject.reduce(
                (s, p) => s + (p.downloadsLastWeek ?? 0), 0
            );
        }

        return {
            timestamp: timestampIso,
            overall: overallN > 0 ? Math.round(overallSum / overallN) : null,
            totalSizeBytes: anySize ? totalSize : null,
            totalDownloadsLastWeek: totalDl,
            perProject,
            perScanner
        };
    }

    /**
     * UTC `YYYY-MM-DD` key — last scan of a UTC day wins. Local-time
     * keying would put two scans run at 01:00 and 23:00 of the same
     * local day into two different files when the timezone has DST
     * shifts; UTC is stable.
     */
    private static _dateKey(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return 'invalid-date';
        }
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
}