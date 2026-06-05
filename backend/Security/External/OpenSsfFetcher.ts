import {JsonCache} from '../../Cache/JsonCache.js';

/**
 * Repo identity the OpenSSF Scorecard API expects: host + owner +
 * repo. Only github / gitlab / bitbucket are supported by the upstream
 * service; other hosts always return null.
 */
export type ScorecardRepo = {
    host: 'github.com'|'gitlab.com'|'bitbucket.org';
    owner: string;
    repo: string;
};

/**
 * Subset of the Scorecard API response. The full doc has ~20 checks;
 * we surface the top-level score plus the per-check names + scores
 * (clamped 0..10) so the PackageDetailPanel can list the worst-rated
 * areas. `null` overall means "scorecard reachable but score not yet
 * computed for this repo".
 */
export type ScorecardResult = {
    score: number|null;
    checks: {name: string; score: number; reason?: string}[];
    repoUrl: string;
};

type Wrap = {data: ScorecardResult|null};

/**
 * Fetches the OpenSSF Scorecard for a given repo. The public API
 * (`api.securityscorecards.dev`) covers ~1 M precomputed repos; misses
 * return 404 which we cache as the `null` envelope so we don't keep
 * asking. No auth — the service is free and rate-limited per IP.
 */
export class OpenSsfFetcher {

    private readonly _cache: JsonCache;
    private readonly _baseUrl: string;

    constructor(cache: JsonCache, baseUrl = 'https://api.securityscorecards.dev') {
        this._cache = cache;
        this._baseUrl = baseUrl.replace(/\/$/, '');
    }

    public async fetch(repo: ScorecardRepo): Promise<ScorecardResult|null> {
        const key = OpenSsfFetcher._cacheKey(repo);
        const cached = this._cache.get<Wrap>(key);
        if (cached) {
            return cached.data;
        }

        const result = await this._fetchLive(repo);
        this._cache.set<Wrap>(key, {data: result});
        return result;
    }

    private async _fetchLive(repo: ScorecardRepo): Promise<ScorecardResult|null> {
        try {
            const url = `${this._baseUrl}/projects/${repo.host}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
            const res = await fetch(url, {headers: {Accept: 'application/json'}});
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as unknown;
            return OpenSsfFetcher.parseResult(raw);
        } catch {
            return null;
        }
    }

    /**
     * Parse the Scorecard API response. Public for tests. Tolerates
     * partial docs — missing `checks[]` collapses to an empty list, the
     * top-level `score` is read as a number or coerced to null.
     */
    public static parseResult(raw: unknown): ScorecardResult|null {
        if (!raw || typeof raw !== 'object') {
            return null;
        }
        const obj = raw as Record<string, unknown>;
        const scoreRaw = obj.score;
        const score = typeof scoreRaw === 'number' && isFinite(scoreRaw) ? scoreRaw : null;
        const repoObj = obj.repo as Record<string, unknown>|undefined;
        const repoUrl = typeof repoObj?.name === 'string' ? repoObj.name as string : '';
        const checksRaw = Array.isArray(obj.checks) ? obj.checks : [];
        const checks: ScorecardResult['checks'] = [];
        for (const c of checksRaw) {
            if (!c || typeof c !== 'object') {
                continue;
            }
            const cc = c as Record<string, unknown>;
            const name = typeof cc.name === 'string' ? cc.name : null;
            const cs = cc.score;
            if (!name || typeof cs !== 'number' || !isFinite(cs)) {
                continue;
            }
            const reason = typeof cc.reason === 'string' ? cc.reason : undefined;
            checks.push({name, score: cs, reason});
        }
        return {score, checks, repoUrl};
    }

    /**
     * Extract a Scorecard-eligible `{host, owner, repo}` triple from
     * the raw `repository` value the npm registry stores. Handles the
     * common shapes:
     *
     *   - `git+https://github.com/owner/repo.git`
     *   - `git@github.com:owner/repo.git`
     *   - `https://github.com/owner/repo`
     *   - npm shorthand `owner/repo` (assumed GitHub)
     *   - `github:owner/repo`
     *   - gitlab / bitbucket variants of the above
     *
     * Returns `null` for any other host or unparsable string — caller
     * skips the Scorecard fetch for those packages.
     */
    public static parseRepoUrl(raw: string|null|undefined): ScorecardRepo|null {
        if (!raw || typeof raw !== 'string') {
            return null;
        }
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
            return null;
        }

        // npm shorthand `owner/repo` (assumed GitHub) — matches before
        // the longer host-prefixed patterns so `lodash/lodash` resolves.
        const shorthand = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/i.exec(trimmed);
        if (shorthand) {
            return {host: 'github.com', owner: shorthand[1], repo: OpenSsfFetcher._stripGit(shorthand[2])};
        }

        for (const host of ['github.com', 'gitlab.com', 'bitbucket.org'] as const) {
            const shortPrefix = host.split('.')[0]; // 'github' | 'gitlab' | 'bitbucket'
            const prefixMatch = new RegExp(`^${shortPrefix}:([^/]+)/([^/#]+?)(?:#.+)?$`, 'i').exec(trimmed);
            if (prefixMatch) {
                return {host, owner: prefixMatch[1], repo: OpenSsfFetcher._stripGit(prefixMatch[2])};
            }
            const httpMatch = new RegExp(
                `^(?:git\\+)?https?://${OpenSsfFetcher._escapeHost(host)}/([^/]+)/([^/#?]+?)(?:\\.git)?(?:[/#?].*)?$`,
                'i'
            ).exec(trimmed);
            if (httpMatch) {
                return {host, owner: httpMatch[1], repo: OpenSsfFetcher._stripGit(httpMatch[2])};
            }
            const sshMatch = new RegExp(
                `^git(?:\\+ssh://git)?@${OpenSsfFetcher._escapeHost(host)}[:/]([^/]+)/([^/#]+?)(?:\\.git)?(?:#.+)?$`,
                'i'
            ).exec(trimmed);
            if (sshMatch) {
                return {host, owner: sshMatch[1], repo: OpenSsfFetcher._stripGit(sshMatch[2])};
            }
        }
        return null;
    }

    private static _stripGit(name: string): string {
        return name.replace(/\.git$/i, '');
    }

    private static _escapeHost(host: string): string {
        return host.replace(/\./g, '\\.');
    }

    private static _cacheKey(repo: ScorecardRepo): string {
        return `openssf_${repo.host}_${repo.owner}_${repo.repo}`;
    }
}