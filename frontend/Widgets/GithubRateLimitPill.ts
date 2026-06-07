import {ApiGithubRateLimitResponse} from '../../shared/Api/ApiTypes.js';
import {I18n} from '../Util/I18n.js';

/**
 * Threshold below which a non-zero `remaining` count flips the pill
 * into the warn tier. 60 is GitHub's anonymous-window total, so 10
 * is "less than a sixth of the budget left" — enough warning to give
 * the user a chance to provide a `GH_TOKEN` before the next scan
 * tips the window into cool-down.
 */
const WARN_THRESHOLD = 10;

const POLL_INTERVAL_MS = 30_000;

/**
 * Tiny topbar widget that polls `/api/github/ratelimit` and renders a
 * pill describing the live `GithubRateLimitGuard` state. Hidden when
 * the backend hasn't observed any GitHub responses yet (no risk to
 * surface), yellow when the remaining count drops below
 * `WARN_THRESHOLD`, red with a countdown when `cooldownActive` is true.
 *
 * The widget owns its own polling — no `Nppm` plumbing required;
 * `mount(hostElement)` is the only entry. We re-fetch every 30 s and
 * additionally on visibility change so a tab that's been hidden for
 * an hour shows fresh state the moment the user comes back.
 */
export class GithubRateLimitPill {

    private readonly _el: HTMLElement;
    private _timer: ReturnType<typeof setInterval>|null = null;
    private _countdownTimer: ReturnType<typeof setInterval>|null = null;
    private _lastResponse: ApiGithubRateLimitResponse|null = null;

    public constructor(el: HTMLElement) {
        this._el = el;
    }

    /**
     * Start polling. Safe to call once on app boot; idempotent — a
     * second call is a no-op so we don't double up timers.
     */
    public mount(): void {
        if (this._timer) {
            return;
        }
        void this._refresh();
        this._timer = setInterval(() => {
            void this._refresh();
        }, POLL_INTERVAL_MS);
        document.addEventListener('visibilitychange', this._onVisibility);
    }

    private readonly _onVisibility = (): void => {
        if (document.visibilityState === 'visible') {
            void this._refresh();
        }
    };

    private async _refresh(): Promise<void> {
        try {
            const res = await fetch('/api/github/ratelimit');
            if (!res.ok) {
                return;
            }
            this._lastResponse = (await res.json()) as ApiGithubRateLimitResponse;
            this._render();
            this._scheduleCountdown();
        } catch {
            /*
             * Network blip — keep the previous render so the user
             * doesn't see the pill flicker out on every flaky network.
             */
        }
    }

    /**
     * Active host = worst-state row across every observed host. If at
     * least one host is in cool-down, that wins; otherwise the host
     * with the smallest `remaining` count wins.
     */
    private static _pickActive(hosts: {host: string; remaining: number; resetAt: number; cooldownActive: boolean;}[]): {host: string; remaining: number; resetAt: number; cooldownActive: boolean;}|null {
        if (hosts.length === 0) {
            return null;
        }
        const cooldown = hosts.filter((h) => h.cooldownActive);
        if (cooldown.length > 0) {
            cooldown.sort((a, b) => a.resetAt - b.resetAt);
            return cooldown[0];
        }
        const sorted = [...hosts].sort((a, b) => a.remaining - b.remaining);
        return sorted[0];
    }

    private _render(): void {
        const hosts = this._lastResponse?.hosts ?? [];
        const active = GithubRateLimitPill._pickActive(hosts);

        if (active === null || (!active.cooldownActive && active.remaining > WARN_THRESHOLD)) {
            this._el.style.display = 'none';
            this._el.className = 'topbar-github-pill';
            return;
        }

        this._el.style.display = 'inline-flex';
        if (active.cooldownActive) {
            this._el.className = 'topbar-github-pill topbar-github-pill-cooldown';
            const minutes = Math.max(1, Math.ceil((active.resetAt - Date.now()) / 60_000));
            this._el.textContent = I18n.t('{host}: rate-limited, retry in {min} min', {
                host: active.host,
                min: minutes
            });
            this._el.title = I18n.t(
                'GitHub returned 403 rate-limit-exceeded. Further requests will be skipped until the window resets. Set GH_TOKEN to raise the limit from 60/h to 5000/h.'
            );
        } else {
            this._el.className = 'topbar-github-pill topbar-github-pill-warn';
            this._el.textContent = I18n.t('{host}: {n} requests left', {
                host: active.host,
                n: active.remaining
            });
            this._el.title = I18n.t(
                'GitHub anonymous rate-limit is running low. Set GH_TOKEN to raise the limit from 60/h to 5000/h.'
            );
        }
    }

    /**
     * Re-renders every 30 s while a cool-down is active so the
     * "retry in N min" countdown ticks down without waiting for the
     * next backend poll. Idle when nothing's in cool-down so we
     * don't burn a timer on every paint.
     */
    private _scheduleCountdown(): void {
        const hasCooldown = (this._lastResponse?.hosts ?? []).some((h) => h.cooldownActive);
        if (this._countdownTimer && !hasCooldown) {
            clearInterval(this._countdownTimer);
            this._countdownTimer = null;
            return;
        }
        if (!this._countdownTimer && hasCooldown) {
            this._countdownTimer = setInterval(() => {
                this._render();
            }, POLL_INTERVAL_MS);
        }
    }

}