import {JsonCache} from '../Cache/JsonCache.js';

/**
 * Coerce a registry-level `repository` value into a single URL/
 * shorthand string. npm allows three shapes:
 *   - `{ type: 'git', url: 'git+https://...' }`
 *   - `'owner/repo'` (npm shorthand)
 *   - `'git+https://...'` (bare URL)
 * Everything else collapses to `undefined`.
 */
function extractRepository(raw: unknown): string|undefined {
    if (typeof raw === 'string') {
        return raw;
    }
    if (raw && typeof raw === 'object') {
        const url = (raw as {url?: unknown}).url;
        if (typeof url === 'string') {
            return url;
        }
    }
    return undefined;
}

/**
 * Just the bits of the npm registry metadata response we actually
 * consume — `dist-tags.latest` and the keys of `versions` (we don't
 * need the per-version object, only that the version was published).
 * `time` carries publish timestamps keyed by version string and is
 * later used by the scanner for "sudden change" heuristics.
 */
export type RegistryPackage = {
    name: string;
    latest: string|null;
    versions: string[];
    time?: Record<string, string>;
    /**
     * Raw `repository` value as the registry returns it — typically a
     * git URL (`git+https://github.com/...`) but may be the npm
     * shorthand (`owner/repo`) or absent. Downstream code parses
     * this; we keep the raw string so the parser stays in one place.
     */
    repository?: string;
    description?: string;
    homepage?: string;
};

/**
 * Fetches package metadata from an npm-compatible registry. Backed by
 * a disk JSON cache so a UI reload does not hammer the registry.
 */
export class Registry {

    private readonly _baseUrl: string;
    private readonly _auth: string|undefined;
    private readonly _cache: JsonCache;
    private readonly _concurrency: number;

    constructor(baseUrl: string, cache: JsonCache, auth?: string, concurrency = 10) {
        this._baseUrl = baseUrl.replace(/\/$/, '');
        this._auth = auth;
        this._cache = cache;
        this._concurrency = concurrency;
    }

    public async fetchOne(name: string): Promise<RegistryPackage|null> {
        const cached = this._cache.get<RegistryPackage>(name);

        if (cached) {
            return cached;
        }

        try {
            const url = `${this._baseUrl}/${encodeURIComponent(name).replace('%40', '@')}`;
            const headers: Record<string, string> = {Accept: 'application/json'};

            if (this._auth) {
                headers.Authorization = `Bearer ${this._auth}`;
            }

            const res = await fetch(url, {headers});

            if (!res.ok) {
                return null;
            }

            const raw = await res.json() as {
                name?: string;
                'dist-tags'?: {latest?: string};
                versions?: Record<string, unknown>;
                time?: Record<string, string>;
                repository?: unknown;
                description?: unknown;
                homepage?: unknown;
            };

            const pkg: RegistryPackage = {
                name: raw.name ?? name,
                latest: raw['dist-tags']?.latest ?? null,
                versions: raw.versions ? Object.keys(raw.versions) : [],
                time: raw.time,
                repository: extractRepository(raw.repository),
                description: typeof raw.description === 'string' ? raw.description : undefined,
                homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined
            };

            this._cache.set(name, pkg);
            return pkg;
        } catch {
            return null;
        }
    }

    /**
     * Resolve a list of package names in parallel, capped by the
     * configured concurrency. Returns a map keyed by name; failed
     * lookups (404, network error) land as `null`.
     */
    public async fetchMany(names: string[]): Promise<Map<string, RegistryPackage|null>> {
        const result = new Map<string, RegistryPackage|null>();
        const queue = [...new Set(names)];

        const workers: Promise<void>[] = [];

        const runOne = async (): Promise<void> => {
            while (queue.length > 0) {
                const name = queue.shift();

                if (name === undefined) {
                    return;
                }

                result.set(name, await this.fetchOne(name));
            }
        };

        for (let i = 0; i < this._concurrency; i++) {
            workers.push(runOne());
        }

        await Promise.all(workers);
        return result;
    }
}