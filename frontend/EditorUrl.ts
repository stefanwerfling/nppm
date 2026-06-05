/**
 * URL-handler translator for the "Open in IDE" affordance.
 *
 * Each editor exposes a custom URL scheme that the OS forwards to the
 * running app: VSCode-family (`vscode://`, `vscodium://`, `cursor://`)
 * use `file/<path>`; JetBrains tools (`phpstorm://`, `webstorm://`,
 * `idea://`) use `open?file=<path>`; Sublime uses `open?url=file://<path>`.
 *
 * `editor` is the raw string from `nppm.json` → `actions.editor`. An
 * unknown key returns `null` so the caller can hide the button instead
 * of generating a broken link.
 */
export class EditorUrl {

    /**
     * Build the IDE URL for an absolute filesystem path. POSIX-only
     * for v1: the path is assumed to start with `/`, which gives the
     * required `vscode://file//abs/path` double-slash naturally for
     * the VSCode family.
     *
     * Returns `null` for unsupported editor keys.
     */
    public static build(editor: string|undefined, absPath: string): string|null {
        if (!editor) {
            return null;
        }
        switch (editor) {
            case 'vscode':
                return `vscode://file${absPath}`;
            case 'vscodium':
                return `vscodium://file${absPath}`;
            case 'cursor':
                return `cursor://file${absPath}`;
            case 'phpstorm':
                return `phpstorm://open?file=${encodeURIComponent(absPath)}`;
            case 'webstorm':
                return `webstorm://open?file=${encodeURIComponent(absPath)}`;
            case 'idea':
                return `idea://open?file=${encodeURIComponent(absPath)}`;
            case 'subl':
                return `subl://open?url=file://${encodeURIComponent(absPath)}`;
            default:
                return null;
        }
    }

    /**
     * Friendly label for the configured editor — shown in the button
     * tooltip ("Open in PhpStorm"). Falls back to the raw key so a
     * future addition doesn't crash the UI before this map gets a
     * new entry.
     */
    public static label(editor: string|undefined): string {
        if (!editor) {
            return '';
        }
        switch (editor) {
            case 'vscode':   return 'VS Code';
            case 'vscodium': return 'VSCodium';
            case 'cursor':   return 'Cursor';
            case 'phpstorm': return 'PhpStorm';
            case 'webstorm': return 'WebStorm';
            case 'idea':     return 'IntelliJ IDEA';
            case 'subl':     return 'Sublime Text';
            default:         return editor;
        }
    }
}