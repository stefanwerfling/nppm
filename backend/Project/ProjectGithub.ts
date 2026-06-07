import {JsonCache} from '../Cache/JsonCache.js';
import {ConfigProjectType} from '../Config/Config.js';
import {GithubRateLimitError} from '../Github/GithubRateLimitError.js';
import {GithubRateLimitGuard} from '../Github/GithubRateLimitGuard.js';
import {ProjectRemote, RemoteCommit} from './ProjectRemote.js';

const GITHUB_API_HOST = 'api.github.com';

/**
 * Shape we consume from GitHub's contents API. The same envelope is
 * returned for files (`type: 'file'`, base64 `content`) and
 * directories (`type: 'dir'`); the response body is an array for
 * directories and an object for files.
 */
type GithubContentEntry = {
    type: 'file'|'dir'|'symlink'|'submodule';
    name: string;
    path: string;
    encoding?: string;
    content?: string;
};

/**
 * Shape we consume from GitHub's commits API. Each commit carries an
 * author and committer date; we use `committer.date` because it's
 * what's stable across rebases and what `git log --format=%ct`
 * surfaces locally.
 */
type GithubCommitEntry = {
    sha: string;
    commit?: {
        committer?: {date?: string;};
        author?: {date?: string;};
    };
};

/** Hard cap on commits-per-page * pages to avoid runaway pagination. */
const GITHUB_COMMITS_PER_PAGE = 100;
const GITHUB_MAX_PAGES = 10;

/**
 * Reads a project from GitHub via the contents API. The repo is given
 * as `owner/repo`; optional `ref` pins a branch/tag/commit (defaults
 * to the repo's default branch).
 */
export class ProjectGithub extends ProjectRemote {

    private readonly _repo: string;
    private readonly _ref: string|undefined;
    private readonly _token: string|undefined;
    private readonly _cache: JsonCache|null;

    constructor(
        repo: string,
        displayName: string,
        ref?: string,
        token?: string,
        cache?: JsonCache,
        opts: {hidden?: boolean; configIndex?: number; templates?: string[];} = {}
    ) {
        super(displayName, opts);
        /*
         * Accept either `owner/repo` or a full github.com URL the user
         * pasted from the address bar — the contents API only handles
         * the short form. Normalising here keeps the rest of this
         * class oblivious to which shape sat in nppm.json.
         */
        this._repo = ProjectGithub._normaliseRepo(repo);
        this._ref = ref;
        this._token = token;
        this._cache = cache ?? null;
    }

    /**
     * Pure parser — mirrors {@link Server._normaliseGithubRepo} but
     * leaves the input untouched when it doesn't match any known
     * shape, so a malformed entry produces a clear "package.json
     * missing" error instead of silently mutating state.
     */
    private static _normaliseRepo(input: string): string {
        const v = input.trim().replace(/\.git$/, '').replace(/\/$/, '');
        const m = /^(?:https?:\/\/(?:[^@]+@)?github\.com\/|git@github\.com:|git\+https?:\/\/github\.com\/|github:)([^/\s]+)\/([^/\s]+)$/i.exec(v);
        if (m) {
            return `${m[1]}/${m[2]}`;
        }
        return input;
    }

    public getType(): ConfigProjectType {
        return ConfigProjectType.github;
    }

    public getKey(): string {
        return `github:${this._repo}@${this._ref ?? 'HEAD'}`;
    }

    protected async fetchFile(repoPath: string): Promise<string|null> {
        const data = await this._request(repoPath);

        if (data === null || Array.isArray(data) || data.type !== 'file') {
            return null;
        }

        if (data.encoding === 'base64' && typeof data.content === 'string') {
            /*
             * GitHub wraps long base64 with newlines — atob+TextDecoder
             * handle this fine but we strip them for clarity.
             */
            const cleaned = data.content.replace(/\n/g, '');
            return Buffer.from(cleaned, 'base64').toString('utf-8');
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
            const cleaned = data.content.replace(/\n/g, '');
            return Buffer.from(cleaned, 'base64').toString('utf-8');
        }
        return null;
    }

