import {ApiGithubRateLimitResponse} from '../../shared/Api/ApiTypes.js';
import {I18n} from '../Util/I18n.js';

/**
 * Inline banner for the Dashboard / Matrix views: when at least one
 * GitHub host is in active cool-down, the banner explains why the
 * view's GitHub-derived columns may be missing data. Stays out of the
 * way (returns `null`) when nothing's in cool-down — the topbar pill
 * already covers the "remaining low" case.
 *
 * Pattern: static one-shot. Each call to `tryRender()` does its own
 * fetch and either returns a freshly-built banner element ready to
 * prepend, or `null`. Views call it on `show()`/`setData()` so the
 * banner mirrors the latest state every time the user navigates back.
 */
export class GithubRateLimitBanner {

    /**
     * Fetch the live rate-limit state and return a banner element when
     * any host is in active cool-down; otherwise `null`. Network
     * errors return `null` — the view should never get blocked by a
     * banner fetch.
     */
    public static async tryRender(): Promise<HTMLElement|null> {
        let payload: ApiGithubRateLimitResponse;
        try {
            const res = await fetch('/api/github/ratelimit');
            if (!res.ok) {
                return null;
            }
            payload = (await res.json()) as ApiGithubRateLimitResponse;
        } catch {
            return null;
        }

        const cooldown = payload.hosts.filter((h) => h.cooldownActive);
        if (cooldown.length === 0) {
            return null;
        }
        cooldown.sort((a, b) => a.resetAt - b.resetAt);
        const earliest = cooldown[0];
        const minutes = Math.max(1, Math.ceil((earliest.resetAt - Date.now()) / 60_000));

        const wrap = document.createElement('div');
        wrap.className = 'gh-banner';

        const icon = document.createElement('span');
        icon.className = 'gh-banner-icon';
        icon.textContent = '⚠';
        wrap.appendChild(icon);

        const text = document.createElement('span');
        text.className = 'gh-banner-text';
        text.textContent = I18n.t(
            'GitHub rate-limit reached on {host}; data from GitHub-hosted projects may be incomplete until ~{min} min from now.',
            {host: earliest.host, min: minutes}
        );
        wrap.appendChild(text);

        const hint = document.createElement('span');
        hint.className = 'gh-banner-hint';
        hint.textContent = I18n.t('Set GH_TOKEN to raise the limit from 60/h to 5000/h.');
        wrap.appendChild(hint);

        return wrap;
    }

}