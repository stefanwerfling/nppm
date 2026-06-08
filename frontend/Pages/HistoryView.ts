import {
    ApiHistoryBackfillEndEvent,
    ApiHistoryBackfillErrorEvent,
    ApiHistoryBackfillProgressEvent,
    ApiHistoryBackfillStartEvent,
    ApiHistoryResponse
} from '../../shared/Api/ApiTypes.js';
import {HistoryAdded, HistoryEntry, HistoryRemoved, HistoryUpdate} from '../../backend/History/History.js';
import {Api} from '../Util/Api.js';
import {I18n} from '../Util/I18n.js';
import {ProjectNav} from '../Widgets/ProjectNav.js';

/**
 * Per-project timeline of package changes. Lists entries newest-first
 * (the API already reverses) and renders one card per snapshot diff.
 *
 * Shares the right-pane slot with PackageList and InstalledView; the
 * toggle in the header is the same three-button group, so the user
 * stays oriented when switching between the three views of the same
 * project.
 *
 * When the project has a git source, the scan bar above the timeline
 * lets the user reconstruct historical entries from `git log` —
 * lockfile commits first, `package.json` as fallback. This is the
 * same backfill the Vulns view runs, but stops short of the OSV
 * catch-up (History doesn't care about CVE coverage).
 */
