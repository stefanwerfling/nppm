import {JsonCache} from '../../Cache/JsonCache.js';

/**
 * Single-call score response from socket.dev. The free API has shifted
 * shape twice in the past two years; we keep the parser tolerant and
 * pull only what we actually need:
 *
 *  - `score.overall` (0..1) → the headline number the badge shows
 *  - `score.{supplyChain,quality,maintenance,vulnerability,license}` →
 *    five sub-scores rendered in the PackageDetailPanel
 *
 * Anything missing collapses to `null` so a degraded API response
 * doesn't escalate severity. `null` envelope = "we asked, got no
 * useful answer" (rate-limited, 401, malformed); distinct from a doc
 * with `overall: null` ("scored but no data yet").
 */
export type SocketDevScore = {
    overall: number|null;
    supplyChain: number|null;
    quality: number|null;
    maintenance: number|null;
    vulnerability: number|null;
    license: number|null;
};

type Wrap = {data: SocketDevScore|null};

/**
 * Fetches socket.dev's per-package score. Bearer-token authed via the
 * user's `security.external.socket.apiKey` — no key → fetcher returns
 * `null` envelope without making a network call. Cache pocket is the
 * standard TTL one (socket re-scores packages a few times a week; an
 * hour-old number is fine for the dashboard's purposes).
 */
export class SocketDevFetcher {

    private readonly _cache: JsonCache;
    private readonly _apiKey: string|undefined;
    private readonly _baseUrl: string;

    constructor(cache: JsonCache, apiKey?: string, baseUrl = 'https://api.socket.dev') {
        this._cache = cache;
        this._apiKey = apiKey;
        this._baseUrl = baseUrl.replace(/\/$/, '');
    }

    public hasKey(): boolean {
        return typeof this._apiKey === 'string' && this._apiKey.length > 0;
    }

    public async fetch(name: string, version: string): Promise<SocketDevScore|null> {
        if (!name || !version) {
            return null;
        }
        if (!this.hasKey()) {
            return null;
        }
        const key = SocketDevFetcher._cacheKey(name, version);
        const cached = this._cache.get<Wrap>(key);
        if (cached) {
            return cached.data;
        }

        const result = await this._fetchLive(name, version);
        this._cache.set<Wrap>(key, {data: result});
        return result;
    }

    private async _fetchLive(name: string, version: string): Promise<SocketDevScore|null> {
        try {
            const url = `${this._baseUrl}/v0/npm/${encodeURIComponent(name)}/${encodeURIComponent(version)}/score`;
            const res = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${this._apiKey}`
                }
            });
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as unknown;
            return SocketDevFetcher.parseScore(raw);
        } catch {
            return null;
        }
    }

    /**
     * Pull the five sub-scores out of the response. Public for unit
     * tests; tolerates both the old `{score: {…}}` envelope and the
     * newer flat shape socket.dev rolled out in late 2025.
     */
    public static parseScore(raw: unknown): SocketDevScore|null {
        if (!raw || typeof raw !== 'object') {
            return null;
        }
        const obj = raw as Record<string, unknown>;
        const root = (obj.score && typeof obj.score === 'object')
            ? obj.score as Record<string, unknown>
            : obj;
        const pick = (k: string): number|null => {
            const v = root[k];
            return typeof v === 'number' && isFinite(v) ? v : null;
        };
        return {
            overall: pick('overall') ?? pick('score'),
            supplyChain: pick('supplyChain') ?? pick('supply_chain'),
            quality: pick('quality'),
            maintenance: pick('maintenance'),
            vulnerability: pick('vulnerability'),
            license: pick('license')
        };
    }

    private static _cacheKey(name: string, version: string): string {
        return `socket_${name}@${version}`;
    }
}