import {JsonCache} from '../Cache/JsonCache.js';
import {GitResolver, GitDepInfo} from '../Fingerprint/GitResolver.js';

/**
 * One commit row as surfaced in the Releases tab for git-installed
 * deps. The shape is a deliberate subset of the GitHub / Gitea
 * commits-API response so we don't leak provider-specific fields into
 * the UI.
 */
export type GitCommit = {
    sha: string;
    shortSha: string;
    /** First line of the commit message ("subject"). */
    subject: string;
    /**
     * ISO timestamp. `null` when the host returned an unparseable
     * date — keeps the entry visible instead of dropping it. 
     */
    date: string|null;
    /** Author login / display name; falls back to email-local-part. */
    author: string|null;
    /** Direct URL to the commit page. */
    url: string;
};

/**
 * Strategy for the HTTP call. Default uses `fetch`. Tests inject a
 * stub keyed by request URL so we never hit the real APIs.
 */
export interface CommitsHttpFetcher {
    fetch(url: string, headers: Record<string, string>): Promise<{ok: boolean; status: number; statusText: string; body: unknown;}>;
}

export type GitCommitsResponse = {
    host: GitDepInfo['host'];
    owner: string;
    repo: string;
    commits: GitCommit[];
    repoUrl: string;
};

/**
 * Per-commit-pull cap. Mirrors `ReleasesFetcher`'s `per_page=100` for
 * GitHub releases — enough to fill a panel without burning the rate
 * budget on a single click.
 */
const DEFAULT_LIMIT = 50;

/**
 * Asks a git host for the latest N commits on the default branch. Used
 * to populate the Releases tab for git-installed packages (the
 * registry-side `ReleasesFetcher` returns nothing for those).
 *
 * Supported hosts: github (REST v3), gitea (REST v1). GitLab /
 * Bitbucket return `null` until their fetchers land — same
 * convention as `ReleasesFetcher` for non-github repos.
 */
export class GitCommitsFetcher {

    private readonly _cache: JsonCache|null;
    private readonly _http: CommitsHttpFetcher;
    private readonly _giteaHosts: string[];
    private readonly _githubToken: string|undefined;
    private readonly _giteaTokens: Map<string, string>;

    constructor(
        cache: JsonCache|null,
        opts: {
            giteaHosts?: string[];
            githubToken?: string;
            /**
             * Per-instance token map (hostname → token). Gitea
             * deployments are private-by-default so tokens are common. 
             */
            giteaTokens?: Map<string, string>;
            http?: CommitsHttpFetcher;
        } = {}
    ) {
        this._cache = cache;
        this._giteaHosts = opts.giteaHosts ?? [];
        this._githubToken = opts.githubToken;
        this._giteaTokens = opts.giteaTokens ?? new Map();
        this._http = opts.http ?? GitCommitsFetcher._defaultHttp();
    }

    public async fetch(gitUrl: string, limit: number = DEFAULT_LIMIT): Promise<GitCommitsResponse|null> {
        const v = gitUrl.trim();
        const key = `gitcommits_${v}`;
        type Wrap = {data: GitCommitsResponse|null;};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(key);
            if (hit !== null) {
                return hit.data;
            }
        }

        const parsed = GitResolver.parse(v, this._giteaHosts);
        if (!parsed) {
            this._cache?.set<Wrap>(key, {data: null});
            return null;
        }

