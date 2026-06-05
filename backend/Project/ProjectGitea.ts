import {JsonCache} from '../Cache/JsonCache.js';
import {ConfigProjectType} from '../Config/Config.js';
import {ProjectRemote, RemoteCommit} from './ProjectRemote.js';

/**
 * Gitea contents API entry — modeled after GitHub's, so the same
 * fields work. Some older Gitea versions returned bare strings for
 * content; we treat anything non-base64 as missing.
 */
type GiteaContentEntry = {
    type: 'file'|'dir'|'symlink'|'submodule';
    name: string;
    path: string;
    encoding?: string;
    content?: string;
};

/**
 * Shape we consume from Gitea's commits API. Mirrors GitHub's
 * envelope with minor field-name drift — `created` is the canonical
 * timestamp.
 */
type GiteaCommitEntry = {
    sha: string;
    created?: string;
    commit?: {
        committer?: {date?: string;};
        author?: {date?: string;};
    };
};

/** Pagination cap — Gitea defaults to 50 per page, max is 50. */
const GITEA_COMMITS_PER_PAGE = 50;
const GITEA_MAX_PAGES = 20;

/**
 * Reads a project from a Gitea instance. `url` is the full repo URL
 * (e.g. `https://gitea.example.com/owner/repo`); the API base is
 * derived from it.
 */
export class ProjectGitea extends ProjectRemote {

    private readonly _apiBase: string;
    private readonly _ref: string|undefined;
    private readonly _token: string|undefined;
    private readonly _cache: JsonCache|null;

    constructor(
        repoUrl: string,
        displayName: string,
        ref?: string,
        token?: string,
        cache?: JsonCache,
        opts: {hidden?: boolean; configIndex?: number; templates?: string[];} = {}
    ) {
        super(displayName, opts);
        this._apiBase = ProjectGitea._toApiBase(repoUrl);
        this._ref = ref;
        this._token = token;
        this._cache = cache ?? null;
    }

    public getType(): ConfigProjectType {
        return ConfigProjectType.gitea;
    }

    public getKey(): string {
        return `gitea:${this._apiBase}@${this._ref ?? 'HEAD'}`;
    }

    /**
     * Bare host of the Gitea instance (e.g. `gitea.example.com`).
     * Consumed by `GitHeadFetcher`/`GitCommitsFetcher` so a git dep
     * pointing at the same instance routes through the gitea endpoints
     * instead of being treated as an unknown host.
     */
    public getHost(): string|null {
        try {
            return new URL(this._apiBase).host;
        } catch {
            return null;
        }
    }

    /**
     * Per-instance API token configured in `nppm.json`. Returned so
     * the same credential can authenticate the commits fetcher
     * without re-reading the config from disk.
     */
    public getToken(): string|undefined {
        return this._token;
    }

    protected async fetchFile(repoPath: string): Promise<string|null> {
        const data = await this._request(repoPath);

        if (data === null || Array.isArray(data) || data.type !== 'file') {
            return null;
        }

        if (data.encoding === 'base64' && typeof data.content === 'string') {
            return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
        }

        return null;
    }

    protected async listDirectory(repoPath: string): Promise<string[]> {
        const data = await this._request(repoPath);

        if (!Array.isArray(data)) {
            return [];
        }

        return data
        .filter((e) => e.type === 'dir')
        .map((e) => e.name);
    }

    public async fetchFileAtRef(repoPath: string, ref: string): Promise<string|null> {
        const data = await this._request(repoPath, ref);
        if (data === null || Array.isArray(data) || data.type !== 'file') {
            return null;
        }
        if (data.encoding === 'base64' && typeof data.content === 'string') {
            return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
        }
        return null;
    }

