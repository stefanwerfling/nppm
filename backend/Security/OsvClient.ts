import {JsonCache} from '../Cache/JsonCache.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';

/**
 * Stripped-down vulnerability record kept on disk. OSV returns a much
 * larger envelope (affected ranges, ecosystem-specific details, db
 * provenance); we only persist the fields the UI renders so the cache
 * stays compact across hundreds of packages.
 */
export type OsvVulnerability = {
    id: string;
    summary: string;
    details: string;
    severity: {type: string; score: string;}[];
    references: {type: string; url: string;}[];
    published: string|null;
    modified: string|null;
};

/**
 * Raw shape we accept from `POST /v1/query`. OSV is generous with
 * optional fields, so everything past `id` is treated as best-effort.
 */
type OsvRawVuln = {
    id: string;
    summary?: string;
    details?: string;
    severity?: {type?: string; score?: string;}[];
    references?: {type?: string; url?: string;}[];
    published?: string;
    modified?: string;
};

type OsvRawResponse = {
    vulns?: OsvRawVuln[];
};

/**
 * One coordinate in a batch query. `key` = `${name}@${version}` is used
 * as the result map's key (callers can re-derive it, but having a
 * single canonical form keeps cache + API in sync).
 */
export type OsvBatchPackage = {
    name: string;
    version: string;
};

/**
 * Result of the batch endpoint per package — only the vuln IDs. For
 * the full record (summary, severity, references) the caller hits the
 * single-query endpoint.
 */
type OsvBatchRawResult = {
    vulns?: {id: string;}[];
};

type OsvBatchRawResponse = {
    results?: OsvBatchRawResult[];
};

/**
 * Strategy for issuing the OSV.dev POSTs. Two operations because the
 * batch endpoint has a different URL + response shape. Tests inject
 * stubs so the suite stays offline.
 */
export type OsvFetcher = (body: object) => Promise<OsvRawResponse>;
export type OsvBatchFetcher = (body: object) => Promise<OsvBatchRawResponse>;

/**
 * Cap on the number of queries per outgoing batch request. OSV does not
 * publish a hard limit, but very large bodies are slow and risk
 * partial failures — chunk it.
 */
const BATCH_CHUNK = 100;

/**
 * Client for OSV.dev's vulnerability database. No token required; one
 * request per `pkg@version`, cached on disk with the regular TTL (the
 * vuln set for a published version is mostly stable but new CVEs can
 * still be filed against it, so permanent caching would be wrong).
 *
 * Cache envelope: `{data: OsvVulnerability[] | null}`. `null` is used
 * when the OSV call failed (network / 5xx) — distinct from `[]` which
 * means "OSV answered, no known vulns". Both forms cache; on the next
 * read we either re-use the empty list or re-fetch the `null` once the
 * TTL expires.
 */
export class OsvClient {

    private readonly _cache: JsonCache|null;
    private readonly _fetcher: OsvFetcher;
    private readonly _batchFetcher: OsvBatchFetcher;

    constructor(
        cache: JsonCache|null,
        fetcher?: OsvFetcher,
        baseUrl = 'https://api.osv.dev',
        batchFetcher?: OsvBatchFetcher
    ) {
        const clean = baseUrl.replace(/\/$/, '');
        this._cache = cache;
        this._fetcher = fetcher ?? OsvClient._defaultFetcher(clean);
        this._batchFetcher = batchFetcher ?? OsvClient._defaultBatchFetcher(clean);
    }

    private static _defaultFetcher(baseUrl: string): OsvFetcher {
        return async(body) => {
            const res = await fetch(`${baseUrl}/v1/query`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                throw new Error(`OSV ${res.status} ${res.statusText}`);
            }

            return (await res.json()) as OsvRawResponse;
        };
    }

    private static _defaultBatchFetcher(baseUrl: string): OsvBatchFetcher {
        return async(body) => {
            const res = await fetch(`${baseUrl}/v1/querybatch`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                throw new Error(`OSV batch ${res.status} ${res.statusText}`);
            }

            return (await res.json()) as OsvBatchRawResponse;
        };
    }

