import 'normalize.css';
import './main.css';
import {getLanguage, LANGUAGES, setLanguage} from './Frontend/I18n.js';
import {Nppm} from './Frontend/Nppm.js';

/**
 * Build the language picker into the topbar from the `LANGUAGES`
 * registry. Adding a new locale is then a single edit in `I18n.ts`
 * — the DOM updates itself the next page load. Switching reloads
 * the page; the alternative (re-render every view in-place) is more
 * error-prone for nppm's ~150 strings.
 */
function mountLanguagePicker(): void {
    const host = document.getElementById('topbar-lang');
    if (!host) {
        return;
    }
    host.innerHTML = '';
    const active = getLanguage();
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
            if (info.id === getLanguage()) {
                return;
            }
            setLanguage(info.id);
            location.reload();
        });
        host.appendChild(btn);
    }
}

mountLanguagePicker();

const app = new Nppm();
void app.start();