export class HistoryView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _nav: ProjectNav|null = null;
    private _entries: HistoryEntry[] = [];
    private _gitAvailable: boolean = false;
    private _gitBackfilledHead: string|null = null;
    private _stream: EventSource|null = null;
    private _scanBtn: HTMLButtonElement|null = null;
    private _progressBar: HTMLElement|null = null;
    private _progressText: HTMLElement|null = null;

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    public setNav(nav: ProjectNav): void {
        this._nav = nav;
    }

    public async show(unid: string, name: string): Promise<void> {
        /*
         * Close any leftover SSE from a previous project — switching
         * mid-backfill drops the stream so the UI doesn't apply a
         * response that belongs elsewhere.
         */
        this._closeStream();

        this._projectUnid = unid;
        this._projectName = name;
        this._renderLoading();

        try {
            const response = await Api.history(unid);

            /*
             * Guard against a stale response if the user switched
             * projects mid-fetch.
             */
            if (this._projectUnid !== unid) {
                return;
            }

            this._applyResponse(response);
            this._render();
        } catch (e) {
            if (this._projectUnid === unid) {
                this._renderError((e as Error).message);
            }
        }
    }

    private _applyResponse(response: ApiHistoryResponse): void {
        this._entries = response.entries;
        this._gitAvailable = response.gitAvailable;
        this._gitBackfilledHead = response.gitBackfilledHead;
    }

    private _closeStream(): void {
        if (this._stream) {
            this._stream.close();
            this._stream = null;
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
        this._root.appendChild(this._renderScanBar());

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

        /*
         * Group consecutive entries by date — entries are already
         * newest-first, so a simple lastDate tracker is enough; no
         * separate Map needed.
         */
        let lastDate = '';
        for (const entry of this._entries) {
            const date = HistoryView._formatDate(entry.timestamp);
            if (date !== lastDate) {
                timeline.appendChild(HistoryView._renderTimelineLabel(date));
                lastDate = date;
            }
            timeline.appendChild(this._renderTimelineItem(entry));
        }

        this._root.appendChild(timeline);
    }

    /**
     * One timeline row: a colored icon sitting on the vertical line,
     * plus the existing entry card to its right. The icon's colour
     * reflects whether the entry was add-only, update-only,
     * remove-only, or a mix.
     */
    private _renderTimelineItem(entry: HistoryEntry): HTMLElement {
        const item = document.createElement('div');
        item.className = 'timeline-item';

        const dominant = HistoryView._dominantKind(entry);
        const icon = document.createElement('div');
        icon.className = `timeline-icon timeline-icon-${dominant.kind}`;
        icon.textContent = dominant.symbol;
        item.appendChild(icon);

        item.appendChild(this._renderEntry(entry));
        return item;
    }

    private static _renderTimelineLabel(date: string): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'timeline-label';
        const pill = document.createElement('span');
        pill.textContent = date;
        wrap.appendChild(pill);
        return wrap;
    }

    /**
     * Classify an entry for icon styling. Pure-add / pure-update /
     * pure-remove get their own colour; anything else is "mixed".
     */
    private static _dominantKind(entry: HistoryEntry): {kind: string; symbol: string;} {
        const a = entry.added.length;
        const u = entry.updated.length;
        const r = entry.removed.length;
        if (a > 0 && u === 0 && r === 0) {
            return {kind: 'added', symbol: '+'};
        }
        if (u > 0 && a === 0 && r === 0) {
            return {kind: 'updated', symbol: '~'};
        }
        if (r > 0 && a === 0 && u === 0) {
            return {kind: 'removed', symbol: '−'};
        }
        return {kind: 'mixed', symbol: '●'};
    }

    /**
     * The bar above the timeline. Same shape as the Vulns view's
     * scan bar (so the two stay visually consistent), but the button
     * only triggers the git backfill — no OSV catch-up.
     */
    private _renderScanBar(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'vuln-scanbar';

        const summary = document.createElement('div');
        summary.className = 'vuln-summary';

        if (this._gitBackfilledHead) {
            const head = document.createElement('button');
            head.type = 'button';
            head.className = 'vuln-summary-pill vuln-summary-pill-soft vuln-summary-pill-clickable';
            head.textContent = I18n.t('git history reconstructed from {sha}', {
                sha: this._gitBackfilledHead.slice(0, 7)
            });
            head.title = I18n.t('Click to re-pull git history');
            head.addEventListener('click', () => this._startBackfill());
            summary.appendChild(head);
        } else if (this._gitAvailable) {
            const hint = document.createElement('button');
            hint.type = 'button';
            hint.className = 'vuln-summary-pill vuln-summary-pill-soft vuln-summary-pill-clickable';
            hint.textContent = I18n.t('git history not yet reconstructed — run a scan');
            hint.title = I18n.t('Click to reconstruct history from git');
            hint.addEventListener('click', () => this._startBackfill());
            summary.appendChild(hint);
        } else {
            const hint = document.createElement('span');
            hint.className = 'vuln-summary-pill vuln-summary-pill-soft';
            hint.textContent = I18n.t('no git source — only live snapshots will appear here');
            summary.appendChild(hint);
        }

        bar.appendChild(summary);

        const btn = document.createElement('button');
        btn.className = 'installed-analyze-btn';
        btn.textContent = this._gitBackfilledHead
            ? I18n.t('Re-pull from git')
            : I18n.t('Backfill from git');
        btn.disabled = !this._gitAvailable;
        if (btn.disabled) {
            btn.title = I18n.t('No git source detected for this project');
        }
        btn.addEventListener('click', () => this._startBackfill());
        this._scanBtn = btn;
        bar.appendChild(btn);

        const progress = document.createElement('div');
        progress.className = 'installed-progress';
        progress.style.display = 'none';
        const fill = document.createElement('div');
        fill.className = 'installed-progress-fill';
        progress.appendChild(fill);
        bar.appendChild(progress);
        this._progressBar = fill;

        const text = document.createElement('div');
        text.className = 'installed-progress-text';
        text.style.display = 'none';
        bar.appendChild(text);
        this._progressText = text;

        return bar;
    }

    private _startBackfill(): void {
        if (!this._projectUnid || this._stream || !this._gitAvailable) {
            return;
        }
        const unid = this._projectUnid;

        if (this._scanBtn) {
            this._scanBtn.disabled = true;
        }
        if (this._progressBar) {
            this._progressBar.parentElement!.style.display = '';
            this._progressBar.style.width = '0%';
        }
        if (this._progressText) {
            this._progressText.style.display = '';
            this._progressText.textContent = I18n.t('Starting …');
        }

        const url = Api.historyBackfillUrl(unid);
        const es = new EventSource(url);
        this._stream = es;

        es.addEventListener('start', (ev: MessageEvent<string>) => {
            const data = JSON.parse(ev.data) as ApiHistoryBackfillStartEvent;
            if (this._progressText) {
                this._progressText.textContent = data.backfillRequired
                    ? I18n.t('Reconstructing git history …')
                    : I18n.t('Already up to date — re-checking …');
            }
        });

        es.addEventListener('progress', (ev: MessageEvent<string>) => {
            const data = JSON.parse(ev.data) as ApiHistoryBackfillProgressEvent;
            const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
            if (this._progressBar) {
                this._progressBar.style.width = `${pct}%`;
            }
            if (this._progressText) {
                this._progressText.textContent = I18n.t(
                    'Reconstructing git history ({current}/{total}) …',
                    {current: String(data.current), total: String(data.total)}
                );
            }
        });

        es.addEventListener('end', (ev: MessageEvent<string>) => {
            const data = JSON.parse(ev.data) as ApiHistoryBackfillEndEvent;
            if (this._projectUnid === unid) {
                this._entries = data.entries;
                this._gitBackfilledHead = data.gitBackfilledHead;
                this._closeStream();
                this._render();
            }
        });

        es.addEventListener('error', (ev) => {
            const data = ev instanceof MessageEvent && typeof ev.data === 'string'
                ? (JSON.parse(ev.data) as ApiHistoryBackfillErrorEvent)
                : {msg: I18n.t('Connection to backfill lost')};
            this._closeStream();
            if (this._projectUnid !== unid) {
                return;
            }
            if (this._progressText) {
                this._progressText.textContent = data.msg;
            }
            if (this._scanBtn) {
                this._scanBtn.disabled = !this._gitAvailable;
            }
        });
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

        /*
         * package.json-derived entries carry declared ranges, not
         * resolved versions — surface that explicitly so the user
         * doesn't expect the Vulns view to cover them.
         */
        if (entry.lockfileSource === 'package-json') {
            const pill = document.createElement('span');
            pill.className = 'history-pill history-pill-declared';
            pill.textContent = I18n.t('declared-only');
            pill.title = I18n.t('Entry parsed from package.json — version ranges, no CVE coverage in Vulns view.');
            head.appendChild(pill);
        }

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

        if (this._nav) {
            header.appendChild(this._nav.renderToggle(this._projectUnid, 'history'));
        }

        return header;
    }

    private static _formatTime(ms: number): string {
        const d = new Date(ms);
        const pad = (n: number): string => n.toString().padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    private static _formatDate(ms: number): string {
        const d = new Date(ms);
        const pad = (n: number): string => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

}