import 'normalize.css';
import './main.css';
import {I18n, LANGUAGES} from './Frontend/I18n.js';
import {Nppm} from './Frontend/Nppm.js';

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

const app = new Nppm();
void app.start();