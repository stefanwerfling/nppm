import {JsonCache} from '../Cache/JsonCache.js';

/**
 * Slice of the CouchDB user document we keep. `tfa` reports whether
 * the publisher account has two-factor auth enabled; `created` is
 * the ISO timestamp of account creation. Either can be `null` when
 * the registry returns the field as missing or in an unparseable
 * shape — distinct from the whole envelope being `null`, which means
 * the registry refused the request entirely (typical 401 on the
 * public mirror).
 */
export type NpmUserDoc = {
    tfa: boolean|null;
    created: string|null;
};

/**
 * On-disk envelope. The inner value is the parsed user doc, or
 * `null` when the registry refused (so a re-fetch within the TTL
 * window doesn't keep hammering the endpoint).
 */
type Wrap = {data: NpmUserDoc|null;};

/**
 * Fetches the CouchDB-style user document at
 * `/-/user/org.couchdb.user:<name>`. Used by `MaintainerScanner`
 * (for the 2FA flag) and the freshness path (for the account-age
 * "brand new" heuristic). Sharing one fetcher across both consumers
 * means one network call per username per TTL window — important
 * because the endpoint often 401s on the public registry and we
 * don't want to hit that wall twice.
 */
export class NpmUserFetcher {

    private readonly _baseUrl: string;
    private readonly _auth: string|undefined;
    private readonly _cache: JsonCache;

    constructor(baseUrl: string, cache: JsonCache, auth?: string) {
        this._baseUrl = baseUrl.replace(/\/$/, '');
        this._auth = auth;
        this._cache = cache;
    }

    /**
     * Resolve the user document for `username`. Cache-first; on miss,
     * hits the registry once and stores the result (including the
     * `null` envelope for "registry refused") so subsequent calls
     * inside the TTL window don't re-fetch.
     */
    public async fetch(username: string): Promise<NpmUserDoc|null> {
        if (!username) {
            return null;
        }
        const key = NpmUserFetcher._cacheKey(username);
        const cached = this._cache.get<Wrap>(key);
        if (cached) {
            return cached.data;
        }

        const result = await this._fetchLive(username);
        this._cache.set<Wrap>(key, {data: result});
        return result;
    }

    private async _fetchLive(username: string): Promise<NpmUserDoc|null> {
        try {
            const url = `${this._baseUrl}/-/user/org.couchdb.user:${encodeURIComponent(username)}`;
            const headers: Record<string, string> = {Accept: 'application/json'};
            if (this._auth) {
                headers.Authorization = `Bearer ${this._auth}`;
            }
            const res = await fetch(url, {headers: headers});
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as {tfa?: unknown; created?: unknown;};
            return {
                tfa: NpmUserFetcher.parseTfa(raw.tfa),
                created: NpmUserFetcher.parseCreated(raw.created)
            };
        } catch {
            return null;
        }
    }

    /**
     * Coerce the user document's `tfa` field into a single boolean.
     * Public for test use.
     *
     *   - `true`                                  → `true`
     *   - `false` / missing                       → `false`
     *   - `{mode: 'auth-only'|'auth-and-writes'}` → `true`
     *   - anything else                           → `null` (don't guess)
     */
    public static parseTfa(value: unknown): boolean|null {
        if (typeof value === 'boolean') {
            return value;
        }
        if (value === undefined || value === null) {
            return false;
        }
        if (typeof value === 'object') {
            const mode = (value as {mode?: unknown;}).mode;
            if (typeof mode === 'string' && mode.length > 0) {
                return true;
            }
            return null;
        }
        return null;
    }

    /**
     * Coerce the user document's `created` field into an ISO
     * timestamp string. The registry returns it as either a top-level
     * string or as `{ts: <ms>, iso: '<iso>'}`; we only need something
     * `Date.parse` can read.
     */
    public static parseCreated(value: unknown): string|null {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
        if (value && typeof value === 'object') {
            const iso = (value as {iso?: unknown;}).iso;
            if (typeof iso === 'string' && iso.length > 0) {
                return iso;
            }
        }
        return null;
    }

    private static _cacheKey(username: string): string {
        return `npmuser_${username}`;
    }

}