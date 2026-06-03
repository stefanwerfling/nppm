import 'normalize.css';
import './main.css';
import {I18n, LANGUAGES} from './Frontend/I18n.js';
import {ImpactModal} from './Frontend/ImpactModal.js';
import {Nppm} from './Frontend/Nppm.js';
import {SettingsModal} from './Frontend/SettingsModal.js';

/**
 * Topbar language picker. Static `mount()` builds the DOM from the
 * `LANGUAGES` registry — adding a new locale is then a single edit
 * in `I18n.ts` and the DOM updates itself on the next page load.
 * Switching reloads the page; re-rendering every view in-place would
 * be more error-prone for nppm's ~150 strings.
 */
class LanguagePicker {

    public static mount(): void {
        const host = document.getElementById('topbar-lang');
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
            btn.addEventListener('click', () => {
                if (info.id === I18n.getLanguage()) {
                    return;
                }
                I18n.setLanguage(info.id);
                location.reload();
            });
            host.appendChild(btn);
        }
    }
}

LanguagePicker.mount();

/**
 * Mount the gear button → SettingsModal handler. The button itself
 * lives in `index.html` (so the markup-side title attribute is
 * static); here we translate the title to the active locale and
 * wire the click. One-shot at boot — the button never moves.
 */
function mountSettingsButton(): void {
    const btn = document.getElementById('topbar-settings');
    if (!btn) {
        return;
    }
    btn.title = I18n.t('Settings');
    btn.setAttribute('aria-label', I18n.t('Settings'));
    btn.addEventListener('click', () => {
        new SettingsModal().open();
    });
}

mountSettingsButton();

/**
 * Topbar Impact button → ImpactModal. Same pattern as the gear button:
 * markup lives in `index.html`, click handler + i18n title wired here.
 */
function mountImpactButton(): void {
    const btn = document.getElementById('topbar-impact');
    if (!btn) {
        return;
    }
    btn.title = I18n.t('Impact analysis');
    btn.textContent = I18n.t('Impact');
    btn.addEventListener('click', () => {
        new ImpactModal().open();
    });
}

mountImpactButton();

const app = new Nppm();
void app.start();