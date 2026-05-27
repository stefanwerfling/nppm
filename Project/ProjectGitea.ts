import {JsonCache} from '../Cache/JsonCache.js';
import {ConfigProjectType} from '../Config/Config.js';
import {ProjectRemote} from './ProjectRemote.js';

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
        cache?: JsonCache
    ) {
        super(displayName);
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

    private async _request(repoPath: string): Promise<GiteaContentEntry|GiteaContentEntry[]|null> {
        const cleanPath = repoPath.replace(/^\/+/, '');
        const url = new URL(`${this._apiBase}/contents/${cleanPath}`);

        if (this._ref) {
            url.searchParams.set('ref', this._ref);
        }

        const headers: Record<string, string> = {
            Accept: 'application/json'
        };

        if (this._token) {
            // Gitea historically used `token X`; newer versions also
            // accept `Bearer X`. The token form is the safer default.
            headers.Authorization = `token ${this._token}`;
        }

        // Wrap in `{data: ...}` so we can distinguish a cached-404
        // (`{data: null}`) from a cache miss.
        const cacheKey = `gitea_${this._apiBase}_${this._ref ?? 'HEAD'}_${cleanPath}`;
        type Wrap = {data: GiteaContentEntry|GiteaContentEntry[]|null};

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
            throw new Error(`Gitea ${url.pathname} → ${res.status} ${res.statusText}`);
        }

        const data = (await res.json()) as GiteaContentEntry|GiteaContentEntry[];
        this._cache?.set<Wrap>(cacheKey, {data});
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