import {ApiRegistryStatusResponse} from '../../shared/Api/ApiTypes.js';
import {I18n} from '../Util/I18n.js';

const POLL_INTERVAL_MS = 30_000;

/**
 * Topbar pill for the package-registry / proxy (step 18.6). Polls
 * `/api/registry/status` and, when the proxy is enabled, shows a green
 * `⬢ Registry N pkgs` chip. Hidden while the proxy is off so it doesn't
 * add clutter for users who never turn it on. Clicking it opens the
 * RegistryView — the pill lives outside `Nppm`, so it signals via a
 * `nppm:open-registry` custom event that `Nppm` listens for.
 *
 * Mirrors `GithubRateLimitPill`: self-owned polling, refresh on tab
 * re-focus, no plumbing through the app controller.
 */
export class RegistryStatusPill {

    private readonly _el: HTMLElement;
    private _timer: ReturnType<typeof setInterval>|null = null;

    public constructor(el: HTMLElement) {
        this._el = el;
        this._el.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('nppm:open-registry'));
        });
    }

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
            const res = await fetch('/api/registry/status');
            if (!res.ok) {
                return;
            }
            this._render((await res.json()) as ApiRegistryStatusResponse);
        } catch {
            // Network blip — keep the previous render.
        }
    }

    private _render(status: ApiRegistryStatusResponse): void {
        if (!status.enabled) {
            this._el.style.display = 'none';
            return;
        }
        this._el.style.display = 'inline-flex';
        this._el.className = 'topbar-registry-pill';
        this._el.title = I18n.t('Package registry active — click to open. Upstream: {u}', {u: status.upstream});
        this._el.innerHTML = '';
        const dot = document.createElement('span');
        dot.className = 'topbar-registry-dot';
        this._el.appendChild(dot);
        const label = document.createElement('span');
        label.textContent = I18n.t('Registry');
        this._el.appendChild(label);
        const count = document.createElement('span');
        count.className = 'topbar-registry-count';
        count.textContent = I18n.t('{n} pkgs', {n: String(status.packages)});
        this._el.appendChild(count);
    }

}