        try {
            let resp: GitCommitsResponse|null;
            if (parsed.host === 'github') {
                resp = await this._fetchGithub(parsed, limit);
            } else if (parsed.host === 'gitea') {
                resp = await this._fetchGitea(parsed, limit);
            } else {
                resp = null;
            }
            this._cache?.set<Wrap>(key, {data: resp});
            return resp;
        } catch {
            /*
             * Don't cache transient errors — same shape as the GH
             * release-notes path.
             */
            return null;
        }
    }

    private async _fetchGithub(info: GitDepInfo, limit: number): Promise<GitCommitsResponse|null> {
        const url = `https://api.github.com/repos/${info.owner}/${info.repo}/commits?per_page=${limit}`;
        const headers: Record<string, string> = {
            'User-Agent': 'nppm',
            'Accept': 'application/vnd.github.v3+json'
        };
        if (this._githubToken) {
            headers.Authorization = `Bearer ${this._githubToken}`;
        }
        const res = await this._http.fetch(url, headers);
        if (res.status === 404) {
            return null;
        }
        if (!res.ok) {
            throw new Error(`GitHub commits ${info.owner}/${info.repo} → ${res.status} ${res.statusText}`);
        }
        const raw = res.body as GithubCommit[];
        const commits = Array.isArray(raw) ? raw.map((c) => GitCommitsFetcher._mapGithub(c, info)) : [];
        return {
            host: info.host,
            owner: info.owner,
            repo: info.repo,
            commits: commits,
            repoUrl: `https://github.com/${info.owner}/${info.repo}`
        };
    }

    private async _fetchGitea(info: GitDepInfo, limit: number): Promise<GitCommitsResponse|null> {
        const url = `https://${info.hostname}/api/v1/repos/${info.owner}/${info.repo}/commits?limit=${limit}`;
        const headers: Record<string, string> = {
            'User-Agent': 'nppm',
            'Accept': 'application/json'
        };
        const token = this._giteaTokens.get(info.hostname);
        if (token) {
            headers.Authorization = `token ${token}`;
        }
        const res = await this._http.fetch(url, headers);
        if (res.status === 404) {
            return null;
        }
        if (!res.ok) {
            throw new Error(`Gitea commits ${info.hostname}/${info.owner}/${info.repo} → ${res.status} ${res.statusText}`);
        }
        const raw = res.body as GiteaCommit[];
        const commits = Array.isArray(raw) ? raw.map((c) => GitCommitsFetcher._mapGitea(c, info)) : [];
        return {
            host: info.host,
            owner: info.owner,
            repo: info.repo,
            commits: commits,
            repoUrl: `https://${info.hostname}/${info.owner}/${info.repo}`
        };
    }

    private static _mapGithub(c: GithubCommit, info: GitDepInfo): GitCommit {
        const sha = c.sha ?? '';
        const message = c.commit?.message ?? '';
        return {
            sha: sha,
            shortSha: sha.slice(0, 7),
            subject: GitCommitsFetcher._subject(message),
            date: c.commit?.author?.date ?? c.commit?.committer?.date ?? null,
            author: c.author?.login ?? c.commit?.author?.name ?? GitCommitsFetcher._emailLocal(c.commit?.author?.email),
            url: c.html_url ?? `https://github.com/${info.owner}/${info.repo}/commit/${sha}`
        };
    }

    private static _mapGitea(c: GiteaCommit, info: GitDepInfo): GitCommit {
        const sha = c.sha ?? '';
        const message = c.commit?.message ?? '';
        return {
            sha: sha,
            shortSha: sha.slice(0, 7),
            subject: GitCommitsFetcher._subject(message),
            date: c.commit?.author?.date ?? c.created ?? null,
            author: c.author?.login ?? c.commit?.author?.name ?? GitCommitsFetcher._emailLocal(c.commit?.author?.email),
            url: c.html_url ?? `https://${info.hostname}/${info.owner}/${info.repo}/commit/${sha}`
        };
    }

    private static _subject(message: string): string {
        const nl = message.indexOf('\n');
        return (nl >= 0 ? message.slice(0, nl) : message).trim();
    }

    private static _emailLocal(email: string|undefined): string|null {
        if (!email) {
            return null;
        }
        const at = email.indexOf('@');
        return at > 0 ? email.slice(0, at) : email;
    }

    private static _defaultHttp(): CommitsHttpFetcher {
        return {
            fetch: async function(url, headers) {
                const res = await fetch(url, {headers: headers});
                let body: unknown = null;
                try {
                    body = await res.json();
                } catch {
                    body = null;
                }
                return {ok: res.ok, status: res.status, statusText: res.statusText, body: body};
            }
        };
    }

}

type GithubCommit = {
    sha?: string;
    html_url?: string;
    commit?: {
        message?: string;
        author?: {name?: string; email?: string; date?: string;};
        committer?: {date?: string;};
    };
    author?: {login?: string;} | null;
};

type GiteaCommit = {
    sha?: string;
    html_url?: string;
    created?: string;
    commit?: {
        message?: string;
        author?: {name?: string; email?: string; date?: string;};
    };
    author?: {login?: string;} | null;
};