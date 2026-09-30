import {
    ApiRegistryHistoryDay,
    ApiRegistryLogEntry,
    ApiRegistryPackage,
    ApiRegistryProjectStat,
    ApiRegistryStatusResponse
} from '../../shared/Api/ApiTypes.js';
import {Api} from '../Util/Api.js';
import {I18n} from '../Util/I18n.js';

type TabId = 'mirror'|'log'|'projects';

/**
 * Right-pane view for the package-registry / proxy (step 18.6 +
 * per-project extension). Reached via the treeview's `⬢ Registry`
 * sentinel and the topbar status pill. Shows whether the proxy is on,
 * how to point npm at it (globally or per project via the
 * `/registry/<project>` segment), and — under three horizontal tabs —
 * the on-disk mirror (`Aktueller Spiegel`, now with per-package hits),
 * a live feed of proxy requests (`Live requests`), and the per-project
 * tallies + rolling history (`Projects`).
 *
 * Self-contained: owns its own status/packages/history fetches, the log
 * EventSource, and the "Clear store" action. A single log stream lives
 * at a time — reopening (another `show()`) closes the previous one.
 */
export class RegistryView {

    private readonly _root: HTMLElement;
    private _scaffolded = false;
    private _stream: EventSource|null = null;
    private _statusEl: HTMLElement|null = null;
    private _connectEl: HTMLElement|null = null;
    private _tableEl: HTMLElement|null = null;
    private _logEl: HTMLElement|null = null;
    private _projectsEl: HTMLElement|null = null;
    private _activeTab: TabId = 'mirror';
    private readonly _tabButtons = new Map<TabId, HTMLButtonElement>();
    private readonly _tabPanels = new Map<TabId, HTMLElement>();

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    /**
     * Build the scaffold once, then refresh status + packages +
     * projects and (re)open the live log. Idempotent — safe to call on
     * every navigation to the sentinel.
     */
    public show(): void {
        if (!this._scaffolded) {
            this._renderScaffold();
            this._scaffolded = true;
        }
        void this._refresh();
        this._openLog();
    }

    private _renderScaffold(): void {
        this._root.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'reg-head';
        const title = document.createElement('h1');
        title.className = 'reg-title';
        title.textContent = I18n.t('Registry / Proxy');
        head.appendChild(title);
        const actions = document.createElement('div');
        actions.className = 'reg-head-actions';
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'umd-btn reg-clear-btn';
        clearBtn.textContent = I18n.t('Clear store');
        clearBtn.addEventListener('click', () => {
            void this._clear(clearBtn);
        });
        actions.appendChild(clearBtn);
        head.appendChild(actions);
        this._root.appendChild(head);

        this._statusEl = document.createElement('div');
        this._statusEl.className = 'reg-status';
        this._root.appendChild(this._statusEl);

        this._connectEl = document.createElement('div');
        this._connectEl.className = 'reg-connect';
        this._root.appendChild(this._connectEl);

        this._renderTabs();
    }

