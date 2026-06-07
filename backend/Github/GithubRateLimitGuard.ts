import {GithubRateLimitError} from './GithubRateLimitError.js';

type HostState = {
    /** Last `X-RateLimit-Remaining` we observed. */
    remaining: number;
    /** Epoch ms when the window resets (X-RateLimit-Reset × 1000). */
    resetAt: number;
    /**
     * `true` after we've emitted the one-time `console.warn` for the
     * current depletion event. Cleared automatically when the window
     * elapses (the entry is dropped).
     */
    warned: boolean;
};

/**
 * Process-wide guard around the GitHub REST API (and other hosts that
 * emit the same `X-RateLimit-Remaining`/`Reset` header pair, such as
 * a configured Gitea instance). Tracks the most recent response per
 * host in memory — no disk persistence; cool-downs survive only as
 * long as the dev server is running, which matches the lifetime of
 * the rate-limit window itself (max one hour).
 *
 * Two reasons this is centralised:
 *
 *   1. **Pre-emptive skip.** Once one fetcher hits the wall, every
 *      other code path can ask `canRequest()` and back off before
 *      issuing the HTTP call. Without this, a full scan can produce
 *      dozens of cascaded `GitHub /repos/... → 403 rate limit exceeded`
 *      log lines from independent fetchers (ProjectGithub,
 *      ReleasesFetcher, GitCommitsFetcher, …) each unaware of the
 *      others' fate.
 *   2. **One-shot warning.** `observe()` emits a `console.warn` the
 *      first time `remaining` drops to 0 within a window; further
 *      hits stay silent until the window expires. The log file stays
 *      readable.
 *
 * Wire it in via `GithubRateLimitGuard.fetch(host, url, init)` — that
 * helper does the canRequest gate, the underlying `fetch`, and the
 * `observe()` of the response headers in one step. Callers that
 * need the raw `fetch` API (because they're streaming a body) can
 * call `canRequest` + `observe` directly.
 */
export class GithubRateLimitGuard {

    private static _state: Map<string, HostState> = new Map();

    /**
     * `true` when we're free to issue an HTTP request to `host`. The
     * negative case is "we know the last response showed remaining=0
     * and the reset hasn't fired yet" — once the reset timestamp is
     * in the past, the entry is dropped and we return `true` again.
     */
    public static canRequest(host: string): boolean {
        const s = this._state.get(host);
        if (!s) {
            return true;
        }
        if (Date.now() >= s.resetAt) {
            this._state.delete(host);
            return true;
        }
        return s.remaining > 0;
    }

    /**
     * Epoch ms when the current cool-down lifts, or `null` when there
     * isn't one. UI surfaces use this to render a "back at HH:MM"
     * pill instead of a generic "GitHub error".
     */
    public static cooldownUntil(host: string): number|null {
        const s = this._state.get(host);
        if (!s) {
            return null;
        }
        if (Date.now() >= s.resetAt) {
            this._state.delete(host);
            return null;
        }
        if (s.remaining > 0) {
            return null;
        }
        return s.resetAt;
    }

    /**
     * Record the rate-limit headers of a finished response. Safe to
     * call on any response (success, 403, 5xx); it short-circuits if
     * the headers aren't present. Emits a one-time `console.warn` the
     * first time `remaining` reaches 0 within a window.
     */
    public static observe(host: string, response: Response): void {
        const remainingRaw = response.headers.get('x-ratelimit-remaining');
        const resetRaw = response.headers.get('x-ratelimit-reset');
        if (remainingRaw === null || resetRaw === null) {
            return;
        }
        const remaining = Number.parseInt(remainingRaw, 10);
        const resetSec = Number.parseInt(resetRaw, 10);
        if (!Number.isFinite(remaining) || !Number.isFinite(resetSec)) {
            return;
        }
        const resetAt = resetSec * 1000;
        const existing = this._state.get(host);
        const warned = existing?.warned ?? false;
        this._state.set(host, {
            remaining: remaining,
            resetAt: resetAt,
            warned: warned
        });

        if (remaining === 0 && !warned) {
            const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
            console.warn(
                `nppm: ${host} rate-limit exhausted; skipping further requests for ~${minutes} min`
            );
            const updated = this._state.get(host);
            if (updated) {
                updated.warned = true;
            }
        }
    }

    /**
     * `fetch` wrapper that respects the cool-down. Throws
     * `GithubRateLimitError` synchronously (before issuing the
     * request) if `canRequest(host)` is false; otherwise calls the
     * real `fetch`, observes the response headers, and returns the
     * `Response` untouched so the caller can read `.ok` / `.status`
     * / `.json()` as usual.
     */
    public static async fetch(host: string, url: string, init?: RequestInit): Promise<Response> {
        const until = this.cooldownUntil(host);
        if (until !== null) {
            throw new GithubRateLimitError(host, until);
        }
        const res = await fetch(url, init);
        this.observe(host, res);
        /*
         * Some hosts (notably api.github.com) return 403 with body
         * `{message: "API rate limit exceeded..."}` when the window is
         * empty. The headers we observed above already captured the
         * state, so the caller's normal error path will see the 403
         * and bail; subsequent callers will be short-circuited by
         * `cooldownUntil()` returning a value.
         */
        return res;
    }

    /**
     * Wipe the in-memory state. Tests use this between cases so one
     * cool-down doesn't leak into the next. Not part of the public
     * runtime contract — production code never calls it.
     */
    public static _resetForTest(): void {
        this._state.clear();
    }

}