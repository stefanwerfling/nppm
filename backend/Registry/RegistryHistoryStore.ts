import fs from 'fs';
import path from 'path';
import {ApiRegistryHistoryDay, ApiRegistryProjectStat} from '../../shared/Api/ApiTypes.js';

/**
 * One project's accumulated request tally for a single UTC day.
 * `hits`/`misses` count tarball requests (store vs upstream);
 * `packuments`/`tarballs` count served metadata / tarball requests of
 * any result; `notFound`/`errors` count the failure results. The
 * `packages` map keeps per-package hit/miss counts so the mirror table
 * can show how often each cached package was actually served.
 */
export type RegistryDayProject = {
    hits: number;
    misses: number;
    packuments: number;
    tarballs: number;
    notFound: number;
    errors: number;
    packages: {[name: string]: {hits: number; misses: number;};};
};

/** All per-project tallies for one UTC calendar day. */
export type RegistryDay = {
    date: string;
    projects: {[project: string]: RegistryDayProject;};
};

/**
 * Per-day persistence of the registry proxy's per-project request
 * tallies, mirroring `DashboardHistoryStore`'s layout: one file per UTC
 * date in `<projectRoot>/.nppm/history/registry/YYYY-MM-DD.json`,
 * atomic write-then-rename.
 *
 * Unlike the dashboard store (last-scan-of-day wins), this store
 * *accumulates* — the counters are running totals for the day, so
 * `RegistryActivity` loads today's file on boot and keeps counting
 * where it left off after a restart. Lives under `.nppm/history/` (not
 * `.nppm/cache/`) so the audit trail survives a cache wipe and can be
 * committed if the user wants a long-term record.
 */
export class RegistryHistoryStore {

    private readonly _dir: string;

    public constructor(dir: string) {
        this._dir = dir;
    }

    /** UTC `YYYY-MM-DD` key for a wall-clock timestamp in ms. */
    public static dateKey(nowMs: number): string {
        const d = new Date(nowMs);
        if (Number.isNaN(d.getTime())) {
            return 'invalid-date';
        }
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    /** Fresh, all-zero tally for one project. */
    public static emptyProject(): RegistryDayProject {
        return {hits: 0, misses: 0, packuments: 0, tarballs: 0, notFound: 0, errors: 0, packages: {}};
    }

    /**
     * Load one day's accumulated tallies, or an empty day when the file
     * is missing / corrupt. `date` is the UTC `YYYY-MM-DD` key.
     */
    public load(date: string): RegistryDay {
        const file = path.join(this._dir, `${date}.json`);
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as RegistryDay;
            if (parsed && typeof parsed === 'object' && parsed.projects) {
                return parsed;
            }
        } catch {
            // Missing or corrupt — start the day fresh.
        }
        return {date: date, projects: {}};
    }

    /** Atomically persist one day's tallies (write temp + rename). */
    public save(day: RegistryDay): void {
        fs.mkdirSync(this._dir, {recursive: true});
        const file = path.join(this._dir, `${day.date}.json`);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(day));
        fs.renameSync(tmp, file);
    }

    /**
     * Every persisted day within the last `days` days, oldest first,
     * projected to the wire shape (the per-package map is dropped — it
     * only feeds the live mirror table, not the history view).
     * `days <= 0` or a missing dir returns the empty list.
     */
    public readRange(days: number, nowMs: number): ApiRegistryHistoryDay[] {
        if (days <= 0 || !fs.existsSync(this._dir)) {
            return [];
        }
        const cutoffMs = nowMs - (days * 86400_000);
        const out: ApiRegistryHistoryDay[] = [];
        for (const name of fs.readdirSync(this._dir)) {
            if (!name.endsWith('.json')) {
                continue;
            }
            let parsed: RegistryDay;
            try {
                parsed = JSON.parse(fs.readFileSync(path.join(this._dir, name), 'utf-8')) as RegistryDay;
            } catch {
                continue;
            }
            const dayMs = Date.parse(`${parsed.date}T00:00:00Z`);
            if (Number.isNaN(dayMs) || dayMs < cutoffMs) {
                continue;
            }
            out.push({date: parsed.date, projects: RegistryHistoryStore.toStats(parsed)});
        }
        out.sort((a, b) => a.date.localeCompare(b.date));
        return out;
    }

    /** Project a stored day to the sorted `ApiRegistryProjectStat[]` wire shape. */
    public static toStats(day: RegistryDay): ApiRegistryProjectStat[] {
        const stats: ApiRegistryProjectStat[] = [];
        for (const [project, p] of Object.entries(day.projects)) {
            stats.push({
                project: project,
                hits: p.hits,
                misses: p.misses,
                packuments: p.packuments,
                tarballs: p.tarballs,
                notFound: p.notFound,
                errors: p.errors
            });
        }
        stats.sort((a, b) => a.project.localeCompare(b.project));
        return stats;
    }

}