    /**
     * Horizontal tab bar + the three panels (mirror / log / projects).
     * The mirror panel starts active; switching just toggles a class so
     * the log EventSource keeps streaming in the background.
     */
    private _renderTabs(): void {
        const bar = document.createElement('div');
        bar.className = 'reg-tabbar';
        const tabs: {id: TabId; label: string;}[] = [
            {id: 'mirror', label: I18n.t('Current mirror')},
            {id: 'log', label: I18n.t('Live requests')},
            {id: 'projects', label: I18n.t('Projects')}
        ];
        for (const tab of tabs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'reg-tab';
            btn.textContent = tab.label;
            btn.addEventListener('click', () => this._selectTab(tab.id));
            bar.appendChild(btn);
            this._tabButtons.set(tab.id, btn);
        }
        this._root.appendChild(bar);

        const mirrorPanel = document.createElement('div');
        mirrorPanel.className = 'reg-panel';
        const tableWrap = document.createElement('div');
        tableWrap.className = 'reg-table-wrap';
        this._tableEl = document.createElement('div');
        this._tableEl.className = 'reg-table';
        tableWrap.appendChild(this._tableEl);
        mirrorPanel.appendChild(tableWrap);
        this._root.appendChild(mirrorPanel);
        this._tabPanels.set('mirror', mirrorPanel);

        const logPanel = document.createElement('div');
        logPanel.className = 'reg-panel';
        this._logEl = document.createElement('div');
        this._logEl.className = 'reg-log';
        logPanel.appendChild(this._logEl);
        this._root.appendChild(logPanel);
        this._tabPanels.set('log', logPanel);

        const projectsPanel = document.createElement('div');
        projectsPanel.className = 'reg-panel';
        this._projectsEl = document.createElement('div');
        this._projectsEl.className = 'reg-projects';
        projectsPanel.appendChild(this._projectsEl);
        this._root.appendChild(projectsPanel);
        this._tabPanels.set('projects', projectsPanel);

        this._selectTab(this._activeTab);
    }

    private _selectTab(id: TabId): void {
        this._activeTab = id;
        for (const [tabId, btn] of this._tabButtons) {
            btn.classList.toggle('reg-tab-active', tabId === id);
        }
        for (const [tabId, panel] of this._tabPanels) {
            panel.classList.toggle('reg-panel-active', tabId === id);
        }
        if (id === 'projects') {
            void this._refreshHistory();
        }
    }

    private async _refresh(): Promise<void> {
        try {
            const [status, pkgs] = await Promise.all([Api.registryStatus(), Api.registryPackages()]);
            this._renderStatus(status);
            this._renderConnect(status);
            this._renderTable(pkgs.packages);
            this._renderProjectsSummary(status.projects);
        } catch (e) {
            if (this._statusEl) {
                this._statusEl.textContent = (e as Error).message;
            }
        }
    }

    private _renderStatus(status: ApiRegistryStatusResponse): void {
        if (!this._statusEl) {
            return;
        }
        this._statusEl.innerHTML = '';
        const stat = (label: string, value: string, cls = ''): HTMLElement => {
            const box = document.createElement('div');
            box.className = 'reg-stat';
            const k = document.createElement('div');
            k.className = 'reg-stat-k';
            k.textContent = label;
            const v = document.createElement('div');
            v.className = `reg-stat-v ${cls}`;
            v.textContent = value;
            box.appendChild(k);
            box.appendChild(v);
            return box;
        };
        this._statusEl.appendChild(stat(
            I18n.t('Status'),
            status.enabled ? I18n.t('● active') : I18n.t('○ disabled'),
            status.enabled ? 'reg-on' : 'reg-off'
        ));
        this._statusEl.appendChild(stat(I18n.t('Upstream'), status.upstream));
        this._statusEl.appendChild(stat(I18n.t('Packages'), String(status.packages)));
        this._statusEl.appendChild(stat(I18n.t('Versions'), String(status.versions)));
        this._statusEl.appendChild(stat(I18n.t('Store size'), RegistryView._fmtBytes(status.totalBytes)));
        this._statusEl.appendChild(stat(
            I18n.t('Hits / misses'),
            `${status.hits} / ${status.misses}`
        ));
    }

    private _renderConnect(status: ApiRegistryStatusResponse): void {
        if (!this._connectEl) {
            return;
        }
        this._connectEl.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'reg-connect-head';
        head.textContent = I18n.t('Point npm at nppm');
        this._connectEl.appendChild(head);

        const url = `${window.location.origin}${status.mountPath}`;
        this._connectEl.appendChild(RegistryView._cmdRow(`npm config set registry ${url}`));
        this._connectEl.appendChild(RegistryView._cmdRow(
            `registry=${url}/<project>`,
            I18n.t('# per-project in .npmrc — buckets requests under <project>')
        ));

        if (!status.enabled) {
            const note = document.createElement('div');
            note.className = 'reg-connect-note';
            note.textContent = I18n.t(
                'The proxy is currently disabled. Enable it in Settings → Registry to serve packages.'
            );
            this._connectEl.appendChild(note);
        }
    }

