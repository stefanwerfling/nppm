import 'normalize.css';
import '../main.css';
import {GithubRateLimitPill} from './Widgets/GithubRateLimitPill.js';
import {RegistryStatusPill} from './Widgets/RegistryStatusPill.js';
import {I18n, LANGUAGES} from './Util/I18n.js';
import {ImpactModal} from './Modals/ImpactModal.js';
import {Nppm} from './Nppm.js';
import {SettingsModal} from './Modals/SettingsModal.js';
import {Api} from './Util/Api.js';

/**
 * Embeddable entry point for the nppm frontend.
 *
 * Standalone, `main.ts` still bootstraps nppm against the fixed DOM in
 * `index.html`. For in-process hosting (pkgstudio) this `mount()` does
 * the same job against a caller-provided container and a namespaced
 * API base — without the module-level import side effects of `main.ts`.
 *
 * `Api.setBaseUrl(base)` prefixes the bulk of calls (everything routed
 * through `Api`) at the source. The remaining scattered `/api/...`
 * calls in Pages/Modals/Widgets are handled by the host shell's single
 * request rewrite — a module must not patch `window.fetch` itself, or
 * two mounted modules would fight over it. Standalone (`main.ts`, no
 * `apiBase`) stays byte-identical.
 */
export interface NppmMountOptions {
    /** e.g. "/mod/nppm" — requests to "/api/..." become "/mod/nppm/api/...". */
    apiBase?: string;
}

/** The body of index.html (topbar + main), minus the standalone logo. */
const NPPM_MARKUP = `
  <div class="topbar">
    <span class="topbar-header" id="topbarheader">Node Project Package Manager</span>
    <div class="topbar-spacer"></div>
    <button id="global-scan-btn" class="topbar-btn">Scan all</button>
    <button id="topbar-impact" class="topbar-btn" title="Impact">Impact</button>
    <div id="topbar-registry-pill" class="topbar-registry-pill" style="display:none"></div>
    <div id="topbar-github-pill" class="topbar-github-pill" style="display:none"></div>
    <div class="topbar-lang" id="topbar-lang"></div>
    <button id="topbar-settings" class="topbar-gear" title="Settings" aria-label="Settings">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M19.43 12.98a7.55 7.55 0 0 0 0-1.96l2.1-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.47.99a7.45 7.45 0 0 0-1.7-.99l-.38-2.63a.5.5 0 0 0-.5-.42h-4a.5.5 0 0 0-.5.42l-.38 2.63a7.6 7.6 0 0 0-1.7.99l-2.47-.99a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.1 1.65a7.55 7.55 0 0 0 0 1.96l-2.1 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.47-.99c.52.4 1.09.73 1.7.99l.38 2.63a.5.5 0 0 0 .5.42h4a.5.5 0 0 0 .5-.42l.38-2.63a7.6 7.6 0 0 0 1.7-.99l2.47.99a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.1-1.65zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>
      </svg>
    </button>
    <div id="resizer-topbar" class="resizer"></div>
  </div>
  <div id="main">
    <div id="controls">
      <div class="treeview" id="treeview"></div>
    </div>
    <div id="resizer" class="resizer"></div>
    <div id="list"></div>
  </div>`;

export async function mount(container: HTMLElement, opts: NppmMountOptions = {}): Promise<void> {
    const base = (opts.apiBase ?? '').replace(/\/$/, '');
    if (base) {
        Api.setBaseUrl(base);
    }

    container.classList.add('nppm-root');
    container.innerHTML = NPPM_MARKUP;

    mountLanguagePicker(container);
    mountSettingsButton(container);
    mountImpactButton(container);
    mountGithubRateLimitPill(container);
    mountRegistryPill(container);

    const app = new Nppm();
    await app.start();
}

// --- bootstrap helpers (mirror main.ts, scoped to the container) ---------

function mountLanguagePicker(root: HTMLElement): void {
    const host = root.querySelector<HTMLElement>('#topbar-lang');
    if (!host) {
        return;
    }
    host.innerHTML = '';
    const active = I18n.getLanguage();
    for (const info of LANGUAGES) {
        const btn = document.createElement('button');
        btn.className = 'topbar-flag';
        btn.title = info.label;
        btn.dataset.lang = info.id;
        btn.textContent = info.flag;
        if (info.id === active) {
            btn.classList.add('topbar-flag-active');
        }
        btn.addEventListener('click', (): void => {
            if (info.id === I18n.getLanguage()) {
                return;
            }
            I18n.setLanguage(info.id);
            location.reload();
        });
        host.appendChild(btn);
    }
}

function mountSettingsButton(root: HTMLElement): void {
    const btn = root.querySelector<HTMLButtonElement>('#topbar-settings');
    if (!btn) {
        return;
    }
    btn.title = I18n.t('Settings');
    btn.setAttribute('aria-label', I18n.t('Settings'));
    btn.addEventListener('click', (): void => {
        new SettingsModal().open();
    });
}

function mountImpactButton(root: HTMLElement): void {
    const btn = root.querySelector<HTMLButtonElement>('#topbar-impact');
    if (!btn) {
        return;
    }
    btn.title = I18n.t('Impact analysis');
    btn.textContent = I18n.t('Impact');
    btn.addEventListener('click', (): void => {
        new ImpactModal().open();
    });
}

function mountGithubRateLimitPill(root: HTMLElement): void {
    const host = root.querySelector<HTMLElement>('#topbar-github-pill');
    if (!host) {
        return;
    }
    new GithubRateLimitPill(host).mount();
}

function mountRegistryPill(root: HTMLElement): void {
    const host = root.querySelector<HTMLElement>('#topbar-registry-pill');
    if (!host) {
        return;
    }
    new RegistryStatusPill(host).mount();
}
