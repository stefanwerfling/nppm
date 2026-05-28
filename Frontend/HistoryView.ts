import {HistoryAdded, HistoryEntry, HistoryRemoved, HistoryUpdate} from '../History/History.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';

/**
 * Per-project timeline of package changes. Lists entries newest-first
 * (the API already reverses) and renders one card per snapshot diff.
 *
 * Shares the right-pane slot with PackageList and InstalledView; the
 * toggle in the header is the same three-button group, so the user
 * stays oriented when switching between the three views of the same
 * project.
 */
export class HistoryView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowInstalled: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _onShowUnused: ((unid: string) => void)|null = null;
    private _entries: HistoryEntry[] = [];

    constructor(root: HTMLElement) {
        this._root = root;
    }

    public onShowDeclared(handler: (unid: string) => void): void {
        this._onShowDeclared = handler;
    }

    public onShowInstalled(handler: (unid: string) => void): void {
        this._onShowInstalled = handler;
    }

    public onShowMatrix(handler: (unid: string) => void): void {
        this._onShowMatrix = handler;
    }

    public onShowTree(handler: (unid: string) => void): void {
        this._onShowTree = handler;
    }

    public onShowUnused(handler: (unid: string) => void): void {
        this._onShowUnused = handler;
    }

    public async show(unid: string, name: string): Promise<void> {
        this._projectUnid = unid;
        this._projectName = name;
        this._renderLoading();

        try {
            const response = await Api.history(unid);

            // Guard against a stale response if the user switched
            // projects mid-fetch.
            if (this._projectUnid !== unid) {
                return;
            }

            this._entries = response.entries;
            this._render();
        } catch (e) {
            if (this._projectUnid === unid) {
                this._renderError((e as Error).message);
            }
        }
    }

    private _renderLoading(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());
        const hint = document.createElement('div');
        hint.className = 'list-placeholder';
        hint.textContent = I18n.t('Loading history …');
        this._root.appendChild(hint);
    }

    private _renderError(msg: string): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());
        const err = document.createElement('div');
        err.className = 'list-error';
        err.textContent = msg;
        this._root.appendChild(err);
    }

    private _render(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());

        if (this._entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'list-placeholder';
            empty.textContent = I18n.t(
                'Currently no history. Whenever the project\'s packages change, a new entry shows up here (a snapshot is checked on every lockfile call).'
            );
            this._root.appendChild(empty);
            return;
        }

        const timeline = document.createElement('div');
        timeline.className = 'history-timeline';

        for (const entry of this._entries) {
            timeline.appendChild(this._renderEntry(entry));
        }

        this._root.appendChild(timeline);
    }

    private _renderEntry(entry: HistoryEntry): HTMLElement {
        const card = document.createElement('div');
        card.className = 'history-card';

        const head = document.createElement('div');
        head.className = 'history-card-head';

        const when = document.createElement('div');
        when.className = 'history-when';
        when.textContent = HistoryView._formatTime(entry.timestamp);
        head.appendChild(when);

        const source = document.createElement('div');
        source.className = 'history-source';
        source.textContent = I18n.t('Source: {source}', {source: entry.lockfileSource});
        head.appendChild(source);

        const counts = document.createElement('div');
        counts.className = 'history-counts';
        counts.innerHTML = `
            <span class="history-count history-count-added">+${entry.added.length}</span>
            <span class="history-count history-count-updated">~${entry.updated.length}</span>
            <span class="history-count history-count-removed">-${entry.removed.length}</span>
        `;
        head.appendChild(counts);

        card.appendChild(head);

        if (entry.updated.length > 0) {
            card.appendChild(this._renderUpdatedSection(entry.updated));
        }
        if (entry.added.length > 0) {
            card.appendChild(this._renderListSection(I18n.t('Added'), entry.added, 'added'));
        }
        if (entry.removed.length > 0) {
            card.appendChild(this._renderListSection(I18n.t('Removed'), entry.removed, 'removed'));
        }

        return card;
    }

    private _renderUpdatedSection(updates: HistoryUpdate[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'history-section';

        const heading = document.createElement('div');
        heading.className = 'history-section-head';
        heading.textContent = `${I18n.t('Updated')} (${updates.length})`;
        wrap.appendChild(heading);

        const list = document.createElement('div');
        list.className = 'history-list';

        for (const u of updates) {
            const row = document.createElement('div');
            row.className = 'history-row history-row-updated';

            const name = document.createElement('span');
            name.className = 'history-row-name';
            name.textContent = u.name;
            row.appendChild(name);

            const range = document.createElement('span');
            range.className = 'history-row-range';
            range.textContent = `${u.fromVersion} → ${u.toVersion}`;
            row.appendChild(range);

            const reason = document.createElement('span');
            reason.className = 'history-row-reason';
            reason.textContent = u.reason;
            row.appendChild(reason);

            list.appendChild(row);
        }

        wrap.appendChild(list);
        return wrap;
    }

    private _renderListSection(
        title: string,
        items: (HistoryAdded|HistoryRemoved)[],
        cls: 'added'|'removed'
    ): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'history-section';

        const heading = document.createElement('div');
        heading.className = 'history-section-head';
        heading.textContent = `${title} (${items.length})`;
        wrap.appendChild(heading);

        const list = document.createElement('div');
        list.className = 'history-list';

        for (const item of items) {
            const row = document.createElement('div');
            row.className = `history-row history-row-${cls}`;
            row.textContent = `${item.name}@${item.version}`;
            list.appendChild(row);
        }

        wrap.appendChild(list);
        return wrap;
    }

    /**
     * Header with the three-way toggle. Mirrors the toggle in
     * `PackageList` and `InstalledView` so the user sees the same
     * control regardless of which view they're in.
     */
    private _renderHeader(): HTMLElement {
        const header = document.createElement('div');
        header.className = 'list-header installed-header';

        const title = document.createElement('div');
        title.className = 'installed-title';
        title.textContent = this._projectName ?? '';
        header.appendChild(title);

        const toggle = document.createElement('div');
        toggle.className = 'installed-toggle';

        const declared = document.createElement('button');
        declared.className = 'installed-toggle-btn';
        declared.textContent = I18n.t('Declared');
        declared.addEventListener('click', () => {
            if (this._projectUnid && this._onShowDeclared) {
                this._onShowDeclared(this._projectUnid);
            }
        });
        toggle.appendChild(declared);

        const installed = document.createElement('button');
        installed.className = 'installed-toggle-btn';
        installed.textContent = I18n.t('Installed');
        installed.addEventListener('click', () => {
            if (this._projectUnid && this._onShowInstalled) {
                this._onShowInstalled(this._projectUnid);
            }
        });
        toggle.appendChild(installed);

        const history = document.createElement('button');
        history.className = 'installed-toggle-btn installed-toggle-btn-active';
        history.textContent = I18n.t('History');
        toggle.appendChild(history);

        const matrix = document.createElement('button');
        matrix.className = 'installed-toggle-btn';
        matrix.textContent = I18n.t('Matrix');
        matrix.addEventListener('click', () => {
            if (this._projectUnid && this._onShowMatrix) {
                this._onShowMatrix(this._projectUnid);
            }
        });
        toggle.appendChild(matrix);

        const tree = document.createElement('button');
        tree.className = 'installed-toggle-btn';
        tree.textContent = I18n.t('Tree');
        tree.addEventListener('click', () => {
            if (this._projectUnid && this._onShowTree) {
                this._onShowTree(this._projectUnid);
            }
        });
        toggle.appendChild(tree);

        const unused = document.createElement('button');
        unused.className = 'installed-toggle-btn';
        unused.textContent = I18n.t('Unused');
        unused.addEventListener('click', () => {
            if (this._projectUnid && this._onShowUnused) {
                this._onShowUnused(this._projectUnid);
            }
        });
        toggle.appendChild(unused);

        header.appendChild(toggle);
        return header;
    }

    private static _formatTime(ms: number): string {
        const d = new Date(ms);
        const pad = (n: number): string => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
            + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
}