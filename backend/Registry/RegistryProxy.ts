/**
 * The read side of nppm-as-a-registry (step 18.2). Turns nppm into an
 * npm-compatible registry: it answers packument-metadata requests and
 * tarball requests so `npm install` against nppm's mount path resolves
 * real packages.
 *
 * This module is deliberately store-agnostic. Step 18.3 slots a
 * `.nppm/register/` disk store in front of `getTarball()` so a second
 * install is served offline; here every miss simply passes through to
 * the configured upstream. Two invariants make that split safe:
 *
 *  1. **Integrity is never touched.** The upstream packument's
 *     `dist.integrity` / `dist.shasum` are forwarded verbatim, and the
 *     bytes we return for a tarball are the upstream bytes unchanged —
 *     so npm's lockfile SRI check keeps passing whether the tarball
 *     came from upstream (18.2) or from disk (18.3).
 *  2. **Only `dist.tarball` is rewritten**, pointing every version at
 *     nppm's own mount path so npm fetches tarballs back through us.
 */

/**
 * Injection seam for the upstream HTTP calls. The default
 * `HttpUpstreamFetcher` hits the network; tests pass an in-memory fake
 * so no fixture server is needed.
 */
export interface UpstreamFetcher {

    /**
     * Fetch a raw packument document by package name. `json` is the
     * parsed body (or `null` on a non-2xx / parse failure); `status`
     * is the upstream HTTP status so the caller can mirror 404s.
     */
    packument(name: string): Promise<{status: number; json: unknown;}>;

    /**
     * Fetch raw tarball bytes from an absolute upstream URL. `body` is
     * `null` on a non-2xx response.
     */
    tarball(url: string): Promise<{status: number; body: Buffer|null;}>;
}

/**
 * Offline tarball mirror seam (step 18.3). The `DiskTarballStore` impl
 * persists each fetched tarball under `.nppm/register/`; tests pass an
 * in-memory fake. `read`/`write` round-trip the *original* tarball
 * bytes so integrity stays intact.
 */
export interface TarballStore {

    /** Whether `name@version` is already mirrored on disk. */
    has(name: string, version: string): Promise<boolean>;

    /** Original tarball bytes for `name@version`, or `null` on a miss. */
    read(name: string, version: string): Promise<Buffer|null>;

    /** Persist the original tarball bytes for `name@version`. */
    write(name: string, version: string, tarball: Buffer): Promise<void>;
}

/**
 * Where a served tarball came from — drives the live request log
 * (step 18.6) and lets tests assert the upstream was skipped on a hit.
 */
export type TarballSource = 'store'|'upstream';

/**
 * One cached upstream packument plus the wall-clock time it was
 * fetched, so repeated tarball requests for the same package don't
 * re-hit the upstream for the version→tarball-URL lookup.
 */
type PackumentMemo = {json: unknown; at: number;};

export class RegistryProxy {

    private readonly _fetcher: UpstreamFetcher;
    private readonly _store: TarballStore|undefined;
    private readonly _memoTtlMs: number;
    private readonly _memo = new Map<string, PackumentMemo>();

    /**
     * @param fetcher    upstream HTTP seam (real or fake).
     * @param store      offline tarball mirror; when present, tarball
     *                   hits are served from disk and misses are written
     *                   back after the upstream fetch. Omit to disable
     *                   persistence (pure pass-through).
     * @param memoTtlMs  how long a fetched packument is reused for the
     *                   version→tarball-URL lookup. Short by design so a
     *                   freshly-published version resolves quickly;
     *                   defaults to 60s.
     */
    public constructor(fetcher: UpstreamFetcher, store?: TarballStore, memoTtlMs = 60_000) {
        this._fetcher = fetcher;
        this._store = store;
        this._memoTtlMs = memoTtlMs;
    }

    /**
     * Return the packument for `name` with every `dist.tarball`
     * rewritten to nppm's own mount path (`publicBase` already includes
     * the mount path, e.g. `http://localhost:5190/registry`). Integrity
     * fields are left untouched. `body` is `null` when the upstream
     * didn't return a usable document — the caller mirrors `status`.
     */
    public async getPackument(
        name: string,
        publicBase: string
    ): Promise<{status: number; body: unknown;}> {
        const {status, json} = await this._fetcher.packument(name);
        if (!json || typeof json !== 'object') {
            return {status: status >= 400 ? status : 502, body: null};
        }
        /*
         * Memoise the RAW upstream document (original `dist.tarball`
         * URLs) — `_resolveTarballUrl` reads it to find where to fetch
         * a tarball from. The rewrite happens on a *clone* returned to
         * the client, so we never poison the memo with our own mount
         * URLs (which would make `getTarball` fetch nppm itself in an
         * endless loop).
         */
        this._memo.set(name, {json: json, at: Date.now()});
        const rewritten = structuredClone(json) as Record<string, unknown>;
        RegistryProxy._rewriteTarballs(name, rewritten, publicBase);
        return {status: 200, body: rewritten};
    }

