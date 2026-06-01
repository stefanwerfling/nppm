import {JsonCache} from '../Cache/JsonCache.js';

/**
 * On-disk envelope used so an explicit "asked, got `null`" is
 * distinguishable from a cold-cache miss in `JsonCache.get`. The
 * inner value is the actual 2FA status: `true` (publish + login both
 * gated by 2FA), `false` (none), or `null` (registry refused to say —
 * usually a 401 from the public mirror, occasionally a 404 for users
 * who never logged in via the website).
 */
type Wrap = {data: boolean|null};

/**
 * Asks the npm-compatible registry whether a given user account has
 * two-factor authentication enabled on publish. Hits the CouchDB-style
 * user document at `/-/user/org.couchdb.user:<name>` and reads the
 * `tfa` field — present and truthy means 2FA is required for at least
 * the publish operation.
 *
 * Most public-registry mirrors require authentication for this
 * endpoint and return 401; the fetcher caches that as `null` so
 * subsequent calls don't re-hit the network for the same TTL window.
 * Private Verdaccio / Nexus mirrors often expose it unauthenticated
 * and yield real booleans — the fetcher works transparently with
 * both.
 */
export class Npm2FaFetcher {

    private readonly _baseUrl: string;
    private readonly _auth: string|undefined;
    private readonly _cache: JsonCache;

    constructor(baseUrl: string, cache: JsonCache, auth?: string) {
        this._baseUrl = baseUrl.replace(/\/$/, '');
        this._auth = auth;
        this._cache = cache;
    }

    /**
     * Resolve the 2FA status for `username`. Cache-first; on miss,
     * hits the registry once and stores the result (including `null`
     * for "unknown") in the envelope cache.
     */
    public async fetch(username: string): Promise<boolean|null> {
        if (!username) {
            return null;
        }
        const key = Npm2FaFetcher._cacheKey(username);
        const cached = this._cache.get<Wrap>(key);
        if (cached) {
            return cached.data;
        }

        const result = await this._fetchLive(username);
        this._cache.set<Wrap>(key, {data: result});
        return result;
    }

    /**
     * Hit the live `/-/user/org.couchdb.user:<name>` document and
     * extract the `tfa` field. npm exposes 2FA as either a boolean or
     * an object with `mode: 'auth-only'|'auth-and-writes'`; both are
     * collapsed to a single boolean for the UI (any non-falsy mode
     * means "2FA is set up on this account").
     *
     * Returns `null` on every non-200 response (auth wall, 404, server
     * error) — those are reported as "unknown" rather than as `false`
     * so the UI doesn't accuse an account of skipping 2FA when we
     * simply couldn't ask.
     */
    private async _fetchLive(username: string): Promise<boolean|null> {
        try {
            const url = `${this._baseUrl}/-/user/org.couchdb.user:${encodeURIComponent(username)}`;
            const headers: Record<string, string> = {Accept: 'application/json'};
            if (this._auth) {
                headers.Authorization = `Bearer ${this._auth}`;
            }
            const res = await fetch(url, {headers});
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as {tfa?: unknown};
            return Npm2FaFetcher.parseTfa(raw.tfa);
        } catch {
            return null;
        }
    }

    /**
     * Coerce the CouchDB user document's `tfa` field into a single
     * boolean. Public for test use.
     *
     *   - `true`                                → `true`
     *   - `false` / missing                     → `false`
     *   - `{mode: 'auth-only'|'auth-and-writes'}` → `true`
     *   - anything else                         → `null` (don't guess)
     */
    public static parseTfa(value: unknown): boolean|null {
        if (typeof value === 'boolean') {
            return value;
        }
        if (value === undefined || value === null) {
            return false;
        }
        if (typeof value === 'object') {
            const mode = (value as {mode?: unknown}).mode;
            if (typeof mode === 'string' && mode.length > 0) {
                return true;
            }
            return null;
        }
        return null;
    }

    private static _cacheKey(username: string): string {
        return `npm2fa_${username}`;
    }
}