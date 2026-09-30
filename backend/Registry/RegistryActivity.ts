import {ApiRegistryLogEntry, ApiRegistryProjectStat} from '../../shared/Api/ApiTypes.js';
import {RegistryDay, RegistryDayProject, RegistryHistoryStore} from './RegistryHistoryStore.js';

/**
 * Activity log + running counters for the registry proxy (step 18.6,
 * per-project extension). Every served request is recorded here so the
 * RegistryView can show a live request feed (store HIT vs upstream MISS
 * vs 404) and per-project tallies.
 *
 * Two layers:
 *  - **Live feed** — a bounded ring buffer replayed to newly-connected
 *    SSE clients plus a fan-out to current subscribers. Purely
 *    ephemeral, exactly as before.
 *  - **Per-project tallies** — accumulated into today's `RegistryDay`
 *    and persisted through an optional `RegistryHistoryStore`. On boot
 *    the current UTC day is loaded back so a restart continues counting
 *    where it left off; a UTC-day rollover flushes the old day and
 *    starts a fresh one. Writes are throttled (coalesced through a
 *    short timer) so a burst of install requests doesn't hammer the
 *    disk. Omit the store for a pure in-memory instance (tests).
 */
export class RegistryActivity {

    private readonly _max: number;
    private readonly _store: RegistryHistoryStore|undefined;
    private readonly _flushDelayMs: number;
    private _buf: ApiRegistryLogEntry[] = [];
    private readonly _subs = new Set<(entry: ApiRegistryLogEntry) => void>();

    private _day: RegistryDay;
    private _dirty = false;
    private _flushTimer: ReturnType<typeof setTimeout>|null = null;

    public constructor(store?: RegistryHistoryStore, maxEntries = 200, flushDelayMs = 1500) {
        this._max = maxEntries;
        this._store = store;
        this._flushDelayMs = flushDelayMs;
        const key = RegistryHistoryStore.dateKey(Date.now());
        this._day = store ? store.load(key) : {date: key, projects: {}};
    }

    /**
     * Record one served request. Feeds both the live ring buffer /
     * subscribers and today's per-project tallies. `entry.project` is
     * the canonical project bucket (`default` for a bare-mount hit).
     */
    public record(entry: ApiRegistryLogEntry): void {
        this._rollIfNeeded(entry.time);
        this._tally(entry);

        this._buf.push(entry);
        if (this._buf.length > this._max) {
            this._buf = this._buf.slice(this._buf.length - this._max);
        }
        for (const sub of this._subs) {
            sub(entry);
        }
        this._scheduleFlush();
    }

    /** Most-recent live entries, oldest first. */
    public recent(): ApiRegistryLogEntry[] {
        return [...this._buf];
    }

    /**
     * Global tarball hit/miss totals for the current day (sum across
     * every project bucket). Kept for the status header's headline
     * numbers.
     */
    public counters(): {hits: number; misses: number;} {
        let hits = 0;
        let misses = 0;
        for (const p of Object.values(this._day.projects)) {
            hits += p.hits;
            misses += p.misses;
        }
        return {hits: hits, misses: misses};
    }

    /** Today's per-project tallies, sorted by project name. */
    public perProject(): ApiRegistryProjectStat[] {
        return RegistryHistoryStore.toStats(this._day);
    }

    /**
     * Per-package store-hit counts for today, summed across every
     * project bucket. Drives the mirror table's "Hits" column.
     */
    public pkgHits(): Map<string, number> {
        const out = new Map<string, number>();
        for (const p of Object.values(this._day.projects)) {
            for (const [name, counts] of Object.entries(p.packages)) {
                out.set(name, (out.get(name) ?? 0) + counts.hits);
            }
        }
        return out;
    }

    /**
     * Subscribe to live entries. Returns an unsubscribe function the
     * SSE handler calls when the client disconnects.
     */
    public subscribe(fn: (entry: ApiRegistryLogEntry) => void): () => void {
        this._subs.add(fn);
        return (): void => {
            this._subs.delete(fn);
        };
    }

    /** Force any pending tallies to disk now (shutdown / tests). */
    public flush(): void {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        if (this._store && this._dirty) {
            this._store.save(this._day);
            this._dirty = false;
        }
    }

    private _bucket(project: string): RegistryDayProject {
        let p = this._day.projects[project];
        if (!p) {
            p = RegistryHistoryStore.emptyProject();
            this._day.projects[project] = p;
        }
        return p;
    }

    private _tally(entry: ApiRegistryLogEntry): void {
        const p = this._bucket(entry.project || 'default');
        if (entry.kind === 'packument') {
            p.packuments++;
        } else if (entry.kind === 'tarball') {
            p.tarballs++;
            const pkg = p.packages[entry.name] ?? {hits: 0, misses: 0};
            if (entry.result === 'hit') {
                p.hits++;
                pkg.hits++;
            } else if (entry.result === 'miss') {
                p.misses++;
                pkg.misses++;
            }
            p.packages[entry.name] = pkg;
        }
        if (entry.result === 'not-found') {
            p.notFound++;
        } else if (entry.result === 'error') {
            p.errors++;
        }
        this._dirty = true;
    }

    /**
     * On a UTC-day boundary, flush the finished day and swap in a fresh
     * (or previously-persisted) tally for the new day.
     */
    private _rollIfNeeded(nowMs: number): void {
        const key = RegistryHistoryStore.dateKey(nowMs);
        if (key === this._day.date) {
            return;
        }
        this.flush();
        this._day = this._store ? this._store.load(key) : {date: key, projects: {}};
    }

    private _scheduleFlush(): void {
        if (!this._store || this._flushTimer) {
            return;
        }
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            this.flush();
        }, this._flushDelayMs);
        // Don't let a pending flush hold the process open on shutdown.
        this._flushTimer.unref?.();
    }

}