    /**
     * Return the raw tarball bytes for `name@version`. On a store hit
     * the disk mirror answers and the upstream is skipped entirely
     * (offline path). On a miss the upstream `dist.tarball` is resolved
     * (via the memoised packument), fetched verbatim, then written back
     * to the store best-effort before the bytes are returned. `body` is
     * `null` when the version is unknown or the upstream fetch failed;
     * `source` reports which path served the bytes.
     */
    public async getTarball(
        name: string,
        version: string
    ): Promise<{status: number; body: Buffer|null; source?: TarballSource;}> {
        if (this._store && await this._store.has(name, version)) {
            const cached = await this._store.read(name, version);
            if (cached) {
                return {status: 200, body: cached, source: 'store'};
            }
        }
        const url = await this._resolveTarballUrl(name, version);
        if (!url) {
            return {status: 404, body: null};
        }
        const {status, body} = await this._fetcher.tarball(url);
        if (body && this._store) {
            /*
             * Best-effort persist — a write failure (full disk, races)
             * must not break the install that already has its bytes.
             */
            try {
                await this._store.write(name, version, body);
            } catch {
                // swallow — the tarball is still returned to the client.
            }
        }
        return {status: status, body: body, source: 'upstream'};
    }

    /**
     * Look up the upstream `dist.tarball` URL for one version, reusing a
     * fresh memoised packument when available, otherwise re-fetching.
     */
    private async _resolveTarballUrl(name: string, version: string): Promise<string|null> {
        let doc = this._freshMemo(name);
        if (!doc) {
            const {json} = await this._fetcher.packument(name);
            if (!json || typeof json !== 'object') {
                return null;
            }
            doc = json;
            this._memo.set(name, {json: json, at: Date.now()});
        }
        const dist = RegistryProxy._distFor(doc as Record<string, unknown>, version);
        const tarball = dist && typeof dist.tarball === 'string' ? dist.tarball : null;
        return tarball;
    }

    private _freshMemo(name: string): unknown|null {
        const memo = this._memo.get(name);
        if (!memo) {
            return null;
        }
        if (Date.now() - memo.at > this._memoTtlMs) {
            this._memo.delete(name);
            return null;
        }
        return memo.json;
    }

    /**
     * Mutate every `versions[*].dist.tarball` in place to point at
     * `<publicBase>/<name>/-/<unscoped>-<version>.tgz`. The scope slash
     * stays literal (classic npm tarball-URL form); our own path parser
     * splits on `/-/` so a literal slash in the scope is unambiguous.
     */
    private static _rewriteTarballs(
        name: string,
        doc: Record<string, unknown>,
        publicBase: string
    ): void {
        const versions = doc.versions;
        if (!versions || typeof versions !== 'object') {
            return;
        }
        const unscoped = RegistryProxy.unscopedName(name);
        const base = publicBase.replace(/\/+$/u, '');
        for (const [version, raw] of Object.entries(versions as Record<string, unknown>)) {
            if (!raw || typeof raw !== 'object') {
                continue;
            }
            const dist = (raw as Record<string, unknown>).dist;
            if (!dist || typeof dist !== 'object') {
                continue;
            }
            (dist as Record<string, unknown>).tarball = `${base}/${name}/-/${unscoped}-${version}.tgz`;
        }
    }

    private static _distFor(
        doc: Record<string, unknown>,
        version: string
    ): Record<string, unknown>|null {
        const versions = doc.versions;
        if (!versions || typeof versions !== 'object') {
            return null;
        }
        const entry = (versions as Record<string, unknown>)[version];
        if (!entry || typeof entry !== 'object') {
            return null;
        }
        const dist = (entry as Record<string, unknown>).dist;
        return dist && typeof dist === 'object' ? dist as Record<string, unknown> : null;
    }

    /**
     * Strip the `@scope/` prefix from a package name — npm's tarball
     * filenames use the unscoped name (`@babel/core` → `core`).
     */
    public static unscopedName(name: string): string {
        const slash = name.indexOf('/');
        return slash >= 0 ? name.slice(slash + 1) : name;
    }

    /**
     * Extract the version out of an npm tarball filename
     * `<unscoped>-<version>.tgz`. Returns `null` when the file doesn't
     * match the expected `<unscoped>-` prefix / `.tgz` suffix.
     */
    public static versionFromTarballFile(name: string, file: string): string|null {
        const prefix = `${RegistryProxy.unscopedName(name)}-`;
        if (!file.startsWith(prefix) || !file.endsWith('.tgz')) {
            return null;
        }
        const version = file.slice(prefix.length, -'.tgz'.length);
        return version.length > 0 ? version : null;
    }

}