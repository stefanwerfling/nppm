import {UpstreamFetcher} from './RegistryProxy.js';

/**
 * Production `UpstreamFetcher` over the global `fetch`. Mirrors the
 * `Registry` client's auth + scope-encoding conventions (keep the `@`,
 * encode the scope slash to `%2f`). Network / parse failures surface as
 * a `502` so the proxy can mirror them without throwing.
 */
export class HttpUpstreamFetcher implements UpstreamFetcher {

    private readonly _base: string;
    private readonly _token: string|undefined;

    public constructor(upstream: string, token: string|undefined) {
        this._base = upstream.replace(/\/+$/u, '');
        this._token = token;
    }

    public async packument(name: string): Promise<{status: number; json: unknown;}> {
        const url = `${this._base}/${encodeURIComponent(name).replace('%40', '@')}`;
        const headers: Record<string, string> = {'Accept': 'application/json', 'User-Agent': 'nppm'};
        if (this._token) {
            headers.Authorization = `Bearer ${this._token}`;
        }
        try {
            const res = await fetch(url, {headers: headers});
            if (!res.ok) {
                return {status: res.status, json: null};
            }
            return {status: res.status, json: await res.json()};
        } catch {
            return {status: 502, json: null};
        }
    }

    public async tarball(url: string): Promise<{status: number; body: Buffer|null;}> {
        const headers: Record<string, string> = {'User-Agent': 'nppm'};
        if (this._token) {
            headers.Authorization = `Bearer ${this._token}`;
        }
        try {
            const res = await fetch(url, {headers: headers});
            if (!res.ok) {
                return {status: res.status, body: null};
            }
            return {status: res.status, body: Buffer.from(await res.arrayBuffer())};
        } catch {
            return {status: 502, body: null};
        }
    }

}