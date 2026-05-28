import {
    ApiAnalyzeEndEvent,
    ApiAnalyzeErrorEvent,
    ApiAnalyzeProgressEvent,
    ApiAnalyzeResultEvent,
    ApiAnalyzeStartEvent
} from '../Api/ApiTypes.js';
import {I18n} from './I18n.js';

/**
 * One row in the global scan result. We keep both `vulnIds` and the
 * list of projects each `name@version` was seen in, so the user can
 * see "where did this come in from" without leaving the view.
 */
type GlobalRow = {
    name: string;
    version: string;
    vulnIds: string[]|null;
    projects: string[];
};

/**
 * Cross-project CVE scan view, mounted into the right-pane. Triggered
 * by the topbar "Alle scannen" button. Lists every unique
 * `name@version` across all configured projects, with vulnerability
 * counts and the set of source projects.
 *
 * Connection model: one EventSource lives here at a time. Repeated
 * `start()` calls close the previous stream. Switching away from this
 * view does *not* close it — the scan can keep running in the
 * background and the user can come back to it.
 */
export class GlobalScanView {

    private readonly _root: HTMLElement;
    private _stream: EventSource|null = null;
    private _rows: Map<string, GlobalRow> = new Map();
    private _topbarBtn: HTMLButtonElement|null = null;
    private _topbarProgress: HTMLElement|null = null;
    private _topbarProgressFill: HTMLElement|null = null;
    private _topbarProgressText: HTMLElement|null = null;
    private _filterIssuesOnly: boolean = false;
    private _onAnalysisStart: (() => void)|null = null;

    constructor(
        root: HTMLElement,
        topbarBtn: HTMLButtonElement,
        topbarProgress: HTMLElement,
        topbarProgressFill: HTMLElement,
        topbarProgressText: HTMLElement
    ) {
        this._root = root;
        this._topbarBtn = topbarBtn;
        this._topbarProgress = topbarProgress;
        this._topbarProgressFill = topbarProgressFill;
        this._topbarProgressText = topbarProgressText;

        this._topbarBtn.addEventListener('click', () => {
            this._onAnalysisStart?.();
            this.start();
        });
    }

    /**
     * Called by Nppm when the button is clicked — gives the host a
     * chance to switch to the global pane before results flood in.
     */
    public onAnalysisStart(handler: () => void): void {
        this._onAnalysisStart = handler;
    }

    public start(): void {
        this._stopStream();
        this._rows = new Map();
        this._renderInitial();

        if (this._topbarBtn) {
            this._topbarBtn.disabled = true;
            this._topbarBtn.textContent = I18n.t('Scanning …');
        }
        if (this._topbarProgress) {
            this._topbarProgress.style.display = '';
        }
        this._updateProgress(0, 0, I18n.t('Starting …'));

        const es = new EventSource('/api/lockfile/analyze-all');
        this._stream = es;

        es.addEventListener('start', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiAnalyzeStartEvent;
            this._updateProgress(0, data.total, I18n.t('Scanning CVEs'));
        });

