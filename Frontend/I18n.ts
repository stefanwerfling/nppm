import {TRANSLATIONS_DE} from './Locales/de.js';
import {TRANSLATIONS_EN} from './Locales/en.js';

/**
 * Adding a language is a three-step operation, in order:
 *   1. Create `Frontend/Locales/<code>.ts` exporting
 *      `TRANSLATIONS_<CODE>: Record<string, string>` — same keys as
 *      `en.ts`, missing keys fall back to English.
 *   2. Add the new locale to the `LANGUAGES` array below.
 *   3. Add it to `LOCALES` so the runtime can find its translation
 *      map.
 *
 * Adding a string anywhere in the UI: call `t('Some text')` directly.
 * If the new key is not in `en.ts`/`de.ts` it shows the English
 * source verbatim — translations can catch up later without breaking
 * the UI.
 */
export type Language = 'en'|'de';

export type LanguageInfo = {
    id: Language;
    /** Display name in the language's own writing (used in the picker tooltip). */
    label: string;
    /** Emoji flag for the picker button. */
    flag: string;
};

export const LANGUAGES: readonly LanguageInfo[] = [
    {id: 'en', label: 'English', flag: '🇬🇧'},
    {id: 'de', label: 'Deutsch', flag: '🇩🇪'}
];

/**
 * Registry of locale → translation-map. Stays in lockstep with
 * `LANGUAGES`; adding a new locale here without an entry above (or
 * vice versa) is a developer-side bug.
 */
const LOCALES: Record<Language, Record<string, string>> = {
    en: TRANSLATIONS_EN,
    de: TRANSLATIONS_DE
};

export const DEFAULT_LANG: Language = 'en';
const STORAGE_KEY = 'nppm.lang';

const listeners: (() => void)[] = [];
let current: Language = loadLanguage();

function isLanguage(v: unknown): v is Language {
    return typeof v === 'string' && LANGUAGES.some((l) => l.id === v);
}

function loadLanguage(): Language {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (isLanguage(raw)) {
            return raw;
        }
    } catch {
        // localStorage disabled (private mode etc.) — fall through.
    }
    return DEFAULT_LANG;
}

/**
 * Look up `text` in the current language. Falls back through
 *   current locale → default locale (`en`) → source string
 * so even an untranslated string never renders empty.
 *
 * `params` substitutes `{key}` placeholders.
 */
export function t(text: string, params?: Record<string, string|number>): string {
    const fromCurrent = LOCALES[current]?.[text];
    const fromDefault = LOCALES[DEFAULT_LANG]?.[text];
    let result = fromCurrent ?? fromDefault ?? text;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            result = result.split(`{${k}}`).join(String(v));
        }
    }
    return result;
}

export function getLanguage(): Language {
    return current;
}

/**
 * Persist + notify. Listeners fire synchronously so a picker can
 * refresh its visuals before any subsequent navigation.
 */
export function setLanguage(lang: Language): void {
    if (lang === current || !LANGUAGES.some((l) => l.id === lang)) {
        return;
    }
    current = lang;
    try {
        localStorage.setItem(STORAGE_KEY, lang);
    } catch {
        // best-effort
    }
    for (const fn of listeners) {
        fn();
    }
}

export function onLanguageChange(handler: () => void): void {
    listeners.push(handler);
}