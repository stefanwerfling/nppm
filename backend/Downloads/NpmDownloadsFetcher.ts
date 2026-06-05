import {JsonCache} from '../Cache/JsonCache.js';

/**
 * Per-name weekly download count from the npm public downloads API.
 * `null` means the API answered without data (very new packages,
 * unscoped names typo'd, or private packages that aren't on the
 * public registry).
 */
type Wrap = {data: number|null};

/**
 * Optional progress callback fired per batch — lets the Dashboard
 * SSE handler surface "fetched 256 / 1424 downloads" so a cold-cache
 * run doesn't look frozen.
 */
export type DownloadsProgress = (fetched: number, total: number) => void;

/**
 * Fetches last-week download counts from
 * `https://api.npmjs.org/downloads/point/last-week/<pkg>`. The bulk
 * endpoint accepts a comma-separated list (up to 128 unscoped
 * packages per call); scoped names like `@babel/core` must be fetched
 * individually because the bulk endpoint rejects them.
 *
 * Disk-cached per name via the standard JsonCache pocket. Downloads
 * are stable on a daily basis so a 24h TTL is plenty — the
 * permanent flag is *not* set because counts shift slowly over time
 * and the user wants the trend chart to reflect that.
 */
export class NpmDownloadsFetcher {

    private readonly _cache: JsonCache;
    private readonly _baseUrl: string;
    private readonly _bulkSize: number;

    constructor(cache: JsonCache, baseUrl = 'https://api.npmjs.org', bulkSize = 128) {
        this._cache = cache;
        this._baseUrl = baseUrl.replace(/\/$/, '');
        this._bulkSize = bulkSize;
    }

    /**
     * Resolve every name to a last-week downloads count. Cache hits
     * short-circuit; misses are batched (bulk for unscoped, one-at-
     * a-time for scoped). Network failures cache as the `null`
     * envelope so a flaky run doesn't keep re-hitting the API for the
     * rest of the day.
     */
    public async fetchMany(
        names: string[],
        progress?: DownloadsProgress
    ): Promise<Map<string, number|null>> {
        const out = new Map<string, number|null>();
        const unique = Array.from(new Set(names));
        const misses: string[] = [];
        for (const n of unique) {
            const cached = this._cache.get<Wrap>(NpmDownloadsFetcher._cacheKey(n));
            if (cached) {
                out.set(n, cached.data);
                continue;
            }
            misses.push(n);
        }

        const total = misses.length;
        let done = 0;
        const tick = (n: number): void => {
            done += n;
            progress?.(done, total);
        };

        const scoped = misses.filter((n) => n.startsWith('@'));
        const unscoped = misses.filter((n) => !n.startsWith('@'));

        // Bulk-fetch unscoped names. npm's bulk endpoint replies with
        // a `{name: {downloads, package, ...}}` map; absent names land
        // as `null` and we cache the negative so repeat misses don't
        // keep hammering the API.
        for (let i = 0; i < unscoped.length; i += this._bulkSize) {
            const batch = unscoped.slice(i, i + this._bulkSize);
            const map = await this._fetchBulk(batch);
            for (const name of batch) {
                const v = map.get(name) ?? null;
                out.set(name, v);
                this._cache.set<Wrap>(NpmDownloadsFetcher._cacheKey(name), {data: v});
            }
            tick(batch.length);
        }

        // Scoped names — one HTTP each. Concurrency-cap at 10 mirrors
        // the registry fetcher so we don't open a thousand sockets on
        // a cold-cache run against a workspace full of @types/* deps.
        const queue = [...scoped];
        const workers: Promise<void>[] = [];
        const runOne = async (): Promise<void> => {
            while (queue.length > 0) {
                const name = queue.shift();
                if (name === undefined) {
                    return;
                }
                const v = await this._fetchOne(name);
                out.set(name, v);
                this._cache.set<Wrap>(NpmDownloadsFetcher._cacheKey(name), {data: v});
                tick(1);
            }
        };
        for (let i = 0; i < 10; i++) {
            workers.push(runOne());
        }
        await Promise.all(workers);

        return out;
    }