        es.addEventListener('result', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiAnalyzeResultEvent;
            const key = `${data.name}@${data.version}`;
            this._rows.set(key, {
                name: data.name,
                version: data.version,
                vulnIds: data.vulnIds,
                projects: data.projects ?? []
            });
            // Re-render only when this row matters or the table is small
            // enough that a full repaint is cheap. For a large set the
            // batched `progress` event will trigger a paint instead.
            if ((data.vulnIds && data.vulnIds.length > 0) || this._rows.size < 100) {
                this._renderTable();
            }
        });

        es.addEventListener('progress', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiAnalyzeProgressEvent;
            this._updateProgress(data.current, data.total, data.phase);
            this._renderTable();
        });

        es.addEventListener('end', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiAnalyzeEndEvent;
            this._updateProgress(data.total, data.total, I18n.t('Done'));
            this._finishScan(I18n.t('Scan finished — {n} unique packages checked', {n: data.total}));
            this._renderTable();
        });

        es.addEventListener('error', (e) => {
            const msg = (e as MessageEvent).data
                ? (JSON.parse((e as MessageEvent).data) as ApiAnalyzeErrorEvent).msg
                : I18n.t('Connection to analyser lost');
            this._finishScan(msg);
        });
    }

    private _stopStream(): void {
        if (this._stream) {
            this._stream.close();
            this._stream = null;
        }
    }

    private _finishScan(message: string): void {
        this._stopStream();

        if (this._topbarBtn) {
            this._topbarBtn.disabled = false;
            this._topbarBtn.textContent = I18n.t('Re-scan');
        }
        if (this._topbarProgressText) {
            this._topbarProgressText.textContent = message;
        }
    }

    private _updateProgress(current: number, total: number, phase?: string): void {
        if (!this._topbarProgressFill || !this._topbarProgressText) {
            return;
        }
        const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
        this._topbarProgressFill.style.width = `${pct.toFixed(1)}%`;
        this._topbarProgressText.textContent = total > 0
            ? `${phase ?? ''} ${current}/${total}`.trim()
            : phase ?? '';
    }

    private _renderInitial(): void {
        this._root.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'list-header installed-header';

        const title = document.createElement('div');
        title.className = 'installed-title';
        title.textContent = I18n.t('Global CVE scan');
        header.appendChild(title);

        const filterWrap = document.createElement('label');
        filterWrap.className = 'global-filter';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this._filterIssuesOnly;
        checkbox.addEventListener('change', () => {
            this._filterIssuesOnly = checkbox.checked;
            this._renderTable();
        });

        const text = document.createElement('span');
        text.textContent = ` ${I18n.t('Only issues')}`;

        filterWrap.appendChild(checkbox);
        filterWrap.appendChild(text);
        header.appendChild(filterWrap);

        this._root.appendChild(header);

        const tableHost = document.createElement('div');
        tableHost.className = 'global-table-host';
        this._root.appendChild(tableHost);
    }

    private _renderTable(): void {
        const host = this._root.querySelector('.global-table-host');
        if (!host) {
            return;
        }

        const rows = Array.from(this._rows.values()).filter((r) => {
            if (!this._filterIssuesOnly) {
                return true;
            }
            return r.vulnIds && r.vulnIds.length > 0;
        });

        rows.sort((a, b) => {
            // Rows with vulns float to the top; within each tier sort by
            // name + version. Failed lookups (vulnIds === null) come
            // last because they're noise.
            const sa = GlobalScanView._scoreRow(a);
            const sb = GlobalScanView._scoreRow(b);
            if (sa !== sb) {
                return sb - sa;
            }
            const n = a.name.localeCompare(b.name);
            return n !== 0 ? n : a.version.localeCompare(b.version);
        });

        host.innerHTML = '';

        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'list-placeholder';
            empty.textContent = this._filterIssuesOnly
                ? I18n.t('No hits so far.')
                : I18n.t('No data yet — start the scan or wait for the first result.');
            host.appendChild(empty);
            return;
        }

        const table = document.createElement('table');
        table.className = 'pkg-table';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>${I18n.t('Package')}</th>
                    <th>${I18n.t('Version')}</th>
                    <th>CVEs</th>
                    <th>${I18n.t('Projects')}</th>
                </tr>
            </thead>
        `;

        const tbody = document.createElement('tbody');
        for (const r of rows) {
            tbody.appendChild(this._renderRow(r));
        }
        table.appendChild(tbody);
        host.appendChild(table);
    }

    private _renderRow(r: GlobalRow): HTMLElement {
        const tr = document.createElement('tr');

        const name = document.createElement('td');
        name.className = 'pkg-name';
        name.textContent = r.name;
        tr.appendChild(name);

        const version = document.createElement('td');
        version.className = 'pkg-version';
        version.textContent = r.version;
        tr.appendChild(version);

        const cves = document.createElement('td');
        cves.className = 'installed-cve-cell';
        if (r.vulnIds === null) {
            cves.textContent = '?';
            cves.title = I18n.t('OSV.dev unreachable for this package');
        } else if (r.vulnIds.length === 0) {
            cves.textContent = '✓';
            cves.classList.add('installed-cve-clean');
        } else {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-cve';
            badge.textContent = `${r.vulnIds.length}`;
            badge.title = r.vulnIds.join('\n');
            cves.appendChild(badge);
        }
        tr.appendChild(cves);

        const projects = document.createElement('td');
        projects.className = 'global-projects';
        projects.textContent = r.projects.join(', ');
        tr.appendChild(projects);

        return tr;
    }

    /**
     * Sort weight for a result row: rows OSV couldn't reach sink to
     * the bottom (-1), then ascending by vuln count. Pulled into a
     * static so the sort callback above stays a one-liner.
     */
    private static _scoreRow(r: GlobalRow): number {
        if (r.vulnIds === null) {
            return -1;
        }
        return r.vulnIds.length;
    }
}