    public async listCommitsForFile(repoPath: string): Promise<RemoteCommit[]|null> {
        const cleanPath = repoPath.replace(/^\/+/, '');
        const collected: RemoteCommit[] = [];

        for (let page = 1; page <= GITEA_MAX_PAGES; page++) {
            const url = new URL(`${this._apiBase}/commits`);
            url.searchParams.set('path', cleanPath);
            url.searchParams.set('limit', String(GITEA_COMMITS_PER_PAGE));
            url.searchParams.set('page', String(page));
            if (this._ref) {
                url.searchParams.set('sha', this._ref);
            }

            const cacheKey = `gitea_commits_${this._apiBase}_${this._ref ?? 'HEAD'}_${cleanPath}_p${page}`;
            type Wrap = {data: GiteaCommitEntry[]|null;};
            let chunk: GiteaCommitEntry[]|null = null;

            if (this._cache) {
                const hit = this._cache.get<Wrap>(cacheKey);
                if (hit !== null) {
                    chunk = hit.data;
                }
            }

            if (chunk === null) {
                const res = await fetch(url.toString(), {headers: this._headers()});
                if (res.status === 404) {
                    this._cache?.set<Wrap>(cacheKey, {data: null});
                    return null;
                }
                if (!res.ok) {
                    throw new Error(`Gitea ${url.pathname} → ${res.status} ${res.statusText}`);
                }
                chunk = (await res.json()) as GiteaCommitEntry[];
                this._cache?.set<Wrap>(cacheKey, {data: chunk});
            }

            if (chunk.length === 0) {
                break;
            }
            for (const c of chunk) {
                const date = c.created
                    ?? c.commit?.committer?.date
                    ?? c.commit?.author?.date;
                if (!date) {
                    continue;
                }
                const ts = Date.parse(date);
                if (!Number.isFinite(ts)) {
                    continue;
                }
                collected.push({sha: c.sha, timestamp: ts});
            }
            if (chunk.length < GITEA_COMMITS_PER_PAGE) {
                break;
            }
        }

        collected.reverse();
        return collected;
    }

    public async getHeadSha(): Promise<string|null> {
        const ref = this._ref ?? 'HEAD';
        const url = `${this._apiBase}/commits/${encodeURIComponent(ref)}`;
        const cacheKey = `gitea_head_${this._apiBase}_${ref}`;
        type Wrap = {data: string|null;};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(cacheKey);
            if (hit !== null) {
                return hit.data;
            }
        }

        try {
            const res = await fetch(url, {headers: this._headers()});
            if (!res.ok) {
                this._cache?.set<Wrap>(cacheKey, {data: null});
                return null;
            }
            const body = (await res.json()) as {sha?: string;};
            const sha = typeof body.sha === 'string' ? body.sha : null;
            this._cache?.set<Wrap>(cacheKey, {data: sha});
            return sha;
        } catch {
            return null;
        }
    }

    private _headers(): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: 'application/json'
        };
        if (this._token) {
            /*
             * Gitea historically used `token X`; newer versions also
             * accept `Bearer X`. The token form is the safer default.
             */
            headers.Authorization = `token ${this._token}`;
        }
        return headers;
    }

    private async _request(
        repoPath: string,
        refOverride?: string
    ): Promise<GiteaContentEntry|GiteaContentEntry[]|null> {
        const cleanPath = repoPath.replace(/^\/+/, '');
        const url = new URL(`${this._apiBase}/contents/${cleanPath}`);

        const ref = refOverride ?? this._ref;
        if (ref) {
            url.searchParams.set('ref', ref);
        }

        /*
         * Wrap in `{data: ...}` so we can distinguish a cached-404
         * (`{data: null}`) from a cache miss.
         */
        const cacheKey = `gitea_${this._apiBase}_${ref ?? 'HEAD'}_${cleanPath}`;
        type Wrap = {data: GiteaContentEntry|GiteaContentEntry[]|null;};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(cacheKey);
            if (hit !== null) {
                return hit.data;
            }
        }

        const res = await fetch(url.toString(), {headers: this._headers()});

        if (res.status === 404) {
            this._cache?.set<Wrap>(cacheKey, {data: null});
            return null;
        }

        if (!res.ok) {
            throw new Error(`Gitea ${url.pathname} → ${res.status} ${res.statusText}`);
        }

        const data = (await res.json()) as GiteaContentEntry|GiteaContentEntry[];
        this._cache?.set<Wrap>(cacheKey, {data: data});
        return data;
    }

    /**
     * Convert `https://gitea.example.com/owner/repo(.git)?` into
     * `https://gitea.example.com/api/v1/repos/owner/repo`. Throws if
     * the URL does not look like a Gitea repo URL.
     */
    private static _toApiBase(repoUrl: string): string {
        const trimmed = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
        const u = new URL(trimmed);
        const parts = u.pathname.split('/').filter((p) => p.length > 0);

        if (parts.length < 2) {
            throw new Error(`Gitea URL "${repoUrl}" must look like "<host>/<owner>/<repo>"`);
        }

        const owner = parts[parts.length - 2];
        const repo = parts[parts.length - 1];
        return `${u.origin}/api/v1/repos/${owner}/${repo}`;
    }

}