    private static _cmdRow(cmd: string, comment?: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'reg-cmd';
        const code = document.createElement('code');
        if (comment) {
            const c = document.createElement('span');
            c.className = 'reg-cmd-comment';
            c.textContent = `${comment}\n`;
            code.appendChild(c);
        }
        code.appendChild(document.createTextNode(cmd));
        row.appendChild(code);
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'reg-copy';
        copy.textContent = I18n.t('Copy');
        copy.addEventListener('click', () => {
            void navigator.clipboard?.writeText(cmd).catch(() => undefined);
            const prev = copy.textContent;
            copy.textContent = I18n.t('✓ copied');
            copy.classList.add('reg-copy-done');
            window.setTimeout(() => {
                copy.textContent = prev;
                copy.classList.remove('reg-copy-done');
            }, 1400);
        });
        row.appendChild(copy);
        return row;
    }

    private _renderTable(packages: ApiRegistryPackage[]): void {
        if (!this._tableEl) {
            return;
        }
        this._tableEl.innerHTML = '';
        if (packages.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'reg-empty';
            empty.textContent = I18n.t('No packages mirrored yet. Run an install through nppm to fill the store.');
            this._tableEl.appendChild(empty);
            return;
        }
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        for (const label of [I18n.t('Package'), I18n.t('Versions'), I18n.t('Store size'), I18n.t('Hits')]) {
            const th = document.createElement('th');
            th.textContent = label;
            trh.appendChild(th);
        }
        thead.appendChild(trh);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        for (const pkg of packages) {
            tbody.appendChild(RegistryView._pkgRow(pkg));
        }
        table.appendChild(tbody);
        this._tableEl.appendChild(table);
    }

    private static _pkgRow(pkg: ApiRegistryPackage): HTMLElement {
        const tr = document.createElement('tr');
        tr.className = 'reg-pkg';

        const tdName = document.createElement('td');
        const caret = document.createElement('span');
        caret.className = 'reg-caret';
        caret.textContent = '▶';
        tdName.appendChild(caret);
        const name = document.createElement('span');
        name.className = 'reg-pkg-name';
        name.textContent = pkg.name;
        tdName.appendChild(name);
        tr.appendChild(tdName);

        const tdVers = document.createElement('td');
        tdVers.className = 'reg-vers';
        tdVers.textContent = pkg.versions.map((v) => v.version).join(', ');
        tr.appendChild(tdVers);

        const tdSize = document.createElement('td');
        tdSize.className = 'reg-num';
        tdSize.textContent = RegistryView._fmtBytes(pkg.totalBytes);
        tr.appendChild(tdSize);

        const tdHits = document.createElement('td');
        tdHits.className = 'reg-num';
        tdHits.textContent = String(pkg.hits);
        if (pkg.hits === 0) {
            tdHits.classList.add('reg-num-zero');
        }
        tr.appendChild(tdHits);

        return tr;
    }

