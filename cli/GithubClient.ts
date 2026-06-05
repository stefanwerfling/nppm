import {STICKY_MARKER} from './ActionFormat.js';

/**
 * Minimal slice of the GitHub Issues Comments API. We deliberately
 * implement the four endpoints by hand rather than pulling in
 * `@octokit/rest` — the action runs on the consumer's runner, every
 * MB of dependency bloat slows their CI down, and the four `fetch`
 * calls are 30 lines of code.
 */
export type GithubClientIO = {
    /** Bot token — `github.token` automatically issued to every workflow. */
    token: string;
    /** `owner/repo`. */
    repo: string;
    /** Optional override for tests; defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
    /** Override the base URL for tests / GitHub Enterprise. */
    apiBase?: string;
};

type Comment = {
    id: number;
    body: string;
};

/**
 * Sticky-comment helper for the PR review bot. Searches the
 * issue's existing comments for the marker the formatter embeds,
 * then PATCHes the matching one or POSTs a fresh comment when no
 * sibling exists. Same protocol every PR-bot uses (Dependabot,
 * CodeRabbit, Snyk, …) — keeps the conversation thread tidy.
 */
export class GithubClient {

    private readonly _token: string;
    private readonly _repo: string;
    private readonly _fetch: typeof fetch;
    private readonly _apiBase: string;

    constructor(io: GithubClientIO) {
        this._token = io.token;
        this._repo = io.repo;
        this._fetch = io.fetch ?? globalThis.fetch;
        this._apiBase = (io.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    }

    /**
     * Upsert a sticky comment on PR #`number`. Returns the resulting
     * comment id on success, or `null` when the API refused (auth
     * missing, repo gone, rate-limited).
     */
    public async upsertStickyComment(number: number, body: string): Promise<number|null> {
        const existing = await this._findStickyComment(number);
        if (existing) {
            const ok = await this._patchComment(existing.id, body);
            return ok ? existing.id : null;
        }
        return await this._postComment(number, body);
    }

    private async _findStickyComment(number: number): Promise<Comment|null> {
        const url = `${this._apiBase}/repos/${this._repo}/issues/${number}/comments?per_page=100`;
        try {
            const res = await this._fetch(url, {headers: this._headers()});
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as unknown;
            if (!Array.isArray(raw)) {
                return null;
            }
            for (const c of raw) {
                if (!c || typeof c !== 'object') {
                    continue;
                }
                const cc = c as {id?: unknown; body?: unknown;};
                if (typeof cc.body === 'string' && cc.body.includes(STICKY_MARKER)
                        && typeof cc.id === 'number') {
                    return {id: cc.id, body: cc.body};
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    private async _patchComment(id: number, body: string): Promise<boolean> {
        const url = `${this._apiBase}/repos/${this._repo}/issues/comments/${id}`;
        try {
            const res = await this._fetch(url, {
                method: 'PATCH',
                headers: {...this._headers(), 'Content-Type': 'application/json'},
                body: JSON.stringify({body: body})
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    private async _postComment(number: number, body: string): Promise<number|null> {
        const url = `${this._apiBase}/repos/${this._repo}/issues/${number}/comments`;
        try {
            const res = await this._fetch(url, {
                method: 'POST',
                headers: {...this._headers(), 'Content-Type': 'application/json'},
                body: JSON.stringify({body: body})
            });
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as unknown;
            if (raw && typeof raw === 'object' && typeof (raw as {id?: unknown;}).id === 'number') {
                return (raw as {id: number;}).id;
            }
            return null;
        } catch {
            return null;
        }
    }

    private _headers(): Record<string, string> {
        return {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${this._token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'nppm-action'
        };
    }

}