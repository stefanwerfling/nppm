import {JsonCache} from '../Cache/JsonCache.js';

/**
 * Per-version publisher record. `name` is the npm username from
 * `_npmUser`; `email` is best-effort and frequently absent on old
 * versions. Missing for very old packages (pre-2014) where the
 * registry never recorded `_npmUser` — those entries are simply
 * omitted from the map.
 */
export type RegistryPublisher = {
    name: string;
    email?: string;
};

/**
 * Per-version distribution metadata as the registry currently serves
 * it. `tarball` is the URL the registry advertises; `integrity` is
 * the SRI hash (typically `sha512-…` for modern publishes, `sha1-…`
 * for very old ones). `IntegrityScanner` compares these to whatever
 * the project's lockfile has pinned to detect mirror-hijack /
 * dependency-confusion / lockfile-tampering.
 */
export type RegistryDist = {
    tarball: string;
    integrity?: string;
};

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
    /**
     * Top-level SPDX license string from the packument. Most npm
     * packages declare a single SPDX identifier here (`MIT`, `Apache-2.0`,
     * …); some use SPDX expressions (`(MIT OR Apache-2.0)`); proprietary
     * packages typically carry `UNLICENSED` or `SEE LICENSE IN …`.
     * Absent on very old packages where the license lived in
     * `licenses[]` (legacy format) — the scanner handles that fallback.
     */
    license?: string;
    /**
     * Per-version publisher (`_npmUser`), keyed by version string.
     * Used by `MaintainerScanner` to detect account-takeover patterns.
     * Optional: old cache entries lack the field until they age out of
     * the TTL window; versions without a recorded publisher are simply
     * absent from the map.
     */
    publishers?: Record<string, RegistryPublisher>;
    /**
     * Per-version `dist` block (tarball URL + integrity SRI hash).
     * Used by `IntegrityScanner` to cross-check the lockfile's pinned
     * `resolved` + `integrity` against what the registry currently
     * serves. Optional: cache entries written before the field was
     * added lack it and the scanner reports such packages as
     * "registry data unavailable" until the TTL refresh fills it in.
     */
    dist?: Record<string, RegistryDist>;
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
                license?: unknown;
                licenses?: unknown;
            };

            const pkg: RegistryPackage = {
                name: raw.name ?? name,
                latest: raw['dist-tags']?.latest ?? null,
                versions: raw.versions ? Object.keys(raw.versions) : [],
                time: raw.time,
                repository: Registry._extractRepository(raw.repository),
                description: typeof raw.description === 'string' ? raw.description : undefined,
                homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
                license: Registry._extractLicense(raw.license, raw.licenses),
                publishers: Registry._extractPublishers(raw.versions),
                dist: Registry._extractDist(raw.versions)
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

    /**
     * Coerce a registry-level `repository` value into a single URL /
     * shorthand string. npm allows three shapes:
     *   - `{ type: 'git', url: 'git+https://...' }`
     *   - `'owner/repo'` (npm shorthand)
     *   - `'git+https://...'` (bare URL)
     * Everything else collapses to `undefined`.
     */
    private static _extractRepository(raw: unknown): string|undefined {
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
     * Coerce the npm packument's `license` field into a single
     * SPDX-style string. npm allows three legacy shapes:
     *   - `license: "MIT"` (modern, what we want)
     *   - `license: {type: "MIT", url: "…"}` (deprecated object form)
     *   - `licenses: [{type: "MIT"}, {type: "Apache-2.0"}]` (legacy
     *     array, interpreted as a dual-license = SPDX OR expression)
     * Returns `undefined` when none of the above yield a usable
     * string — `LicenseScanner` treats that as `unknown`.
     */
    private static _extractLicense(license: unknown, licenses: unknown): string|undefined {
        if (typeof license === 'string' && license.length > 0) {
            return license;
        }
        if (license && typeof license === 'object') {
            const type = (license as {type?: unknown}).type;
            if (typeof type === 'string' && type.length > 0) {
                return type;
            }
        }
        if (Array.isArray(licenses) && licenses.length > 0) {
            const ids = licenses
                .map((l) => {
                    if (typeof l === 'string') {
                        return l;
                    }
                    if (l && typeof l === 'object') {
                        const t = (l as {type?: unknown}).type;
                        return typeof t === 'string' ? t : null;
                    }
                    return null;
                })
                .filter((s): s is string => typeof s === 'string' && s.length > 0);
            if (ids.length === 1) {
                return ids[0];
            }
            if (ids.length > 1) {
                return `(${ids.join(' OR ')})`;
            }
        }
        return undefined;
    }

    /**
     * Pull `_npmUser` out of each version object in the packument.
     * Versions without `_npmUser` (very old releases) are skipped;
     * the resulting map only contains versions we actually have a
     * publisher for. Returns `undefined` when nothing usable was
     * found, so the field stays absent in the cached envelope.
     */
    /**
     * Pull the `dist` block out of each version object. We keep only
     * the two fields the integrity scanner needs (`tarball` URL and
     * `integrity` SRI hash); the rest of npm's `dist` envelope
     * (`shasum`, `fileCount`, `unpackedSize`, `signatures`, …) is
     * ignored to keep the cached payload compact. Returns `undefined`
     * when no usable `dist` blocks were found so the field stays
     * absent in the cache.
     */
    private static _extractDist(versions: unknown): Record<string, RegistryDist>|undefined {
        if (!versions || typeof versions !== 'object') {
            return undefined;
        }

        const out: Record<string, RegistryDist> = {};
        let any = false;

        for (const [version, entry] of Object.entries(versions as Record<string, unknown>)) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const dist = (entry as {dist?: unknown}).dist;
            if (!dist || typeof dist !== 'object') {
                continue;
            }
            const d = dist as {tarball?: unknown; integrity?: unknown};
            if (typeof d.tarball !== 'string' || d.tarball.length === 0) {
                continue;
            }
            out[version] = typeof d.integrity === 'string' && d.integrity.length > 0
                ? {tarball: d.tarball, integrity: d.integrity}
                : {tarball: d.tarball};
            any = true;
        }

        return any ? out : undefined;
    }

    private static _extractPublishers(versions: unknown): Record<string, RegistryPublisher>|undefined {
        if (!versions || typeof versions !== 'object') {
            return undefined;
        }

        const out: Record<string, RegistryPublisher> = {};
        let any = false;

        for (const [version, entry] of Object.entries(versions as Record<string, unknown>)) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const user = (entry as {_npmUser?: unknown})._npmUser;
            if (!user || typeof user !== 'object') {
                continue;
            }
            const u = user as {name?: unknown; email?: unknown};
            if (typeof u.name !== 'string' || u.name.length === 0) {
                continue;
            }
            out[version] = typeof u.email === 'string'
                ? {name: u.name, email: u.email}
                : {name: u.name};
            any = true;
        }

        return any ? out : undefined;
    }
}