    /**
     * Per-project tally table for the current day, shown at the top of
     * the Projects tab. Populated on every `_refresh()` from
     * `status.projects` so it's live without waiting for the history
     * fetch.
     */
    private _renderProjectsSummary(projects: ApiRegistryProjectStat[]): void {
        if (!this._projectsEl) {
            return;
        }
        const existing = this._projectsEl.querySelector('.reg-proj-summary');
        existing?.remove();

        const section = document.createElement('div');
        section.className = 'reg-proj-summary';
        const head = document.createElement('div');
        head.className = 'reg-sub-head';
        head.textContent = I18n.t('Per project (today)');
        section.appendChild(head);

        if (projects.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'reg-empty';
            empty.textContent = I18n.t('No requests recorded today yet.');
            section.appendChild(empty);
            this._projectsEl.insertBefore(section, this._projectsEl.firstChild);
            return;
        }

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        const cols = [
            I18n.t('Project'), I18n.t('Hits'), I18n.t('Misses'),
            I18n.t('Packuments'), I18n.t('Tarballs'), I18n.t('404'), I18n.t('Errors')
        ];
        for (const label of cols) {
            const th = document.createElement('th');
            th.textContent = label;
            trh.appendChild(th);
        }
        thead.appendChild(trh);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        for (const p of projects) {
            const tr = document.createElement('tr');
            const tdName = document.createElement('td');
            tdName.className = 'reg-proj-name';
            tdName.textContent = p.project;
            tr.appendChild(tdName);
            for (const n of [p.hits, p.misses, p.packuments, p.tarballs, p.notFound, p.errors]) {
                const td = document.createElement('td');
                td.className = 'reg-num';
                td.textContent = String(n);
                if (n === 0) {
                    td.classList.add('reg-num-zero');
                }
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        section.appendChild(table);
        this._projectsEl.insertBefore(section, this._projectsEl.firstChild);
    }

    /**
     * Fetch the rolling history and render one sparkline row per
     * project (daily hits+misses) below the today-summary. Re-fetched
     * each time the Projects tab is opened so a running install shows
     * up promptly.
     */
    private async _refreshHistory(): Promise<void> {
        if (!this._projectsEl) {
            return;
        }
        this._projectsEl.querySelector('.reg-proj-history')?.remove();
        const section = document.createElement('div');
        section.className = 'reg-proj-history';
        const head = document.createElement('div');
        head.className = 'reg-sub-head';
        head.textContent = I18n.t('History (last 90 days)');
        section.appendChild(head);
        this._projectsEl.appendChild(section);

        let days: ApiRegistryHistoryDay[];
        try {
            days = (await Api.registryHistory(90)).days;
        } catch (e) {
            section.appendChild(RegistryView._historyError((e as Error).message));
            return;
        }
        if (days.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'reg-empty';
            empty.textContent = I18n.t('No history recorded yet.');
            section.appendChild(empty);
            return;
        }
        section.appendChild(RegistryView._historyBody(days));
    }

    private static _historyError(msg: string): HTMLElement {
        const el = document.createElement('div');
        el.className = 'reg-empty';
        el.textContent = msg;
        return el;
    }

    /**
     * Build one sparkline row per project across the day range. Each
     * row shows the project name, a per-day hits+misses sparkline, and
     * the range totals (hits / misses).
     */
    private static _historyBody(days: ApiRegistryHistoryDay[]): HTMLElement {
        // Fold the day list into per-project daily series (chronological).
        const series = new Map<string, {hits: number; misses: number;}[]>();
        for (const day of days) {
            for (const p of day.projects) {
                let arr = series.get(p.project);
                if (!arr) {
                    arr = [];
                    series.set(p.project, arr);
                }
                arr.push({hits: p.hits, misses: p.misses});
            }
        }
        const wrap = document.createElement('div');
        wrap.className = 'reg-hist-rows';
        const names = [...series.keys()].sort((a, b) => a.localeCompare(b));
        for (const name of names) {
            const points = series.get(name) ?? [];
            const totalHits = points.reduce((s, d) => s + d.hits, 0);
            const totalMisses = points.reduce((s, d) => s + d.misses, 0);

            const row = document.createElement('div');
            row.className = 'reg-hist-row';
            const label = document.createElement('span');
            label.className = 'reg-hist-name';
            label.textContent = name;
            row.appendChild(label);
            row.appendChild(RegistryView._sparkline(points.map((d) => d.hits + d.misses)));
            const totals = document.createElement('span');
            totals.className = 'reg-hist-totals';
            totals.textContent = `${totalHits} / ${totalMisses}`;
            totals.title = I18n.t('hits / misses');
            row.appendChild(totals);
            wrap.appendChild(row);
        }
        return wrap;
    }

    /** Hand-rolled inline-SVG sparkline (no chart lib), matching the app convention. */
    private static _sparkline(values: number[]): SVGSVGElement {
        const w = 160;
        const h = 22;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'reg-spark');
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));
        const max = Math.max(1, ...values);
        const n = values.length;
        if (n === 1) {
            const only = values[0];
            const y = (h - 2) - ((only / max) * (h - 4));
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', String(w / 2));
            dot.setAttribute('cy', String(y));
            dot.setAttribute('r', '2');
            dot.setAttribute('class', 'reg-spark-dot');
            svg.appendChild(dot);
            return svg;
        }
        const step = w / (n - 1);
        const pts = values.map((v, i) => {
            const x = i * step;
            const y = (h - 2) - ((v / max) * (h - 4));
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        poly.setAttribute('points', pts.join(' '));
        poly.setAttribute('class', 'reg-spark-line');
        svg.appendChild(poly);
        return svg;
    }

    private _openLog(): void {
        if (!this._logEl) {
            return;
        }
        this._stream?.close();
        this._logEl.innerHTML = '';
        const stream = new EventSource(Api.registryLogUrl());
        this._stream = stream;
        stream.addEventListener('entry', (ev: MessageEvent) => {
            try {
                const entry = JSON.parse(ev.data as string) as ApiRegistryLogEntry;
                this._appendLog(entry);
            } catch {
                // ignore malformed frame
            }
        });
    }

    private _appendLog(entry: ApiRegistryLogEntry): void {
        if (!this._logEl) {
            return;
        }
        const line = document.createElement('div');
        line.className = 'reg-log-line';

        const t = document.createElement('span');
        t.className = 'reg-log-t';
        t.textContent = RegistryView._fmtTime(entry.time);
        line.appendChild(t);

        if (entry.project && entry.project !== 'default') {
            const proj = document.createElement('span');
            proj.className = 'reg-log-proj';
            proj.textContent = entry.project;
            line.appendChild(proj);
        }

        const name = document.createElement('span');
        name.className = 'reg-log-name';
        name.textContent = entry.version ? `${entry.name}@${entry.version}` : entry.name;
        line.appendChild(name);

        const result = document.createElement('span');
        result.className = `reg-log-result reg-log-${entry.result}`;
        result.textContent = RegistryView._resultLabel(entry.result);
        line.appendChild(result);

        this._logEl.insertBefore(line, this._logEl.firstChild);
        while (this._logEl.childElementCount > 100) {
            this._logEl.removeChild(this._logEl.lastChild as Node);
        }
    }

    private async _clear(btn: HTMLButtonElement): Promise<void> {
        btn.disabled = true;
        try {
            const res = await Api.registryClear();
            btn.textContent = I18n.t('Removed {n}', {n: String(res.removed)});
            await this._refresh();
        } catch (e) {
            btn.textContent = (e as Error).message;
        } finally {
            window.setTimeout(() => {
                btn.textContent = I18n.t('Clear store');
                btn.disabled = false;
            }, 1600);
        }
    }

    private static _resultLabel(result: ApiRegistryLogEntry['result']): string {
        switch (result) {
            case 'hit':
                return I18n.t('HIT store');
            case 'miss':
                return I18n.t('MISS → upstream');
            case 'not-found':
                return I18n.t('404');
            default:
                return I18n.t('error');
        }
    }

    private static _fmtBytes(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        const units = ['KB', 'MB', 'GB'];
        let value = bytes / 1024;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return `${value.toFixed(1)} ${units[unit]}`;
    }

    private static _fmtTime(ms: number): string {
        const d = new Date(ms);
        const pad = (n: number): string => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

}