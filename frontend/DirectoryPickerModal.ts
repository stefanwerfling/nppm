import {ApiFsBrowseResponse} from '../shared/Api/ApiTypes.js';
import {I18n} from './I18n.js';

/**
 * Lightweight directory picker. Backend-driven because browsers
 * cannot return absolute filesystem paths — `<input
 * type="file" webkitdirectory>` and `showDirectoryPicker()` both
 * deliberately hide them. The dev server runs on the user's box, so
 * `GET /api/fs/browse` walks real directories.
 *
 * Usage: instantiate, optionally seed with an initial path, attach
 * an `onPicked` callback, and call `open()`. The callback fires with
 * the absolute selected path; the modal closes itself on select +
 * cancel + Escape. Re-uses the `umd-*` shell; navigation entries +
 * actions live under their own `dpm-*` namespace.
 */
export class DirectoryPickerModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _currentPath: string|null = null;
    private _parent: string|null = null;
    private _entries: {name: string; type: 'dir'|'file'}[] = [];
    private _showHidden = false;
    private _initial: string|undefined;
    private _onPicked: ((absPath: string) => void)|null = null;

    public seedPath(path: string|undefined): void {
        this._initial = path && path.length > 0 ? path : undefined;
    }

    public onPicked(handler: (absPath: string) => void): void {
        this._onPicked = handler;
    }

    public open(): void {
        this._mount();
        void this._load(this._initial);
    }

    public close(): void {
        this._backdrop?.remove();
        this._backdrop = null;
        this._panel = null;
        document.removeEventListener('keydown', this._onKeyDown);
    }

    private _mount(): void {
        if (this._backdrop) {
            this._backdrop.remove();
        }
        const backdrop = document.createElement('div');
        backdrop.className = 'umd-backdrop dpm-backdrop';
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) {
                this.close();
            }
        });
        document.body.appendChild(backdrop);
        this._backdrop = backdrop;

        const panel = document.createElement('div');
        panel.className = 'umd-panel dpm-panel';
        backdrop.appendChild(panel);
        this._panel = panel;

        document.addEventListener('keydown', this._onKeyDown);

        this._panel.appendChild(this._renderHeader());
        const loading = document.createElement('div');
        loading.className = 'umd-loading';
        loading.textContent = I18n.t('Loading …');
        this._panel.appendChild(loading);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    /**
     * Fetch `path` (or backend default when omitted) and render the
     * result. On error, swap the body for an error banner and a
     * "go home" affordance so the user isn't stuck.
     */
    private async _load(path: string|undefined): Promise<void> {
        try {
            const qs = new URLSearchParams();
            if (path) {
                qs.set('path', path);
            }
            if (this._showHidden) {
                qs.set('showHidden', '1');
            }
            const res = await fetch(`/api/fs/browse?${qs.toString()}`);
            if (!res.ok) {
                this._renderError(`HTTP ${res.status} — ${await res.text()}`);
                return;
            }
            const data = await res.json() as ApiFsBrowseResponse;
            this._currentPath = data.path;
            this._parent = data.parent;
            this._entries = data.entries;
        } catch (e) {
            this._renderError((e as Error).message);
            return;
        }
        this._render();
    }

    private _renderHeader(): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = I18n.t('Select a directory');
        head.appendChild(title);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    private _render(): void {
        if (!this._panel) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());
        this._panel.appendChild(this._renderPathBar());
        this._panel.appendChild(this._renderEntries());
        this._panel.appendChild(this._renderHiddenToggle());
        this._panel.appendChild(this._renderActions());
    }

    private _renderPathBar(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'dpm-pathbar';

        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'umd-btn dpm-up';
        up.textContent = '↑';
        up.title = I18n.t('Parent directory');
        if (!this._parent) {
            up.disabled = true;
        }
        up.addEventListener('click', () => {
            if (this._parent) {
                void this._load(this._parent);
            }
        });
        bar.appendChild(up);

        const cur = document.createElement('div');
        cur.className = 'dpm-current';
        cur.textContent = this._currentPath ?? '';
        cur.title = this._currentPath ?? '';
        bar.appendChild(cur);

        return bar;
    }

    private _renderEntries(): HTMLElement {
        const list = document.createElement('div');
        list.className = 'dpm-entries';
        if (this._entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'umd-note';
            empty.textContent = I18n.t('(empty directory)');
            list.appendChild(empty);
            return list;
        }
        for (const e of this._entries) {
            const row = document.createElement('div');
            row.className = `dpm-row dpm-row-${e.type}`;
            const icon = document.createElement('span');
            icon.className = 'dpm-icon';
            icon.textContent = e.type === 'dir' ? '📁' : '📄';
            row.appendChild(icon);
            const name = document.createElement('span');
            name.className = 'dpm-name';
            name.textContent = e.name;
            row.appendChild(name);
            if (e.type === 'dir') {
                row.addEventListener('click', () => {
                    if (!this._currentPath) {
                        return;
                    }
                    const nextPath = this._joinPath(this._currentPath, e.name);
                    void this._load(nextPath);
                });
            }
            list.appendChild(row);
        }
        return list;
    }

    private _renderHiddenToggle(): HTMLElement {
        const row = document.createElement('label');
        row.className = 'dpm-hidden-toggle';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = this._showHidden;
        input.addEventListener('change', () => {
            this._showHidden = input.checked;
            if (this._currentPath) {
                void this._load(this._currentPath);
            }
        });
        row.appendChild(input);
        const span = document.createElement('span');
        span.textContent = I18n.t('Show hidden files');
        row.appendChild(span);
        return row;
    }

    private _renderActions(): HTMLElement {
        const actions = document.createElement('div');
        actions.className = 'umd-actions';
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'umd-btn umd-btn-primary';
        pick.textContent = I18n.t('Select this directory');
        pick.disabled = !this._currentPath;
        pick.addEventListener('click', () => {
            if (this._currentPath && this._onPicked) {
                this._onPicked(this._currentPath);
            }
            this.close();
        });
        actions.appendChild(pick);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Cancel');
        cancel.addEventListener('click', () => this.close());
        actions.appendChild(cancel);
        return actions;
    }

    /**
     * POSIX-style join — the backend reports POSIX paths even on
     * Linux/macOS; Windows hosts would need an addition here, but
     * nppm targets POSIX dev environments (the matrix-screenshot
     * pipeline and the IDE-URL handlers already assume `/`).
     */
    private _joinPath(parent: string, child: string): string {
        if (parent.endsWith('/')) {
            return parent + child;
        }
        return `${parent}/${child}`;
    }

    private _renderError(msg: string): void {
        if (!this._panel) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());
        const err = document.createElement('div');
        err.className = 'umd-error';
        err.textContent = msg;
        this._panel.appendChild(err);
        const actions = document.createElement('div');
        actions.className = 'umd-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Close');
        cancel.addEventListener('click', () => this.close());
        actions.appendChild(cancel);
        this._panel.appendChild(actions);
    }
}