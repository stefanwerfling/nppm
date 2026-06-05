import 'normalize.css';
import './main.css';
import {I18n, LANGUAGES} from './frontend/I18n.js';
import {ImpactModal} from './frontend/ImpactModal.js';
import {Nppm} from './frontend/Nppm.js';
import {SettingsModal} from './frontend/SettingsModal.js';

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

}

/**
 * One-shot bootstrap glue: wires the two topbar buttons (gear,
 * Impact) whose markup lives in `index.html` to their respective
 * modals and applies the active-locale title strings. Kept as a
 * class so the file has no module-level free functions.
 */
class Bootstrap {

    public static mountSettingsButton(): void {
        const btn = document.getElementById('topbar-settings');
        if (!btn) {
            return;
        }
        btn.title = I18n.t('Settings');
        btn.setAttribute('aria-label', I18n.t('Settings'));
        btn.addEventListener('click', (): void => {
            new SettingsModal().open();
        });
    }

    public static mountImpactButton(): void {
        const btn = document.getElementById('topbar-impact');
        if (!btn) {
            return;
        }
        btn.title = I18n.t('Impact analysis');
        btn.textContent = I18n.t('Impact');
        btn.addEventListener('click', (): void => {
            new ImpactModal().open();
        });
    }

}

LanguagePicker.mount();
Bootstrap.mountSettingsButton();
Bootstrap.mountImpactButton();

const app = new Nppm();
void app.start();