    private async _fetchBulk(names: string[]): Promise<Map<string, number|null>> {
        const result = new Map<string, number|null>();
        if (names.length === 0) {
            return result;
        }
        try {
            const url = `${this._baseUrl}/downloads/point/last-week/${names.join(',')}`;
            const res = await fetch(url, {headers: {Accept: 'application/json'}});
            if (!res.ok) {
                for (const n of names) {
                    result.set(n, null);
                }
                return result;
            }
            const raw = await res.json() as unknown;
            // Single-name batches respond with the bare object instead
            // of a {name: object} map — collapse both shapes here.
            if (names.length === 1 && raw && typeof raw === 'object' && 'downloads' in raw) {
                const d = (raw as {downloads?: unknown}).downloads;
                result.set(names[0], typeof d === 'number' ? d : null);
                return result;
            }
            if (raw && typeof raw === 'object') {
                for (const n of names) {
                    const entry = (raw as Record<string, unknown>)[n];
                    if (entry && typeof entry === 'object' && 'downloads' in entry) {
                        const d = (entry as {downloads?: unknown}).downloads;
                        result.set(n, typeof d === 'number' ? d : null);
                    } else {
                        result.set(n, null);
                    }
                }
            } else {
                for (const n of names) {
                    result.set(n, null);
                }
            }
        } catch {
            for (const n of names) {
                result.set(n, null);
            }
        }
        return result;
    }

    private async _fetchOne(name: string): Promise<number|null> {
        try {
            const url = `${this._baseUrl}/downloads/point/last-week/${name}`;
            const res = await fetch(url, {headers: {Accept: 'application/json'}});
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as {downloads?: unknown};
            return typeof raw.downloads === 'number' ? raw.downloads : null;
        } catch {
            return null;
        }
    }

    /**
     * Daily downloads over a fixed window — drives the per-package
     * Trends tab's downloads line. `period` is npm's own preset
     * (`last-week` / `last-month` / `last-year`); we don't accept
     * arbitrary ranges because the upstream API caps a single call
     * at ~365 days and the preset short-circuits the math.
     *
     * Cached under its own key so it doesn't collide with the
     * `last-week` point fetched by `fetchMany`. Cache TTL applies
     * (the JsonCache the constructor was given decides).
     */
    public async fetchRange(
        name: string,
        period: 'last-week'|'last-month'|'last-year' = 'last-year'
    ): Promise<{day: string; downloads: number}[]|null> {
        const key = `range_${period}_${name}`;
        const cached = this._cache.get<{data: {day: string; downloads: number}[]|null}>(key);
        if (cached) {
            return cached.data;
        }
        let result: {day: string; downloads: number}[]|null = null;
        try {
            const url = `${this._baseUrl}/downloads/range/${period}/${name}`;
            const res = await fetch(url, {headers: {Accept: 'application/json'}});
            if (res.ok) {
                const raw = await res.json() as {downloads?: unknown};
                if (Array.isArray(raw.downloads)) {
                    result = [];
                    for (const row of raw.downloads) {
                        if (row && typeof row === 'object'
                            && typeof (row as {day?: unknown}).day === 'string'
                            && typeof (row as {downloads?: unknown}).downloads === 'number') {
                            result.push({
                                day: (row as {day: string}).day,
                                downloads: (row as {downloads: number}).downloads
                            });
                        }
                    }
                }
            }
        } catch {
            result = null;
        }
        this._cache.set(key, {data: result});
        return result;
    }

    /**
     * Cache key sanitiser — scoped names contain `/` which JsonCache
     * already maps onto its filename scheme via Cache.set, but adding
     * the `dl_` prefix keeps the downloads pocket distinct from any
     * future use of the same JsonCache directory.
     */
    private static _cacheKey(name: string): string {
        return `dl_${name}`;
    }
}