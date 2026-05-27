import {JsonCache} from '../Cache/JsonCache.js';
import {ConfigProjectType} from '../Config/Config.js';
import {ProjectRemote} from './ProjectRemote.js';

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
        cache?: JsonCache
    ) {
        super(displayName);
        this._repo = repo;
        this._ref = ref;
        this._token = token;
        this._cache = cache ?? null;
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
            // GitHub wraps long base64 with newlines — atob+TextDecoder
            // handle this fine but we strip them for clarity.
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

    private async _request(repoPath: string): Promise<GithubContentEntry|GithubContentEntry[]|null> {
        const cleanPath = repoPath.replace(/^\/+/, '');
        const url = new URL(
            `https://api.github.com/repos/${this._repo}/contents/${cleanPath}`
        );

        if (this._ref) {
            url.searchParams.set('ref', this._ref);
        }

        const headers: Record<string, string> = {
            Accept: 'application/vnd.github.v3+json',
            // GitHub requires a User-Agent on API requests — without
            // it the response is 403.
            'User-Agent': 'nppm'
        };

        if (this._token) {
            headers.Authorization = `Bearer ${this._token}`;
        }

        // Wrap in `{data: ...}` so we can distinguish a cached-404
        // (`{data: null}`) from a cache miss (JsonCache returning
        // `null`).
        const cacheKey = `github_${this._repo}_${this._ref ?? 'HEAD'}_${cleanPath}`;
        type Wrap = {data: GithubContentEntry|GithubContentEntry[]|null};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(cacheKey);
            if (hit !== null) {
                return hit.data;
            }
        }

        const res = await fetch(url.toString(), {headers});

        if (res.status === 404) {
            this._cache?.set<Wrap>(cacheKey, {data: null});
            return null;
        }

        if (!res.ok) {
            throw new Error(`GitHub ${url.pathname} → ${res.status} ${res.statusText}`);
        }

        const data = (await res.json()) as GithubContentEntry|GithubContentEntry[];
        this._cache?.set<Wrap>(cacheKey, {data});
        return data;
    }
}