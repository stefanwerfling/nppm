import {JsonCache} from '../Cache/JsonCache.js';

/**
 * The three bundlephobia metrics worth surfacing for an npm
 * dependency. `size` is the minified bundle in bytes; `gzip` is
 * what would travel over the wire; `dependencyCount` counts every
 * transitive package the build would pull in (NOT the same as the
 * lockfile total — bundlephobia walks production deps only).
 */
export type BundleSize = {
    size: number;
    gzip: number;
    dependencyCount: number;
};

/**
 * On-disk envelope so an explicit "asked, no data" (e.g.
 * bundlephobia returned 404 because the package can't be bundled)
 * is distinguishable from a cold-cache miss.
 */
type Wrap = {data: BundleSize|null;};

const DEFAULT_BASE_URL = 'https://bundlephobia.com';
const DEFAULT_CONCURRENCY = 5;

/**
 * Queries the public bundlephobia API for one `pkg@version` at a
 * time and persists the answer in a permanent disk cache (published
 * `name@version` is immutable; a once-computed size is good forever).
 *
 * Most calls return a non-trivial payload, but some packages can't
 * be bundled (CLIs, native bindings, very old releases without an
 * ESM/CJS entry point). Those come back as 404 or as a 200 with no
 * `size` field; both collapse to `null` so the UI can render an
 * em-dash rather than ask again.
 */
export class BundlephobiaFetcher {

    private readonly _baseUrl: string;
    private readonly _cache: JsonCache;
    private readonly _concurrency: number;

    constructor(
        cache: JsonCache,
        opts: {baseUrl?: string; concurrency?: number;} = {}
    ) {
        this._baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
        this._cache = cache;
        this._concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    }

    /**
     * Resolve one `name@version`. Cache-first; on miss, hits
     * bundlephobia once and stores the result (including the
     * explicit-null envelope for "asked, unbuildable").
     */
    public async fetch(name: string, version: string): Promise<BundleSize|null> {
        if (!name || !version) {
            return null;
        }
        const key = BundlephobiaFetcher._cacheKey(name, version);
        const cached = this._cache.get<Wrap>(key);
        if (cached) {
            return cached.data;
        }
        const result = await this._fetchLive(name, version);
        this._cache.set<Wrap>(key, {data: result});
        return result;
    }

    /**
     * Resolve a batch of coordinates in parallel under a bounded
     * concurrency cap. The returned map is keyed by `${name}@${version}`
     * for direct lookup by callers that already have those strings.
     */
    public async fetchMany(packages: {name: string; version: string;}[]): Promise<Map<string, BundleSize|null>> {
        const result = new Map<string, BundleSize|null>();
        const queue = [...packages];

        const runOne = async(): Promise<void> => {
            while (queue.length > 0) {
                const next = queue.shift();
                if (!next) {
                    return;
                }
                const size = await this.fetch(next.name, next.version);
                result.set(`${next.name}@${next.version}`, size);
            }
        };

        const workers: Promise<void>[] = [];
        const n = Math.min(this._concurrency, Math.max(1, packages.length));
        for (let i = 0; i < n; i++) {
            workers.push(runOne());
        }
        await Promise.all(workers);
        return result;
    }

    private async _fetchLive(name: string, version: string): Promise<BundleSize|null> {
        try {
            const url = `${this._baseUrl}/api/size?package=${encodeURIComponent(name)}@${encodeURIComponent(version)}&record=true`;
            const res = await fetch(url, {headers: {Accept: 'application/json'}});
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as {
                size?: unknown;
                gzip?: unknown;
                dependencyCount?: unknown;
            };
            if (typeof raw.size !== 'number' || typeof raw.gzip !== 'number') {
                return null;
            }
            return {
                size: raw.size,
                gzip: raw.gzip,
                dependencyCount: typeof raw.dependencyCount === 'number' ? raw.dependencyCount : 0
            };
        } catch {
            return null;
        }
    }

    /**
     * Sanitise the coordinate into a filename-safe cache key. The
     * filesystem-unfriendly characters in a scoped package name
     * (`@scope/foo`) get collapsed to underscores; including the
     * version makes the cache point-cached across multiple installed
     * versions of the same package.
     */
    private static _cacheKey(name: string, version: string): string {
        const safeName = name.replace(/[^a-zA-Z0-9._@-]/g, '__');
        const safeVer = version.replace(/[^a-zA-Z0-9._@+-]/g, '__');
        return `bundle_${safeName}__${safeVer}`;
    }

}