    /**
     * Batched ID-only lookup for the matrix badge. Cache layering:
     *  1. Hit the single-query cache (`osv_${name}@${version}`) and
     *     extract IDs — full records cost the same once they exist.
     *  2. For misses, hit a lighter cache pocket (`osv_b_v1_...`)
     *     that stores just `{data: string[]|null}`.
     *  3. Everything still missing goes into a `/v1/querybatch` POST.
     * The single-cache and the batch-cache stay separate because the
     * single endpoint returns rich records and the batch only IDs —
     * trying to share would lose information one way or the other.
     */
    public async queryBatch(packages: OsvBatchPackage[]): Promise<Map<string, string[]|null>> {
        const out = new Map<string, string[]|null>();
        const toFetch: OsvBatchPackage[] = [];

        type FullWrap = {data: OsvVulnerability[]|null;};
        type IdWrap = {data: string[]|null;};

        for (const pkg of packages) {
            const key = `${pkg.name}@${pkg.version}`;

            /*
             * OSV doesn't index git-installed deps — skip them so the
             * batch doesn't carry junk queries that always return [].
             */
            if (GitResolver.isGitVersion(pkg.version)) {
                out.set(key, []);
                continue;
            }

            if (this._cache) {
                const full = this._cache.get<FullWrap>(`osv_${key}`);
                if (full !== null) {
                    out.set(key, full.data === null ? null : full.data.map((v) => v.id));
                    continue;
                }

                const ids = this._cache.get<IdWrap>(`osv_b_v1_${key}`);
                if (ids !== null) {
                    out.set(key, ids.data);
                    continue;
                }
            }

            toFetch.push(pkg);
        }

        /*
         * Chunk + fire in parallel. OSV doesn't formally limit batches but
         * large bodies are slow and partial failures are easier to handle
         * per-chunk.
         */
        for (let i = 0; i < toFetch.length; i += BATCH_CHUNK) {
            const chunk = toFetch.slice(i, i + BATCH_CHUNK);
            await this._runBatchChunk(chunk, out);
        }

        return out;
    }

    private async _runBatchChunk(chunk: OsvBatchPackage[], out: Map<string, string[]|null>): Promise<void> {
        type IdWrap = {data: string[]|null;};

        try {
            const raw = await this._batchFetcher({
                queries: chunk.map((p) => ({
                    package: {name: p.name, ecosystem: 'npm'},
                    version: p.version
                }))
            });

            const results = raw.results ?? [];

            for (let i = 0; i < chunk.length; i++) {
                const pkg = chunk[i];
                const key = `${pkg.name}@${pkg.version}`;
                const ids = (results[i]?.vulns ?? []).map((v) => v.id);
                this._cache?.set<IdWrap>(`osv_b_v1_${key}`, {data: ids});
                out.set(key, ids);
            }
        } catch {
            /*
             * Whole chunk failed — store nulls so we don't retry on
             * every page reload. Next TTL window will refetch.
             */
            for (const pkg of chunk) {
                const key = `${pkg.name}@${pkg.version}`;
                this._cache?.set<IdWrap>(`osv_b_v1_${key}`, {data: null});
                out.set(key, null);
            }
        }
    }

    public async query(name: string, version: string): Promise<OsvVulnerability[]|null> {
        /*
         * OSV.dev only indexes published-to-registry versions. A
         * `git+https://...` install has no ecosystem-version key OSV
         * could match against, so don't waste a request.
         */
        if (GitResolver.isGitVersion(version)) {
            return [];
        }

        const key = `osv_${name}@${version}`;
        type Wrap = {data: OsvVulnerability[]|null;};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(key);
            if (hit !== null) {
                return hit.data;
            }
        }

        try {
            const raw = await this._fetcher({
                package: {name: name, ecosystem: 'npm'},
                version: version
            });

            const vulns = (raw.vulns ?? []).map(OsvClient._normalize);
            this._cache?.set<Wrap>(key, {data: vulns});
            return vulns;
        } catch {
            this._cache?.set<Wrap>(key, {data: null});
            return null;
        }
    }

    private static _normalize(v: OsvRawVuln): OsvVulnerability {
        return {
            id: v.id,
            summary: v.summary ?? '',
            details: v.details ?? '',
            severity: (v.severity ?? []).map((s) => ({
                type: s.type ?? '',
                score: s.score ?? ''
            })),
            references: (v.references ?? []).map((r) => ({
                type: r.type ?? '',
                url: r.url ?? ''
            })),
            published: v.published ?? null,
            modified: v.modified ?? null
        };
    }

}