    public async listCommitsForFile(repoPath: string): Promise<RemoteCommit[]|null> {
        const cleanPath = repoPath.replace(/^\/+/, '');
        const collected: RemoteCommit[] = [];

        for (let page = 1; page <= GITHUB_MAX_PAGES; page++) {
            const url = new URL(`https://api.github.com/repos/${this._repo}/commits`);
            url.searchParams.set('path', cleanPath);
            url.searchParams.set('per_page', String(GITHUB_COMMITS_PER_PAGE));
            url.searchParams.set('page', String(page));
            if (this._ref) {
                url.searchParams.set('sha', this._ref);
            }

            const cacheKey = `github_commits_${this._repo}_${this._ref ?? 'HEAD'}_${cleanPath}_p${page}`;
            type Wrap = {data: GithubCommitEntry[]|null;};
            let chunk: GithubCommitEntry[]|null = null;

            if (this._cache) {
                const hit = this._cache.get<Wrap>(cacheKey);
                if (hit !== null) {
                    chunk = hit.data;
                }
            }

            if (chunk === null) {
                let res: Response;
                try {
                    res = await GithubRateLimitGuard.fetch(
                        GITHUB_API_HOST, url.toString(), {headers: this._headers()}
                    );
                } catch (e) {
                    if (e instanceof GithubRateLimitError) {
                        /*
                         * Don't cache — the moment the window resets we
                         * want this call to go through again.
                         */
                        return null;
                    }
                    throw e;
                }
                if (res.status === 404) {
                    this._cache?.set<Wrap>(cacheKey, {data: null});
                    return null;
                }
                if (!res.ok) {
                    throw new Error(`GitHub ${url.pathname} → ${res.status} ${res.statusText}`);
                }
                chunk = (await res.json()) as GithubCommitEntry[];
                this._cache?.set<Wrap>(cacheKey, {data: chunk});
            }

            if (chunk.length === 0) {
                break;
            }
            for (const c of chunk) {
                const date = c.commit?.committer?.date ?? c.commit?.author?.date;
                if (!date) {
                    continue;
                }
                const ts = Date.parse(date);
                if (!Number.isFinite(ts)) {
                    continue;
                }
                collected.push({sha: c.sha, timestamp: ts});
            }
            if (chunk.length < GITHUB_COMMITS_PER_PAGE) {
                break;
            }
        }

        /*
         * GitHub returns commits newest-first across pages. Flip so
         * the backfill processes oldest-first and matches the local
         * walker's `git log --reverse` semantics.
         */
        collected.reverse();
        return collected;
    }

    public async getHeadSha(): Promise<string|null> {
        const ref = this._ref ?? 'HEAD';
        const url = `https://api.github.com/repos/${this._repo}/commits/${encodeURIComponent(ref)}`;
        const cacheKey = `github_head_${this._repo}_${ref}`;
        type Wrap = {data: string|null;};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(cacheKey);
            if (hit !== null) {
                return hit.data;
            }
        }

        try {
            const res = await GithubRateLimitGuard.fetch(
                GITHUB_API_HOST, url, {headers: this._headers()}
            );
            if (!res.ok) {
                this._cache?.set<Wrap>(cacheKey, {data: null});
                return null;
            }
            const body = (await res.json()) as {sha?: string;};
            const sha = typeof body.sha === 'string' ? body.sha : null;
            this._cache?.set<Wrap>(cacheKey, {data: sha});
            return sha;
        } catch (e) {
            if (e instanceof GithubRateLimitError) {
                /*
                 * Don't poison the cache — let the next call retry
                 * once the window has reset.
                 */
                return null;
            }
            return null;
        }
    }

    private _headers(): Record<string, string> {
        const headers: Record<string, string> = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'nppm'
        };
        if (this._token) {
            headers.Authorization = `Bearer ${this._token}`;
        }
        return headers;
    }

    private async _request(
        repoPath: string,
        refOverride?: string
    ): Promise<GithubContentEntry|GithubContentEntry[]|null> {
        const cleanPath = repoPath.replace(/^\/+/, '');
        const url = new URL(
            `https://api.github.com/repos/${this._repo}/contents/${cleanPath}`
        );

        const ref = refOverride ?? this._ref;
        if (ref) {
            url.searchParams.set('ref', ref);
        }

        /*
         * Wrap in `{data: ...}` so we can distinguish a cached-404
         * (`{data: null}`) from a cache miss (JsonCache returning
         * `null`).
         */
        const cacheKey = `github_${this._repo}_${ref ?? 'HEAD'}_${cleanPath}`;
        type Wrap = {data: GithubContentEntry|GithubContentEntry[]|null;};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(cacheKey);
            if (hit !== null) {
                return hit.data;
            }
        }

        let res: Response;
        try {
            res = await GithubRateLimitGuard.fetch(
                GITHUB_API_HOST, url.toString(), {headers: this._headers()}
            );
        } catch (e) {
            if (e instanceof GithubRateLimitError) {
                /*
                 * Don't cache — the moment the window resets we want
                 * this call to actually fetch. Returning null mirrors
                 * the 404 path: the caller treats it as "no data for
                 * this path", and the next paint will retry.
                 */
                return null;
            }
            throw e;
        }

        if (res.status === 404) {
            this._cache?.set<Wrap>(cacheKey, {data: null});
            return null;
        }

        if (!res.ok) {
            throw new Error(`GitHub ${url.pathname} → ${res.status} ${res.statusText}`);
        }

        const data = (await res.json()) as GithubContentEntry|GithubContentEntry[];
        this._cache?.set<Wrap>(cacheKey, {data: data});
        return data;
    }

}