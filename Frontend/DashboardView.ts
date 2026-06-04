import {
    ApiDashboardHistoryResponse,
    ApiDashboardResponse,
    ApiDashboardScanCellEvent,
    ApiDashboardScanColumnEndEvent,
    ApiDashboardScanColumnStartEvent,
    ApiDashboardScanEndEvent,
    ApiDashboardScanErrorEvent,
    ApiDashboardScanProgressEvent,
    ApiDashboardScanStartEvent,
    ApiDashboardSnapshotResponse
} from '../Api/ApiTypes.js';
import {DashboardCell, DashboardColumn, ScannerId} from '../Dashboard/DashboardBuilder.js';
import {DashboardHistoryEntry} from '../Dashboard/DashboardHistoryStore.js';
import {EcoBoxId, EcosystemBoxModal} from './EcosystemBoxModal.js';
import {I18n} from './I18n.js';
import {ImpactModal} from './ImpactModal.js';

/**
 * Cross-project Dashboard view. Rows = scanners, columns = projects,
 * cells = score rings.  Subscribes to `/api/dashboard/scan` once per
 * `show()` call; the SSE stream emits one `cell` event per
 * (project, scanner) intersection so the table fills in progressively.
 *
 * Cold cache may take a minute or more — the progress bar reports
 * `Project N — Scanner X (current/total)` so the user knows where in
 * the scan they are.
 */
export type DashboardCellClickHandler = (
    projectUnid: string,
    projectName: string,
    scanner: ScannerId,
    scannerLabel: string,
    cell: DashboardCell
) => void;

export type DashboardProjectClickHandler = (projectUnid: string) => void;

export class DashboardView {

    private readonly _root: HTMLElement;
    private _stream: EventSource|null = null;
    private _scanners: ScannerId[] = [];
    private _columns: Map<string, DashboardColumn> = new Map();
    private _columnOrder: string[] = [];
    private _progressEl: HTMLElement|null = null;
    private _progressBar: HTMLElement|null = null;
    private _progressText: HTMLElement|null = null;
    private _tabBarHost: HTMLElement|null = null;
    private _tableHost: HTMLElement|null = null;
    private _rescanBtn: HTMLButtonElement|null = null;
    private _snapshotTimestamp: string|null = null;
    private _onCellClick: DashboardCellClickHandler|null = null;
    private _onProjectClick: DashboardProjectClickHandler|null = null;
    private _onScoresChanged: ((scores: Map<string, number>) => void)|null = null;
    private _onMatrixClick: (() => void)|null = null;
    private _activeTab: 'scanner-score'|'overall'|'trend' = 'scanner-score';
    private readonly _ecoModal = new EcosystemBoxModal();
    /**
     * Overall score of the *previous* persisted scan (one entry back
     * from the latest history record). Drives the macro-donut's "↑X
     * vs last scan" delta. `null` when no prior scan exists yet — the
     * delta line then hides instead of showing `+78`.
     */
    private _previousOverall: number|null = null;
    private _historyEntries: DashboardHistoryEntry[] = [];
    private _trendRangeDays: 30|90|365 = 90;
    private _widgetStripHost: HTMLElement|null = null;

    constructor(root: HTMLElement) {
        this._root = root;
        this._ecoModal.onProjectClick((unid) => {
            this._onProjectClick?.(unid);
        });
        this._ecoModal.onNavigate((target) => {
            if (target === 'matrix') {
                this._onMatrixClick?.();
            }
        });
    }

    public onCellClick(handler: DashboardCellClickHandler): void {
        this._onCellClick = handler;
    }

    public onProjectClick(handler: DashboardProjectClickHandler): void {
        this._onProjectClick = handler;
    }

    /**
     * Listener for the "Open in Matrix" CTA inside the ecosystem
     * box modal. Wired by `Nppm` to the same code path the
     * treeview's matrix sentinel takes — keeps navigation
     * symmetric across surfaces.
     */
    public onMatrixClick(handler: () => void): void {
        this._onMatrixClick = handler;
    }

    /**
     * Listener for per-project aggregate scores derived from the
     * scanner-score cells. Same shape as `Matrix.onScoresChanged`:
     * Nppm merges both feeds (dashboard-wins) and pushes the result
     * to the treeview health rings.
     */
    public onScoresChanged(handler: (scores: Map<string, number>) => void): void {
        this._onScoresChanged = handler;
    }

    /**
     * Compute per-project average score over non-N/A cells and fire
     * the listener. Public so the snapshot path can call it after
     * loading without having to know the internals.
     */
    public emitScores(): void {
        if (!this._onScoresChanged) {
            return;
        }
        const scores = new Map<string, number>();
        for (const [unid, col] of this._columns) {
            let sum = 0;
            let scanned = 0;
            for (const cell of Object.values(col.cells)) {
                if (cell.score !== null) {
                    sum += cell.score;
                    scanned++;
                }
            }
            if (scanned > 0) {
                scores.set(unid, Math.round(sum / scanned));
            }
        }
        if (scores.size > 0) {
            this._onScoresChanged(scores);
        }
    }

    /**
     * Open the view. Loads the cached snapshot (if any) for an
     * immediate first-paint and then sits idle — the user controls
     * fresh scans via the Re-scan button. On a fresh installation
     * the snapshot is empty, so we kick off a scan automatically to
     * avoid greeting the user with a blank table.
     *
     * When a scan is already in flight from a previous `show()` (the
     * user navigated to Templates and came back), we skip the
     * scaffold-and-reload dance and keep the existing DOM + SSE in
     * place so progress stays visible without restarting from zero.
     */
    public show(): void {
        if (this._stream) {
            return;
        }
        this._scaffold();
        void this._loadSnapshot();
    }

    private async _loadSnapshot(): Promise<void> {
        // Fetch history in parallel — drives the macro-donut delta and
        // pre-warms the trend tab. A history failure is non-fatal; the
        // donut just hides its delta line.
        void this._loadHistory();
        try {
            const res = await fetch('/api/dashboard/snapshot');
            if (!res.ok) {
                this._startScan();
                return;
            }
            const payload = (await res.json()) as ApiDashboardSnapshotResponse;
            if (payload.snapshot) {
                this._renderSnapshot(payload.snapshot, payload.timestamp);
            } else {
                this._startScan();
            }
        } catch {
            this._startScan();
        }
    }

    /**
     * Fetch history once when the view opens. The donut-delta only
     * needs `previous.overall`; the trend tab uses the full entry
     * list. Default range 90d covers the typical "is the project
     * trending up or down lately?" question without flooding the SVG.
     */
    private async _loadHistory(): Promise<void> {
        try {
            const res = await fetch(`/api/dashboard/history?days=${this._trendRangeDays}`);
            if (!res.ok) {
                return;
            }
            const payload = (await res.json()) as ApiDashboardHistoryResponse;
            this._historyEntries = payload.entries;
            this._previousOverall = payload.previous?.overall ?? null;
            // Re-render in case the user is already looking at the
            // scanner-score tab — the macro-donut needs to re-paint
            // its delta line now that the previous-overall is known.
            this._renderTable();
        } catch {
            // ignore; donut just hides its delta line
        }
    }

    private _renderSnapshot(dashboard: ApiDashboardResponse, timestamp: string|null): void {
        this._scanners = dashboard.scanners;
        this._columnOrder = dashboard.columns.map((c) => c.project.unid);
        this._columns.clear();
        for (const col of dashboard.columns) {
            this._columns.set(col.project.unid, col);
        }
        this._snapshotTimestamp = timestamp;
        this._renderTable();
        this.emitScores();
        if (this._rescanBtn) {
            this._rescanBtn.disabled = false;
            this._rescanBtn.textContent = I18n.t('Re-scan');
        }
        if (this._progressBar) {
            this._progressBar.style.width = '100%';
        }
        if (this._progressText) {
            this._progressText.textContent = timestamp
                ? I18n.t('Showing cached snapshot from {time}', {time: DashboardView._formatTimestamp(timestamp)})
                : I18n.t('Showing cached snapshot');
        }
    }

    public stop(): void {
        if (this._stream) {
            this._stream.close();
            this._stream = null;
        }
    }

    private _scaffold(): void {
        this._root.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'dash-header';
        const title = document.createElement('h2');
        title.className = 'dash-title';
        title.textContent = I18n.t('Dashboard');
        header.appendChild(title);

        const rescanBtn = document.createElement('button');
        rescanBtn.className = 'dash-rescan';
        rescanBtn.type = 'button';
        rescanBtn.textContent = I18n.t('Re-scan');
        rescanBtn.disabled = true;
        rescanBtn.addEventListener('click', () => this._startScan());
        this._rescanBtn = rescanBtn;
        header.appendChild(rescanBtn);

        this._root.appendChild(header);

        const progressEl = document.createElement('div');
        progressEl.className = 'dash-progress';
        const progressLabel = document.createElement('div');
        progressLabel.className = 'dash-progress-text';
        progressLabel.textContent = I18n.t('Please wait — preparing scan …');
        progressEl.appendChild(progressLabel);
        const progressTrack = document.createElement('div');
        progressTrack.className = 'dash-progress-track';
        const progressBar = document.createElement('div');
        progressBar.className = 'dash-progress-bar';
        progressTrack.appendChild(progressBar);
        progressEl.appendChild(progressTrack);
        this._progressEl = progressEl;
        this._progressBar = progressBar;
        this._progressText = progressLabel;
        this._root.appendChild(progressEl);

        const tabBarHost = document.createElement('div');
        tabBarHost.className = 'dash-tabs';
        this._tabBarHost = tabBarHost;
        this._renderTabBar();
        this._root.appendChild(tabBarHost);

        // Widget strip sits between the tab bar and the table body.
        // Painted only on the scanner-score tab — Overall has its own
        // hero card, Trend has its own chart.
        const widgetStripHost = document.createElement('div');
        widgetStripHost.className = 'dash-widget-strip-host';
        this._widgetStripHost = widgetStripHost;
        this._root.appendChild(widgetStripHost);

        const tableHost = document.createElement('div');
        tableHost.className = 'dash-table-host';
        this._tableHost = tableHost;
        this._root.appendChild(tableHost);
    }

    private _renderTabBar(): void {
        if (!this._tabBarHost) {
            return;
        }
        this._tabBarHost.innerHTML = '';
        const tabs: {value: 'scanner-score'|'overall'|'trend'; label: string}[] = [
            {value: 'scanner-score', label: I18n.t('Scanner Score')},
            {value: 'overall', label: I18n.t('Overall Evaluation')},
            {value: 'trend', label: I18n.t('Trend')}
        ];
        for (const t of tabs) {
            const btn = document.createElement('button');
            btn.className = 'dash-tab';
            btn.type = 'button';
            if (t.value === this._activeTab) {
                btn.classList.add('dash-tab-active');
            }
            btn.textContent = t.label;
            btn.addEventListener('click', () => {
                if (this._activeTab === t.value) {
                    return;
                }
                this._activeTab = t.value;
                this._renderTabBar();
                this._renderTable();
            });
            this._tabBarHost.appendChild(btn);
        }
    }

    private _startScan(): void {
        this.stop();
        this._columns.clear();
        this._columnOrder = [];
        this._scanners = [];

        if (this._rescanBtn) {
            this._rescanBtn.disabled = true;
            this._rescanBtn.textContent = I18n.t('Scanning …');
        }
        this._updateProgress(0, 1, I18n.t('Please wait — preparing scan …'));
        this._renderTable();

        const es = new EventSource('/api/dashboard/scan');
        this._stream = es;

        es.addEventListener('start', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiDashboardScanStartEvent;
            this._scanners = data.scanners;
            this._renderTable();
            this._updateProgress(0, data.totalProjects * data.scanners.length,
                I18n.t('Scanning {n} projects …', {n: String(data.totalProjects)}));
        });

        es.addEventListener('column-start', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiDashboardScanColumnStartEvent;
            if (!this._columns.has(data.projectUnid)) {
                this._columns.set(data.projectUnid, {
                    project: {
                        unid: data.projectUnid,
                        name: data.projectName,
                        // `type` is filled in by column-end; placeholder
                        // is good enough for the partial table render.
                        type: 'local' as DashboardColumn['project']['type']
                    },
                    cells: {}
                });
                this._columnOrder.push(data.projectUnid);
                this._renderTable();
            }
        });

        es.addEventListener('progress', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiDashboardScanProgressEvent;
            const scannerLabel = data.scanner ? DashboardView._scannerLabel(data.scanner) : '';
            // `detail` (when set) is the substring the user actually
            // wants to read — "Fingerprinting lodash@4.17.21 (32/84)
            // — kavula". It already encodes project/scanner context,
            // so the original `{project} — {scanner}` fallback only
            // kicks in for cell-level progress events.
            const phase = data.detail
                ?? (scannerLabel
                    ? I18n.t('{project} — {scanner}', {project: data.projectName, scanner: scannerLabel})
                    : data.projectName);
            this._updateProgress(data.current, data.total, phase);
        });

        es.addEventListener('cell', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiDashboardScanCellEvent;
            const col = this._columns.get(data.projectUnid);
            if (col) {
                col.cells[data.scanner] = data.cell;
                this._renderTable();
            }
        });

        es.addEventListener('column-end', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiDashboardScanColumnEndEvent;
            this._columns.set(data.column.project.unid, data.column);
            this._renderTable();
            // Per-project score is final once the column ends — emit
            // so the treeview ring updates progressively instead of
            // waiting for the whole scan.
            this.emitScores();
        });

        es.addEventListener('end', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiDashboardScanEndEvent;
            this._scanners = data.dashboard.scanners;
            this._columnOrder = data.dashboard.columns.map((c) => c.project.unid);
            for (const col of data.dashboard.columns) {
                this._columns.set(col.project.unid, col);
            }
            this._renderTable();
            this.emitScores();
            this._finishScan(I18n.t('Scan complete — {n} cells', {
                n: String(data.dashboard.scanners.length * data.dashboard.columns.length)
            }));
        });

        es.addEventListener('error', (e) => {
            const msg = (e as MessageEvent).data
                ? (JSON.parse((e as MessageEvent).data) as ApiDashboardScanErrorEvent).msg
                : I18n.t('Connection to analyser lost');
            this._finishScan(msg);
        });
    }

    private _updateProgress(current: number, total: number, phase: string): void {
        if (!this._progressBar || !this._progressText) {
            return;
        }
        const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
        this._progressBar.style.width = `${pct.toFixed(1)}%`;
        this._progressText.textContent = total > 0
            ? `${phase} (${current}/${total})`
            : phase;
    }

    private _finishScan(message: string): void {
        if (this._stream) {
            this._stream.close();
            this._stream = null;
        }
        if (this._rescanBtn) {
            this._rescanBtn.disabled = false;
            this._rescanBtn.textContent = I18n.t('Re-scan');
        }
        if (this._progressText) {
            this._progressText.textContent = message;
        }
        if (this._progressBar) {
            this._progressBar.style.width = '100%';
        }
    }

    private _renderTable(): void {
        if (!this._tableHost) {
            return;
        }
        this._tableHost.innerHTML = '';
        this._renderWidgetStrip();

        if (this._scanners.length === 0 || this._columnOrder.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'dash-empty';
            hint.textContent = I18n.t('Waiting for the first project …');
            this._tableHost.appendChild(hint);
            return;
        }

        if (this._activeTab === 'overall') {
            this._renderOverallTab();
            return;
        }
        if (this._activeTab === 'trend') {
            this._renderTrendTab();
            return;
        }

        const table = document.createElement('table');
        table.className = 'dash-table';

        // Header row — scanner column + one per project. Project
        // headers are clickable: they route through `onProjectClick`
        // so the user can jump from a worrying column straight into
        // the project's drill-down view (Nppm.handles).
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const cornerCell = document.createElement('th');
        cornerCell.className = 'dash-th-corner';
        cornerCell.textContent = I18n.t('Scanner');
        headRow.appendChild(cornerCell);
        for (const unid of this._columnOrder) {
            const col = this._columns.get(unid);
            const th = document.createElement('th');
            th.className = 'dash-th-project dash-th-clickable';
            th.textContent = col?.project.name ?? unid;
            th.title = I18n.t('Open project');
            th.addEventListener('click', () => this._onProjectClick?.(unid));
            if (col?.error) {
                const errTitle = th.title;
                th.title = `${errTitle} · ${col.error}`;
                th.classList.add('dash-th-error');
            } else if (col?.note) {
                // Soft annotation (e.g. "no lockfile — scanned against
                // registry latest"). Adds a small info marker after the
                // project name without flipping the column to the red
                // error style.
                const errTitle = th.title;
                th.title = `${errTitle} · ${col.note}`;
                th.classList.add('dash-th-note');
                const marker = document.createElement('span');
                marker.className = 'dash-th-note-marker';
                marker.textContent = ' ⓘ';
                th.appendChild(marker);
            }
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        // One row per scanner — `dash-row` lets CSS highlight the full
        // row on hover so the user can track project ↔ scanner
        // intersections at a glance.
        const tbody = document.createElement('tbody');
        for (const scanner of this._scanners) {
            const row = document.createElement('tr');
            row.className = 'dash-row';
            row.appendChild(DashboardView._renderScannerCell(scanner));

            for (const unid of this._columnOrder) {
                const col = this._columns.get(unid);
                const cell = col?.cells[scanner];
                const td = document.createElement('td');
                td.className = 'dash-td-cell';
                if (cell) {
                    td.appendChild(DashboardView._renderRing(cell));
                    td.title = DashboardView._cellTooltip(cell, scanner);
                    td.classList.add('dash-td-clickable');
                    const projectName = col?.project.name ?? unid;
                    td.addEventListener('click', () => {
                        this._onCellClick?.(unid, projectName, scanner,
                            DashboardView._scannerLabel(scanner), cell);
                    });
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'dash-pending';
                    placeholder.textContent = '…';
                    td.appendChild(placeholder);
                }
                row.appendChild(td);
            }
            tbody.appendChild(row);
        }
        table.appendChild(tbody);

        this._tableHost.appendChild(table);
    }

    /**
     * Overall-Evaluation tab body. Renders two roll-ups derived
     * entirely from the cells the scanner-score tab already shows:
     *
     *  - Project health list: one row per project with the average
     *    score over all non-N/A cells, sorted worst-first so the
     *    user's eye lands on the project that needs attention. The
     *    severity totals live next to the score as compact pills.
     *  - Top problem packages: a flat aggregation of every
     *    `CellFinding` across every (project, scanner), grouped by
     *    package label. Sorted by risk/warn/info weight, capped at
     *    20 entries — enough to fit on a screen, not so many the
     *    table becomes a finding-counter wall.
     */
    private _renderOverallTab(): void {
        if (!this._tableHost) {
            return;
        }

        const wrap = document.createElement('div');
        wrap.className = 'dash-overall';

        wrap.appendChild(this._renderEcosystemCard());
        // Project-health list and top-problem-packages roll-ups are
        // intentionally suppressed for now — the hero card carries
        // the same information in summary form and the modals offer
        // the drill-down. The `_renderOverall*` helpers stay around
        // so it's one-line to bring either back.

        this._tableHost.appendChild(wrap);
    }

    /**
     * Hero card with the forest/dark-forest background and eight
     * absolutely-positioned metric boxes laid out left-green /
     * right-red around the central tree. Thin SVG connectors run
     * from each box's edge to a small anchor circle on the
     * visual feature it speaks to — purely decorative but matches
     * the design reference.
     *
     * All numbers come from the same `_columns` map the
     * scanner-score tab already consumes, so the card stays in sync
     * with whatever the SSE stream has delivered so far.
     */
    private _renderEcosystemCard(): HTMLElement {
        const card = document.createElement('div');
        card.className = 'dash-eco-card';

        // SVG overlay must sit above the background image but below
        // the boxes — the boxes' z-index bumps them over it.
        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('class', 'dash-eco-svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        card.appendChild(svg);

        // Compute ecosystem aggregates over every column we've seen.
        let totalRisk = 0;
        let totalWarn = 0;
        let totalInfo = 0;
        let cveCount = 0;
        let deprecationCount = 0;
        let typosquatCount = 0;
        let maintainerWarnRisk = 0;
        let healthyProjects = 0;
        let riskyProjects = 0;
        let scoredProjects = 0;
        let scoreSum = 0;
        for (const col of this._columns.values()) {
            let projScoreSum = 0;
            let projScored = 0;
            for (const [scanner, cell] of Object.entries(col.cells)) {
                if (cell.score !== null) {
                    projScoreSum += cell.score;
                    projScored++;
                }
                totalRisk += cell.counts.risk;
                totalWarn += cell.counts.warn;
                totalInfo += cell.counts.info;
                if (scanner === 'cve') {
                    cveCount += cell.counts.risk + cell.counts.warn;
                }
                if (scanner === 'deprecation') {
                    deprecationCount += cell.counts.risk + cell.counts.warn;
                }
                if (scanner === 'typosquat') {
                    typosquatCount += cell.counts.risk;
                }
                if (scanner === 'maintainer') {
                    maintainerWarnRisk += cell.counts.risk + cell.counts.warn;
                }
            }
            if (projScored > 0) {
                const avg = projScoreSum / projScored;
                scoreSum += avg;
                scoredProjects++;
                if (avg >= 80) {
                    healthyProjects++;
                }
                if (avg < 60) {
                    riskyProjects++;
                }
            }
        }
        const ecosystemHealth = scoredProjects > 0 ? Math.round(scoreSum / scoredProjects) : null;
        const projectCount = this._columns.size;

        // Box layout — coordinates in % of the card, anchor points
        // (where the connector tip lands) likewise in %. Box origin
        // is its top-left corner.
        type BoxSpec = {
            id: EcoBoxId;
            side: 'green'|'red';
            top: number; left: number; w: number;
            anchorX: number; anchorY: number;
            label: string; value: string;
            tip: string;
        };
        const boxes: BoxSpec[] = [
            {
                id: 'projects',
                side: 'green',
                top: 5, left: 3, w: 19,
                anchorX: 27, anchorY: 17,
                label: I18n.t('Projects'),
                value: String(projectCount),
                tip: I18n.t('How many projects nppm is currently scanning. Click for the list.')
            },
            {
                id: 'ecosystem-health',
                side: 'green',
                top: 22, left: 3, w: 19,
                // Aim across the canopy toward the upper-centre tree
                // foliage — longer, clearly visible diagonal instead
                // of a stub that sits next to the box.
                anchorX: 40, anchorY: 26,
                label: I18n.t('Ecosystem health'),
                value: ecosystemHealth !== null ? `${ecosystemHealth}/100` : '—',
                tip: I18n.t('Average scanner score across every project. Click for the per-scanner breakdown.')
            },
            {
                id: 'healthy-projects',
                side: 'green',
                top: 55, left: 3, w: 19,
                anchorX: 26, anchorY: 60,
                label: I18n.t('Healthy projects'),
                value: String(healthyProjects),
                tip: I18n.t('Projects whose average scanner score is 80 or above. Click for the list.')
            },
            {
                id: 'info-findings',
                side: 'green',
                top: 75, left: 14, w: 22,
                // Box bottom-left, anchor previously sat *inside* the
                // box's X range so the line was a stub. Send it up
                // and right toward the mushroom cluster at the
                // tree's base — clear diagonal away from the box.
                anchorX: 42, anchorY: 58,
                label: I18n.t('Info-level findings'),
                value: String(totalInfo),
                tip: I18n.t('Lowest-severity findings across all scanners — useful as an early warning. Click for the per-scanner breakdown.')
            },
            {
                id: 'risk-findings',
                side: 'red',
                top: 5, left: 78, w: 19,
                anchorX: 73, anchorY: 17,
                label: I18n.t('Risk findings'),
                value: String(totalRisk),
                tip: I18n.t('Highest-severity findings across all scanners. Click for the per-scanner breakdown.')
            },
            {
                id: 'cve-flags',
                side: 'red',
                top: 22, left: 78, w: 19,
                anchorX: 70, anchorY: 30,
                label: I18n.t('CVE flags'),
                value: String(cveCount),
                tip: I18n.t('Packages whose installed version has known CVE entries on OSV.dev. Click for the package list.')
            },
            {
                id: 'deprecated',
                side: 'red',
                top: 55, left: 78, w: 19,
                anchorX: 73, anchorY: 60,
                label: I18n.t('Deprecated'),
                value: String(deprecationCount),
                tip: I18n.t('Packages whose installed or latest version is deprecated on the registry. Click for the list.')
            },
            {
                id: 'at-risk-projects',
                side: 'red',
                top: 75, left: 64, w: 22,
                // Mirror of the info-findings box: the previous
                // anchor sat inside the box's X range. Aim up and
                // left toward the shield + dark-roots cluster so the
                // diagonal is visible.
                anchorX: 58, anchorY: 58,
                label: I18n.t('At-risk projects'),
                value: String(riskyProjects),
                tip: I18n.t('Projects whose average scanner score is below 60. Click for the list.')
            },
            {
                id: 'maintainer-alerts',
                side: 'red',
                top: 38, left: 78, w: 19,
                anchorX: 71, anchorY: 43,
                label: I18n.t('Maintainer alerts'),
                value: String(maintainerWarnRisk),
                tip: I18n.t('Packages with risky maintainer-handover or 2FA-status patterns. Click for the list.')
            },
            {
                id: 'typosquat-hits',
                side: 'red',
                top: 38, left: 39, w: 22,
                anchorX: 50, anchorY: 53,
                label: I18n.t('Typosquat hits'),
                value: String(typosquatCount),
                tip: I18n.t('Names a Levenshtein distance of 1-2 from a popular package, or carrying confusable characters. Click for the list.')
            }
        ];

        // Draw connectors first so the boxes (added next) paint on
        // top. Start each line a few percent inside the box so the
        // origin is guaranteed to sit behind the solid box fill —
        // the visible portion of the line then emerges cleanly at
        // the box edge that faces the anchor. Boxes render at ~9-12%
        // tall on the 960×640 card; `+4` keeps the start well above
        // the bottom edge even on the shortest box.
        for (const b of boxes) {
            const boxCenterX = b.left + b.w / 2;
            const boxCenterY = b.top + 4;
            const line = document.createElementNS(svgNs, 'line');
            line.setAttribute('x1', String(boxCenterX));
            line.setAttribute('y1', String(boxCenterY));
            line.setAttribute('x2', String(b.anchorX));
            line.setAttribute('y2', String(b.anchorY));
            line.setAttribute('class', `dash-eco-line dash-eco-line-${b.side}`);
            svg.appendChild(line);
            const dot = document.createElementNS(svgNs, 'circle');
            dot.setAttribute('cx', String(b.anchorX));
            dot.setAttribute('cy', String(b.anchorY));
            dot.setAttribute('r', '0.6');
            dot.setAttribute('class', `dash-eco-dot dash-eco-dot-${b.side}`);
            svg.appendChild(dot);
        }

        for (const b of boxes) {
            const box = document.createElement('div');
            box.className = `dash-eco-box dash-eco-box-${b.side} dash-eco-box-clickable`;
            box.style.top = `${b.top}%`;
            box.style.left = `${b.left}%`;
            box.style.width = `${b.w}%`;
            box.title = b.tip;
            box.addEventListener('click', () => {
                this._ecoModal.open(b.id, b.label, this._columns);
            });

            const value = document.createElement('div');
            value.className = 'dash-eco-value';
            value.textContent = b.value;
            box.appendChild(value);

            const label = document.createElement('div');
            label.className = 'dash-eco-label';
            label.textContent = b.label;
            box.appendChild(label);

            card.appendChild(box);
        }

        return card;
    }

    private _renderOverallProjects(): HTMLElement {
        type Agg = {
            unid: string;
            name: string;
            avg: number|null;
            risk: number;
            warn: number;
            info: number;
            scannedCells: number;
            totalCells: number;
        };
        const aggs: Agg[] = [];
        for (const unid of this._columnOrder) {
            const col = this._columns.get(unid);
            if (!col) {
                continue;
            }
            let sum = 0;
            let scanned = 0;
            let risk = 0;
            let warn = 0;
            let info = 0;
            for (const cell of Object.values(col.cells)) {
                if (cell.score !== null) {
                    sum += cell.score;
                    scanned++;
                }
                risk += cell.counts.risk;
                warn += cell.counts.warn;
                info += cell.counts.info;
            }
            aggs.push({
                unid,
                name: col.project.name,
                avg: scanned > 0 ? Math.round(sum / scanned) : null,
                risk, warn, info,
                scannedCells: scanned,
                totalCells: Object.keys(col.cells).length
            });
        }
        // Worst-first; rows with no scanned cells slot to the bottom.
        aggs.sort((a, b) => {
            if (a.avg === null && b.avg === null) {
                return 0;
            }
            if (a.avg === null) {
                return 1;
            }
            if (b.avg === null) {
                return -1;
            }
            return a.avg - b.avg;
        });

        const section = document.createElement('div');
        section.className = 'dash-overall-section';
        const head = document.createElement('h3');
        head.className = 'dash-overall-head';
        head.textContent = I18n.t('Project health (worst first)');
        section.appendChild(head);

        for (const a of aggs) {
            const row = document.createElement('div');
            row.className = 'dash-overall-row dash-overall-row-clickable';
            row.title = I18n.t('Open project');
            row.addEventListener('click', () => this._onProjectClick?.(a.unid));

            const nameEl = document.createElement('div');
            nameEl.className = 'dash-overall-name';
            nameEl.textContent = a.name;
            row.appendChild(nameEl);

            const scoreEl = document.createElement('div');
            scoreEl.className = 'dash-overall-score';
            if (a.avg === null) {
                scoreEl.textContent = '—';
                scoreEl.classList.add('dash-overall-score-na');
            } else {
                scoreEl.textContent = String(a.avg);
                scoreEl.classList.add(a.avg >= 80 ? 'dash-overall-score-good'
                    : a.avg >= 60 ? 'dash-overall-score-warn'
                        : 'dash-overall-score-risk');
            }
            scoreEl.title = I18n.t('{scanned} of {total} scanners contributed', {
                scanned: a.scannedCells, total: a.totalCells
            });
            row.appendChild(scoreEl);

            row.appendChild(DashboardView._renderPills(a.risk, a.warn, a.info));
            section.appendChild(row);
        }
        return section;
    }

    private _renderOverallPackages(): HTMLElement|null {
        type Agg = {label: string; risk: number; warn: number; info: number; projects: Set<string>};
        const byLabel = new Map<string, Agg>();
        for (const unid of this._columnOrder) {
            const col = this._columns.get(unid);
            if (!col) {
                continue;
            }
            for (const cell of Object.values(col.cells)) {
                for (const f of cell.findings) {
                    let agg = byLabel.get(f.label);
                    if (!agg) {
                        agg = {label: f.label, risk: 0, warn: 0, info: 0, projects: new Set()};
                        byLabel.set(f.label, agg);
                    }
                    agg.projects.add(unid);
                    if (f.severity === 'risk') {
                        agg.risk++;
                    } else if (f.severity === 'warn') {
                        agg.warn++;
                    } else if (f.severity === 'info') {
                        agg.info++;
                    }
                }
            }
        }
        if (byLabel.size === 0) {
            return null;
        }
        const topN = Array.from(byLabel.values())
            .sort((a, b) => {
                if (a.risk !== b.risk) {
                    return b.risk - a.risk;
                }
                if (a.warn !== b.warn) {
                    return b.warn - a.warn;
                }
                return b.info - a.info;
            })
            .slice(0, 20);

        const section = document.createElement('div');
        section.className = 'dash-overall-section';
        const head = document.createElement('h3');
        head.className = 'dash-overall-head';
        head.textContent = I18n.t('Top problem packages');
        section.appendChild(head);

        for (const a of topN) {
            const row = document.createElement('div');
            row.className = 'dash-overall-row';

            const nameEl = document.createElement('div');
            nameEl.className = 'dash-overall-name';
            nameEl.textContent = a.label;
            row.appendChild(nameEl);

            const projEl = document.createElement('div');
            projEl.className = 'dash-overall-projcount';
            projEl.textContent = a.projects.size === 1
                ? I18n.t('in 1 project')
                : I18n.t('in {n} projects', {n: a.projects.size});
            row.appendChild(projEl);

            row.appendChild(DashboardView._renderPills(a.risk, a.warn, a.info));
            section.appendChild(row);
        }
        return section;
    }

    /**
     * Header strip rendered above the scanner table on the
     * scanner-score tab. Painted only when columns exist so an
     * empty-state view doesn't ship a strip of placeholder "0/100"s.
     * On the Overall / Trend tabs the strip is intentionally hidden —
     * the strip's roll-ups would duplicate the hero card / trend
     * chart already on screen.
     */
    private _renderWidgetStrip(): void {
        if (!this._widgetStripHost) {
            return;
        }
        this._widgetStripHost.innerHTML = '';
        if (this._activeTab !== 'scanner-score' || this._columns.size === 0) {
            return;
        }

        const strip = document.createElement('div');
        strip.className = 'dash-widget-strip';
        strip.appendChild(this._renderMacroDonut());
        strip.appendChild(this._renderTopWorstPackages());
        this._widgetStripHost.appendChild(strip);
    }

    /**
     * 3-segment donut summarising the ecosystem at a glance:
     *   green  → projects whose avg score is ≥ 80 (treeview ring green)
     *   amber  → projects whose avg score is 60-79
     *   red    → projects whose avg score is < 60 (treeview ring red)
     *
     * Big number in the centre is the average over all per-project
     * averages. Sub-line carries the ↑/↓ delta against the previous
     * persisted scan when one exists.
     */
    private _renderMacroDonut(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'dash-donut';

        let healthy = 0;
        let warning = 0;
        let risky = 0;
        let scoreSum = 0;
        let scored = 0;
        for (const col of this._columns.values()) {
            let psum = 0;
            let pn = 0;
            for (const cell of Object.values(col.cells)) {
                if (cell.score !== null) {
                    psum += cell.score;
                    pn++;
                }
            }
            if (pn === 0) {
                continue;
            }
            const avg = psum / pn;
            scoreSum += avg;
            scored++;
            if (avg >= 80) {
                healthy++;
            } else if (avg >= 60) {
                warning++;
            } else {
                risky++;
            }
        }
        const overall = scored > 0 ? Math.round(scoreSum / scored) : null;
        const total = healthy + warning + risky;

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('class', 'dash-donut-svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('width', '160');
        svg.setAttribute('height', '160');

        // Donut background ring (light grey) — sits behind so an
        // unscored ecosystem still shows the shape.
        const bg = document.createElementNS(svgNs, 'circle');
        bg.setAttribute('cx', '50');
        bg.setAttribute('cy', '50');
        bg.setAttribute('r', '40');
        bg.setAttribute('fill', 'none');
        bg.setAttribute('class', 'dash-donut-bg');
        svg.appendChild(bg);

        // Segments — stroke-dasharray / -dashoffset rotated counter-
        // clockwise so the slice order starts at 12 o'clock and walks
        // clockwise. Circumference of r=40 is 2π·40 ≈ 251.33.
        const circ = 2 * Math.PI * 40;
        const seg = (n: number, cls: string, offset: number): void => {
            if (n === 0) {
                return;
            }
            const length = (n / total) * circ;
            const c = document.createElementNS(svgNs, 'circle');
            c.setAttribute('cx', '50');
            c.setAttribute('cy', '50');
            c.setAttribute('r', '40');
            c.setAttribute('fill', 'none');
            c.setAttribute('class', `dash-donut-seg dash-donut-seg-${cls}`);
            c.setAttribute('stroke-dasharray', `${length} ${circ - length}`);
            c.setAttribute('stroke-dashoffset', String(-offset));
            c.setAttribute('transform', 'rotate(-90 50 50)');
            svg.appendChild(c);
        };
        if (total > 0) {
            seg(healthy, 'good', 0);
            seg(warning, 'warn', (healthy / total) * circ);
            seg(risky, 'risk', ((healthy + warning) / total) * circ);
        }

        // Big-number in the centre.
        const num = document.createElementNS(svgNs, 'text');
        num.setAttribute('class', 'dash-donut-num');
        num.setAttribute('x', '50');
        num.setAttribute('y', '50');
        num.setAttribute('text-anchor', 'middle');
        num.setAttribute('dominant-baseline', 'central');
        num.textContent = overall !== null ? `${overall}` : '—';
        svg.appendChild(num);

        // "/100" suffix underneath.
        const sub = document.createElementNS(svgNs, 'text');
        sub.setAttribute('class', 'dash-donut-sub');
        sub.setAttribute('x', '50');
        sub.setAttribute('y', '66');
        sub.setAttribute('text-anchor', 'middle');
        sub.textContent = I18n.t('avg / 100');
        svg.appendChild(sub);

        wrap.appendChild(svg);

        const legend = document.createElement('div');
        legend.className = 'dash-donut-legend';

        const legendRow = (cls: string, count: number, label: string): HTMLElement => {
            const row = document.createElement('div');
            row.className = 'dash-donut-legend-row';
            const dot = document.createElement('span');
            dot.className = `dash-donut-legend-dot dash-donut-legend-dot-${cls}`;
            row.appendChild(dot);
            const text = document.createElement('span');
            text.className = 'dash-donut-legend-text';
            text.textContent = `${count} ${label}`;
            row.appendChild(text);
            return row;
        };
        legend.appendChild(legendRow('good', healthy, I18n.t('healthy')));
        legend.appendChild(legendRow('warn', warning, I18n.t('warning')));
        legend.appendChild(legendRow('risk', risky, I18n.t('risky')));

        if (overall !== null && this._previousOverall !== null
            && overall !== this._previousOverall) {
            const delta = overall - this._previousOverall;
            const sign = delta > 0 ? '↑' : '↓';
            const line = document.createElement('div');
            line.className = `dash-donut-delta dash-donut-delta-${delta > 0 ? 'up' : 'down'}`;
            line.textContent = I18n.t('{sign}{n} pts vs last scan', {
                sign,
                n: Math.abs(delta)
            });
            legend.appendChild(line);
        }

        wrap.appendChild(legend);
        return wrap;
    }

    /**
     * Cross-project top-N table: aggregate every CellFinding by its
     * `label`, sum unified severity weights (info=1 / warn=10 /
     * risk=30) per package, and surface the heaviest contributors.
     * Mirrors the score formula's weighting so a row's "−X pts"
     * matches the user's intuition for which package is dragging the
     * fleet down.
     */
    private _renderTopWorstPackages(): HTMLElement {
        const weights: Record<'info'|'warn'|'risk', number> = {info: 1, warn: 10, risk: 30};
        type Agg = {
            label: string;
            projects: Set<string>;
            weight: number;
            scanners: Map<string, number>;
            risk: number;
            warn: number;
            info: number;
        };
        const byLabel = new Map<string, Agg>();
        for (const col of this._columns.values()) {
            for (const [scanner, cell] of Object.entries(col.cells)) {
                for (const f of cell.findings) {
                    let agg = byLabel.get(f.label);
                    if (!agg) {
                        agg = {
                            label: f.label,
                            projects: new Set(),
                            weight: 0,
                            scanners: new Map(),
                            risk: 0,
                            warn: 0,
                            info: 0
                        };
                        byLabel.set(f.label, agg);
                    }
                    agg.projects.add(col.project.unid);
                    agg.weight += weights[f.severity];
                    agg.scanners.set(scanner, (agg.scanners.get(scanner) ?? 0) + 1);
                    agg[f.severity]++;
                }
            }
        }

        const wrap = document.createElement('div');
        wrap.className = 'dash-topworst';

        const head = document.createElement('div');
        head.className = 'dash-topworst-head';
        const title = document.createElement('h3');
        title.className = 'dash-topworst-title';
        title.textContent = I18n.t('Top problem packages');
        head.appendChild(title);
        const hint = document.createElement('div');
        hint.className = 'dash-topworst-hint';
        hint.textContent = I18n.t('Click a row to open Impact analysis.');
        head.appendChild(hint);
        wrap.appendChild(head);

        if (byLabel.size === 0) {
            const empty = document.createElement('div');
            empty.className = 'dash-topworst-empty';
            empty.textContent = I18n.t('No findings — every project is clean.');
            wrap.appendChild(empty);
            return wrap;
        }

        const ranked = Array.from(byLabel.values())
            .sort((a, b) => b.weight - a.weight)
            .slice(0, 10);

        const list = document.createElement('div');
        list.className = 'dash-topworst-list';
        for (const a of ranked) {
            const row = document.createElement('div');
            row.className = 'dash-topworst-row';
            row.title = I18n.t('Open Impact analysis for this package');
            row.addEventListener('click', () => {
                const parsed = DashboardView._parseFindingLabel(a.label);
                new ImpactModal().open(parsed);
            });

            const name = document.createElement('div');
            name.className = 'dash-topworst-name';
            name.textContent = a.label;
            row.appendChild(name);

            const projects = document.createElement('div');
            projects.className = 'dash-topworst-projects';
            projects.textContent = a.projects.size === 1
                ? I18n.t('in 1 project')
                : I18n.t('in {n} projects', {n: a.projects.size});
            row.appendChild(projects);

            const topScanner = Array.from(a.scanners.entries())
                .sort((x, y) => y[1] - x[1])[0];
            const scannerEl = document.createElement('div');
            scannerEl.className = 'dash-topworst-scanner';
            scannerEl.textContent = topScanner
                ? DashboardView._scannerLabel(topScanner[0] as ScannerId)
                : '';
            row.appendChild(scannerEl);

            const pts = document.createElement('div');
            pts.className = 'dash-topworst-pts';
            pts.textContent = `−${a.weight} ${I18n.t('pts')}`;
            row.appendChild(pts);

            list.appendChild(row);
        }
        wrap.appendChild(list);
        return wrap;
    }

    /**
     * Trend tab body. Multi-line SVG chart, one polyline per project
     * over the chosen range. Hand-rolled (matches the project's "D3
     * only when it earns its keep" stance — line + axis ticks are
     * pure SVG, no d3-scale).
     */
    private _renderTrendTab(): void {
        if (!this._tableHost) {
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'dash-trend';

        // Range selector — clicking a chip re-fetches with the new
        // window and re-renders. Cheap, the endpoint is sub-100ms.
        const controls = document.createElement('div');
        controls.className = 'dash-trend-controls';
        const label = document.createElement('span');
        label.className = 'dash-trend-controls-label';
        label.textContent = I18n.t('Range:');
        controls.appendChild(label);
        for (const days of [30, 90, 365] as const) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dash-trend-range';
            if (days === this._trendRangeDays) {
                btn.classList.add('dash-trend-range-active');
            }
            btn.textContent = I18n.t('{n}d', {n: days});
            btn.addEventListener('click', () => {
                if (this._trendRangeDays === days) {
                    return;
                }
                this._trendRangeDays = days;
                void this._loadHistory();
            });
            controls.appendChild(btn);
        }
        wrap.appendChild(controls);

        if (this._historyEntries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'dash-trend-empty';
            empty.textContent = I18n.t('No history yet — trigger a scan and come back tomorrow.');
            wrap.appendChild(empty);
            this._tableHost.appendChild(wrap);
            return;
        }

        wrap.appendChild(this._renderTrendChart(this._historyEntries));
        this._tableHost.appendChild(wrap);
    }

    /**
     * Pure-SVG line chart. Layout: 800×320 viewport; 40px padding
     * left/bottom for axis labels, 12px padding top/right. One
     * `<polyline>` per project, plus the ecosystem-overall line on
     * top in a heavier stroke. Hover-tooltip via title attributes on
     * the data dots — cheap and accessible.
     */
    private _renderTrendChart(entries: DashboardHistoryEntry[]): SVGElement {
        const svgNs = 'http://www.w3.org/2000/svg';
        const W = 880;
        const H = 360;
        const PAD_L = 44;
        const PAD_R = 200; // legend column
        const PAD_T = 16;
        const PAD_B = 36;
        const PLOT_W = W - PAD_L - PAD_R;
        const PLOT_H = H - PAD_T - PAD_B;

        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('class', 'dash-trend-svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        // X scale: timestamp → pixel. Single-entry guard so we don't
        // divide by zero on the first scan.
        const tStart = new Date(entries[0].timestamp).getTime();
        const tEnd = new Date(entries[entries.length - 1].timestamp).getTime();
        const tSpan = Math.max(1, tEnd - tStart);
        const xPx = (iso: string): number => {
            const t = new Date(iso).getTime();
            return PAD_L + ((t - tStart) / tSpan) * PLOT_W;
        };
        const yPx = (score: number): number =>
            PAD_T + (1 - score / 100) * PLOT_H;

        // Y gridlines + labels at 0/25/50/75/100.
        for (const score of [0, 25, 50, 75, 100]) {
            const y = yPx(score);
            const line = document.createElementNS(svgNs, 'line');
            line.setAttribute('class', 'dash-trend-grid');
            line.setAttribute('x1', String(PAD_L));
            line.setAttribute('y1', String(y));
            line.setAttribute('x2', String(PAD_L + PLOT_W));
            line.setAttribute('y2', String(y));
            svg.appendChild(line);
            const lbl = document.createElementNS(svgNs, 'text');
            lbl.setAttribute('class', 'dash-trend-axis');
            lbl.setAttribute('x', String(PAD_L - 6));
            lbl.setAttribute('y', String(y + 4));
            lbl.setAttribute('text-anchor', 'end');
            lbl.textContent = String(score);
            svg.appendChild(lbl);
        }

        // X-axis date ticks: first, middle, last entry timestamps.
        const tickIdx = entries.length === 1
            ? [0]
            : entries.length === 2
                ? [0, entries.length - 1]
                : [0, Math.floor(entries.length / 2), entries.length - 1];
        for (const i of tickIdx) {
            const x = xPx(entries[i].timestamp);
            const lbl = document.createElementNS(svgNs, 'text');
            lbl.setAttribute('class', 'dash-trend-axis');
            lbl.setAttribute('x', String(x));
            lbl.setAttribute('y', String(PAD_T + PLOT_H + 18));
            lbl.setAttribute('text-anchor', 'middle');
            lbl.textContent = DashboardView._formatShortDate(entries[i].timestamp);
            svg.appendChild(lbl);
        }

        // Collect each project's timeline. A project absent from an
        // entry (added later or removed) just has no point at that x —
        // polyline skips the gap by splitting into segments.
        type ProjectSeries = {unid: string; name: string; points: {x: number; y: number; iso: string; score: number}[]};
        const seriesByUnid = new Map<string, ProjectSeries>();
        for (const entry of entries) {
            for (const p of entry.perProject) {
                if (p.avg === null) {
                    continue;
                }
                let s = seriesByUnid.get(p.unid);
                if (!s) {
                    s = {unid: p.unid, name: p.name, points: []};
                    seriesByUnid.set(p.unid, s);
                }
                s.points.push({
                    x: xPx(entry.timestamp),
                    y: yPx(p.avg),
                    iso: entry.timestamp,
                    score: p.avg
                });
            }
        }

        // Sort projects by latest score asc so the worst project ends
        // up on top of the legend (and at the bottom of the chart's
        // z-order, which is fine — we paint overall last).
        const seriesList = Array.from(seriesByUnid.values())
            .sort((a, b) => {
                const la = a.points[a.points.length - 1]?.score ?? 100;
                const lb = b.points[b.points.length - 1]?.score ?? 100;
                return la - lb;
            });

        // Colour palette — cycles for projects beyond the 12th. Picked
        // so adjacent hues stay distinguishable on a dark background.
        const palette = [
            '#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#5f27cd', '#ff9ff3',
            '#54a0ff', '#00d2d3', '#c8d6e5', '#ee5253', '#10ac84', '#ff9f43'
        ];

        for (let i = 0; i < seriesList.length; i++) {
            const s = seriesList[i];
            const colour = palette[i % palette.length];
            const poly = document.createElementNS(svgNs, 'polyline');
            poly.setAttribute('class', 'dash-trend-line');
            poly.setAttribute('points', s.points.map((p) => `${p.x},${p.y}`).join(' '));
            poly.setAttribute('stroke', colour);
            svg.appendChild(poly);
            for (const p of s.points) {
                const dot = document.createElementNS(svgNs, 'circle');
                dot.setAttribute('class', 'dash-trend-dot');
                dot.setAttribute('cx', String(p.x));
                dot.setAttribute('cy', String(p.y));
                dot.setAttribute('r', '2.5');
                dot.setAttribute('fill', colour);
                const title = document.createElementNS(svgNs, 'title');
                title.textContent = `${s.name}: ${p.score} · ${DashboardView._formatShortDate(p.iso)}`;
                dot.appendChild(title);
                svg.appendChild(dot);
            }
        }

        // Ecosystem-overall line — heavier stroke, painted last so it
        // sits on top.
        const overallPoints = entries
            .filter((e) => e.overall !== null)
            .map((e) => ({x: xPx(e.timestamp), y: yPx(e.overall!), iso: e.timestamp, score: e.overall!}));
        if (overallPoints.length > 1) {
            const poly = document.createElementNS(svgNs, 'polyline');
            poly.setAttribute('class', 'dash-trend-line dash-trend-line-overall');
            poly.setAttribute('points', overallPoints.map((p) => `${p.x},${p.y}`).join(' '));
            svg.appendChild(poly);
        }
        for (const p of overallPoints) {
            const dot = document.createElementNS(svgNs, 'circle');
            dot.setAttribute('class', 'dash-trend-dot dash-trend-dot-overall');
            dot.setAttribute('cx', String(p.x));
            dot.setAttribute('cy', String(p.y));
            dot.setAttribute('r', '3.5');
            const title = document.createElementNS(svgNs, 'title');
            title.textContent = `${I18n.t('Ecosystem overall')}: ${p.score} · ${DashboardView._formatShortDate(p.iso)}`;
            dot.appendChild(title);
            svg.appendChild(dot);
        }

        // Legend column on the right. Overall sits on top, then
        // per-project worst-first.
        const legendX = PAD_L + PLOT_W + 16;
        let legendY = PAD_T + 4;
        const legendEntry = (colour: string, text: string, isOverall: boolean): void => {
            const swatch = document.createElementNS(svgNs, 'line');
            swatch.setAttribute('x1', String(legendX));
            swatch.setAttribute('y1', String(legendY));
            swatch.setAttribute('x2', String(legendX + 18));
            swatch.setAttribute('y2', String(legendY));
            swatch.setAttribute('stroke', colour);
            swatch.setAttribute('stroke-width', isOverall ? '3' : '2');
            swatch.setAttribute('stroke-linecap', 'round');
            svg.appendChild(swatch);
            const lbl = document.createElementNS(svgNs, 'text');
            lbl.setAttribute('class', isOverall
                ? 'dash-trend-legend dash-trend-legend-overall'
                : 'dash-trend-legend');
            lbl.setAttribute('x', String(legendX + 24));
            lbl.setAttribute('y', String(legendY + 4));
            lbl.textContent = text;
            svg.appendChild(lbl);
            legendY += 18;
        };
        legendEntry('currentColor', I18n.t('Ecosystem overall'), true);
        for (let i = 0; i < seriesList.length && i < 12; i++) {
            legendEntry(palette[i % palette.length], seriesList[i].name, false);
        }
        if (seriesList.length > 12) {
            const lbl = document.createElementNS(svgNs, 'text');
            lbl.setAttribute('class', 'dash-trend-legend');
            lbl.setAttribute('x', String(legendX + 24));
            lbl.setAttribute('y', String(legendY + 4));
            lbl.textContent = I18n.t('+ {n} more', {n: seriesList.length - 12});
            svg.appendChild(lbl);
        }

        return svg;
    }

    /**
     * Parse a CellFinding label into name + version. Per-package
     * scanners emit `name@version`; per-project scanners (template,
     * unused, mutableResolution) emit either `name` or
     * `name@version` depending on the finding. ImpactModal handles
     * both — name-only seeds skip the version filter.
     */
    private static _parseFindingLabel(label: string): {name?: string; version?: string} {
        // Scoped packages start with `@scope/name@version`; only the
        // *last* `@` separates name from version.
        const at = label.lastIndexOf('@');
        if (at <= 0) {
            return {name: label};
        }
        return {name: label.slice(0, at), version: label.slice(at + 1)};
    }

    /** YYYY-MM-DD without leading century — tighter on the X axis. */
    private static _formatShortDate(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return iso;
        }
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear() % 100}-${m}-${day}`;
    }

    private static _renderPills(risk: number, warn: number, info: number): HTMLElement {
        const pills = document.createElement('div');
        pills.className = 'dash-overall-pills';
        if (risk > 0) {
            const pill = document.createElement('span');
            pill.className = 'dash-overall-pill dash-overall-pill-risk';
            pill.textContent = String(risk);
            pill.title = I18n.t('{n} risk-level finding(s)', {n: risk});
            pills.appendChild(pill);
        }
        if (warn > 0) {
            const pill = document.createElement('span');
            pill.className = 'dash-overall-pill dash-overall-pill-warn';
            pill.textContent = String(warn);
            pill.title = I18n.t('{n} warn-level finding(s)', {n: warn});
            pills.appendChild(pill);
        }
        if (info > 0) {
            const pill = document.createElement('span');
            pill.className = 'dash-overall-pill dash-overall-pill-info';
            pill.textContent = String(info);
            pill.title = I18n.t('{n} info-level finding(s)', {n: info});
            pills.appendChild(pill);
        }
        return pills;
    }

    /**
     * Translated label for one scanner id. Centralised here so the
     * column-progress phrasing ("{project} — {scanner}") and the row
     * label use the same string.
     */
    private static _scannerLabel(id: ScannerId): string {
        switch (id) {
            case 'cve': return I18n.t('CVE (OSV)');
            case 'license': return I18n.t('License');
            case 'scripts': return I18n.t('Install scripts');
            case 'patterns': return I18n.t('Code patterns');
            case 'binaries': return I18n.t('Binaries');
            case 'obfuscation': return I18n.t('Obfuscation');
            case 'manifestRedFlags': return I18n.t('Manifest red-flags');
            case 'capability': return I18n.t('Capabilities');
            case 'maintainer': return I18n.t('Maintainer');
            case 'churn': return I18n.t('Churn');
            case 'cadence': return I18n.t('Cadence');
            case 'freshness': return I18n.t('Freshness');
            case 'ignoreScripts': return I18n.t('Ignore-scripts safety');
            case 'typosquat': return I18n.t('Typosquat');
            case 'provenance': return I18n.t('Provenance');
            case 'external': return I18n.t('External sources');
            case 'deprecation': return I18n.t('Deprecation');
            case 'integrity': return I18n.t('Integrity');
            case 'mutableResolution': return I18n.t('Mutable resolution');
            case 'unused': return I18n.t('Unused deps');
            case 'template': return I18n.t('Template compliance');
        }
    }

    /**
     * Left-most cell of each row — composes a 16×16 monoline icon, the
     * scanner label, and an info button. The info button hosts a
     * sibling tooltip that the CSS reveals on hover/focus — single DOM
     * node per row keeps event handling cheap (one `:hover` rule
     * covers all 15 rows).
     */
    private static _renderScannerCell(id: ScannerId): HTMLElement {
        // `<td>` keeps its native `display: table-cell` so the column
        // sizes correctly with the rest of the table; the flex layout
        // lives one level down on a wrapper div.
        const td = document.createElement('td');
        td.className = 'dash-td-scanner';

        const inner = document.createElement('div');
        inner.className = 'dash-scanner-inner';

        const iconWrap = document.createElement('span');
        iconWrap.className = 'dash-scanner-icon';
        iconWrap.innerHTML = DashboardView._scannerIcon(id);
        inner.appendChild(iconWrap);

        const label = document.createElement('span');
        label.className = 'dash-scanner-label';
        label.textContent = DashboardView._scannerLabel(id);
        inner.appendChild(label);

        const info = document.createElement('span');
        info.className = 'dash-scanner-info';
        info.tabIndex = 0;
        info.setAttribute('role', 'button');
        info.setAttribute('aria-label', I18n.t('Scanner info'));
        info.innerHTML = DashboardView._INFO_SVG;

        const tip = document.createElement('div');
        tip.className = 'dash-tooltip';

        const whatHead = document.createElement('strong');
        whatHead.textContent = I18n.t('What it scans');
        tip.appendChild(whatHead);
        const whatBody = document.createElement('p');
        whatBody.textContent = DashboardView._scannerWhat(id);
        tip.appendChild(whatBody);

        const howHead = document.createElement('strong');
        howHead.textContent = I18n.t('How the score is computed');
        tip.appendChild(howHead);
        const howBody = document.createElement('p');
        howBody.textContent = DashboardView._scannerHow(id);
        tip.appendChild(howBody);

        info.appendChild(tip);
        DashboardView._wireTooltip(info, tip);

        inner.appendChild(info);
        td.appendChild(inner);
        return td;
    }

    /**
     * Position the tooltip on hover / focus so it never overflows the
     * viewport. `position: fixed` escapes both the table-host overflow
     * and the pane-scroll, so the tooltip can render outside the
     * table's clip rect even for the bottom-most rows.
     *
     * Anchoring rules (default → fallbacks):
     *   • right of the info button, top-aligned with it
     *   • bottom-overflow → shift up so the bottom edge sits a margin
     *     above the viewport bottom
     *   • right-overflow → flip to the left side of the button
     */
    private static _wireTooltip(info: HTMLElement, tip: HTMLElement): void {
        const position = (): void => {
            const infoRect = info.getBoundingClientRect();
            const margin = 12;
            const gap = 8;

            // Switch to fixed first; sizes were already computed by the
            // initial absolute-positioned render, so offsetWidth/Height
            // remain accurate.
            tip.style.position = 'fixed';
            tip.style.left = '0px';
            tip.style.top = '0px';

            const tipWidth = tip.offsetWidth;
            const tipHeight = tip.offsetHeight;

            let left = infoRect.right + gap;
            let top = infoRect.top - 6;

            if (left + tipWidth > window.innerWidth - margin) {
                left = infoRect.left - tipWidth - gap;
            }
            if (left < margin) {
                left = margin;
            }

            if (top + tipHeight > window.innerHeight - margin) {
                top = window.innerHeight - margin - tipHeight;
            }
            if (top < margin) {
                top = margin;
            }

            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
        };

        info.addEventListener('mouseenter', position);
        info.addEventListener('focus', position);
    }

    /**
     * 16×16 outline icon per scanner. All paths share the same stroke
     * conventions (currentColor, stroke-width 2, round caps/joins)
     * so they pick up the row's text colour and look uniform when
     * placed side by side. Inline SVG strings keep the bundle a single
     * `.ts` file — no extra fetches.
     */
    private static _scannerIcon(id: ScannerId): string {
        const s = (path: string): string =>
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
            + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';

        switch (id) {
            case 'cve':
                // Shield with exclamation
                return s('<path d="M12 2 4 5v6c0 5 4 9 8 11 4-2 8-6 8-11V5l-8-3z"/>'
                    + '<line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="16"/>');
            case 'license':
                // Scroll / document
                return s('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
                    + '<polyline points="14 2 14 8 20 8"/>'
                    + '<line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>');
            case 'scripts':
                // Terminal
                return s('<polyline points="4 7 9 12 4 17"/><line x1="12" y1="19" x2="20" y2="19"/>');
            case 'patterns':
                // Curly braces — code pattern matching
                return s('<path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2"/>'
                    + '<path d="M16 3h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2"/>');
            case 'binaries':
                // Cube
                return s('<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/>'
                    + '<polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>');
            case 'obfuscation':
                // Eye-off — hidden / masked code
                return s('<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 4.22-5.21"/>'
                    + '<path d="M10.58 5.08A10.43 10.43 0 0 1 12 5c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>'
                    + '<path d="M9.88 9.88a3 3 0 0 0 4.24 4.24"/>'
                    + '<line x1="3" y1="3" x2="21" y2="21"/>');
            case 'manifestRedFlags':
                // Flag — a manifest-level signal
                return s('<line x1="4" y1="22" x2="4" y2="3"/>'
                    + '<path d="M4 4h13l-2 4 2 4H4"/>');
            case 'capability':
                // Key — what does the package have permission to do
                return s('<circle cx="7" cy="14" r="4"/>'
                    + '<path d="M10 14l11-11"/><path d="M17 7l3 3"/><path d="M19 5l2 2"/>');
            case 'maintainer':
                // Person
                return s('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>'
                    + '<circle cx="12" cy="7" r="4"/>');
            case 'churn':
                // Trending up + spike
                return s('<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/>');
            case 'cadence':
                // Calendar
                return s('<rect x="3" y="4" width="18" height="18" rx="2"/>'
                    + '<line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>'
                    + '<line x1="3" y1="10" x2="21" y2="10"/>');
            case 'freshness':
                // Clock
                return s('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>');
            case 'ignoreScripts':
                // Shield with no-entry slash
                return s('<path d="M12 2 4 5v6c0 5 4 9 8 11 4-2 8-6 8-11V5l-8-3z"/>'
                    + '<line x1="8" y1="8" x2="16" y2="16"/>');
            case 'typosquat':
                // Magnifier over text
                return s('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>'
                    + '<line x1="8" y1="11" x2="14" y2="11"/>');
            case 'provenance':
                // Badge / sealed
                return s('<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>');
            case 'external':
                // Globe / world — external/internet reputation sources
                return s('<circle cx="12" cy="12" r="9"/>'
                    + '<line x1="3" y1="12" x2="21" y2="12"/>'
                    + '<path d="M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/>');
            case 'deprecation':
                // Crossed-out package — old release the maintainer
                // wants users to move off
                return s('<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/>'
                    + '<line x1="5" y1="5" x2="19" y2="19"/>');
            case 'integrity':
                // Lock
                return s('<rect x="4" y="11" width="16" height="10" rx="2"/>'
                    + '<path d="M8 11V7a4 4 0 0 1 8 0v4"/>');
            case 'mutableResolution':
                // Link with broken middle — non-reproducible resolution
                return s('<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07L11.5 4.5"/>'
                    + '<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07L12.5 19.5"/>'
                    + '<line x1="3" y1="3" x2="21" y2="21"/>');
            case 'unused':
                // Trash
                return s('<polyline points="3 6 5 6 21 6"/>'
                    + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>'
                    + '<path d="M10 11v6"/><path d="M14 11v6"/>'
                    + '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>');
            case 'template':
                // Clipboard with check
                return s('<rect x="6" y="4" width="12" height="18" rx="2"/>'
                    + '<rect x="9" y="2" width="6" height="4" rx="1"/>'
                    + '<polyline points="9 13 11 15 15 11"/>');
        }
    }

    /**
     * Two-line description per scanner (what + how). Kept in the view
     * because the strings only ever surface in this one tooltip — no
     * other view needs them.
     */
    private static _scannerWhat(id: ScannerId): string {
        switch (id) {
            case 'cve':
                return I18n.t('Queries OSV.dev for known vulnerabilities affecting each installed name@version.');
            case 'license':
                return I18n.t('Classifies the SPDX expression of every package against the configured allow/denylist (permissive / weak-copyleft / strong-copyleft / proprietary / unknown).');
            case 'scripts':
                return I18n.t('Detects preinstall / install / postinstall / prepare hooks declared in each package.json. Higher severity for scripts that fetch the network or exec child processes.');
            case 'patterns':
                return I18n.t('Regex-scans tarball JavaScript for risky patterns: eval / Function / child_process / base64-decoded eval, etc.');
            case 'binaries':
                return I18n.t('Classifies binary files inside the tarball by extension and whether they sit on the bin/ path (executables the publisher exposes to npm install).');
            case 'obfuscation':
                return I18n.t('Looks for code-obfuscation fingerprints inside JS files: obfuscator.io _0x identifiers, eval(atob(...)) chains, hex-string arrays, and pathologically long lines outside of dist/min paths.');
            case 'manifestRedFlags':
                return I18n.t('Pure heuristics over `package.json`: missing README, missing description, missing files[] allowlist, many bin entries, the native-build+postinstall combo, or an engines.node range that excludes modern Node.');
            case 'capability':
                return I18n.t('Per-package capability inventory: which APIs the JS files touch (fs read/write, http/fetch, raw sockets, child_process, credential-shaped env vars, native bindings, eval). Severity is by combination, not by individual capability.');
            case 'maintainer':
                return I18n.t('Spots publisher handovers on mature packages. A short gap between the previous and current publisher on a long-lived package matches the event-stream / ua-parser-js takeover pattern.');
            case 'churn':
                return I18n.t('Diffs the current tarball against the previous stable release. Outsized add/remove/modify counts for a patch or minor bump are flagged.');
            case 'cadence':
                return I18n.t('Looks at the registry release timeline. Very stale (no recent releases) or unusually bursty cadence both raise the level.');
            case 'freshness':
                return I18n.t('Combines package age (first publish) with publisher account age. A brand-new package by a brand-new account is the highest-risk pair.');
            case 'ignoreScripts':
                return I18n.t('Derives a recommendation for `npm install --ignore-scripts`. Packages whose hooks do non-trivial work (compile, fetch, write to disk) flip the recommendation away from "ignore".');
            case 'typosquat':
                return I18n.t('Levenshtein distance to popular packages plus Unicode confusables (homoglyph attacks). Distance 1 / Unicode = risk; distance 2 = warn.');
            case 'provenance':
                return I18n.t('Reads the registry dist record for SLSA / sigstore attestation. Provenance + signed land in the no-finding bucket; unsigned counts as info.');
            case 'external':
                return I18n.t('Aggregates third-party reputation: socket.dev (supply-chain risk score), OpenSSF Scorecard (repo development practices), deps.dev (Google package index). Worst-of-three severity per package.');
            case 'deprecation':
                return I18n.t('Reads the per-version `deprecated` flag from the npm packument. Flags packages where the installed version, or the registry latest, was marked deprecated by the maintainer.');
            case 'integrity':
                return I18n.t('Cross-checks the lockfile `resolved` URL + `integrity` hash against what the registry currently serves. Mismatches and mirror redirects are surfaced.');
            case 'mutableResolution':
                return I18n.t('Walks the lockfile for entries that can\'t be reproduced deterministically: mutable git refs (branch/tag instead of SHA), missing integrity hashes on registry tarballs, file:/link: local protocols.');
            case 'unused':
                return I18n.t('Walks project source files for unused declared deps, misplaced (dev imports under runtime), and missing (imported but undeclared) packages.');
            case 'template':
                return I18n.t('Compares the project against the templates it declares — required deps + forbidden ranges + root metadata + file rules.');
        }
    }

    /**
     * Scoring-formula explanation. The first sentence is the same
     * everywhere (the unified formula); the second is scanner-specific
     * so the user understands what counts as info / warn / risk for
     * this particular row.
     */
    private static _scannerHow(id: ScannerId): string {
        const base = I18n.t('Unified formula: 100 × (1 − Σ min(weight, 30) / (packages × 30)) with info=1, warn=10, risk=30.');
        let specific: string;
        switch (id) {
            case 'cve':
                specific = I18n.t('Every OSV hit counts as risk (no per-vuln severity is fetched in batch).');
                break;
            case 'license':
                specific = I18n.t('Permissive licenses do not count. Unknown / weak-copyleft = info, strong-copyleft = warn, proprietary = risk.');
                break;
            case 'scripts':
            case 'patterns':
            case 'binaries':
            case 'obfuscation':
            case 'manifestRedFlags':
            case 'capability':
            case 'maintainer':
            case 'churn':
            case 'cadence':
            case 'freshness':
                specific = I18n.t('The scanner\'s native info / warn / risk severity is used as-is.');
                break;
            case 'ignoreScripts':
                specific = I18n.t('needs-scripts = info, avoid-scripts = risk. unaffected / safe-to-ignore do not count.');
                break;
            case 'typosquat':
                specific = I18n.t('exact / unrelated do not count. Distance 2 = warn; distance 1 or Unicode confusable = risk.');
                break;
            case 'provenance':
                specific = I18n.t('provenance / signed are clean. Only unsigned counts (as info).');
                break;
            case 'external':
                specific = I18n.t('Per-source severity (socket overall <50 = risk, <80 = warn; OpenSSF <5 = risk, <7 = warn; deps.dev = info only) reduced to worst-of-three per package.');
                break;
            case 'deprecation':
                specific = I18n.t('Installed version deprecated = risk, latest deprecated = warn, only older versions deprecated = info.');
                break;
            case 'integrity':
                specific = I18n.t('Per-finding info / warn / risk applied; total is divided by the package count for the score.');
                break;
            case 'mutableResolution':
                specific = I18n.t('Mutable git ref = risk, missing integrity hash = warn, file:/link: protocol = info. Synthesized lockfiles render N/A.');
                break;
            case 'unused':
                specific = I18n.t('Each unused entry uses its own severity. Misplaced and missing each count as warn.');
                break;
            case 'template':
                specific = I18n.t('Each compliance finding contributes its native severity. Projects without a declared template render N/A.');
                break;
        }
        return `${base} ${specific}`;
    }

    /** 14×14 outline info "i" inside a circle — feather-style. */
    private static readonly _INFO_SVG =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" '
        + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + '<circle cx="12" cy="12" r="10"/>'
        + '<line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8"/>'
        + '</svg>';

    /**
     * SVG progress-ring with the score in the centre. Mirrors the
     * Treeview health-ring so the dashboard and treeview rings move
     * in lockstep for the same numbers. `score: null` renders an
     * em-dash inside a neutral ring.
     */
    private static _renderRing(cell: DashboardCell): SVGElement {
        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', '0 0 36 36');
        svg.setAttribute('width', '36');
        svg.setAttribute('height', '36');

        const score = cell.score;
        const tier = score === null
            ? 'na'
            : score >= 80 ? 'good' : score >= 60 ? 'warn' : 'risk';
        svg.setAttribute('class', `dash-ring dash-ring-${tier}`);

        const bg = document.createElementNS(svgNs, 'circle');
        bg.setAttribute('class', 'dash-ring-bg');
        bg.setAttribute('cx', '18');
        bg.setAttribute('cy', '18');
        bg.setAttribute('r', '15');
        bg.setAttribute('fill', 'none');
        svg.appendChild(bg);

        if (score !== null) {
            const fg = document.createElementNS(svgNs, 'circle');
            fg.setAttribute('class', 'dash-ring-fg');
            fg.setAttribute('cx', '18');
            fg.setAttribute('cy', '18');
            fg.setAttribute('r', '15');
            fg.setAttribute('fill', 'none');
            fg.setAttribute('pathLength', '100');
            fg.setAttribute('stroke-dasharray', `${score}, 100`);
            fg.setAttribute('stroke-linecap', 'round');
            fg.setAttribute('transform', 'rotate(-90 18 18)');
            svg.appendChild(fg);
        }

        const text = document.createElementNS(svgNs, 'text');
        text.setAttribute('class', 'dash-ring-text');
        text.setAttribute('x', '18');
        text.setAttribute('y', '22');
        text.setAttribute('text-anchor', 'middle');
        text.textContent = score === null ? '—' : String(score);
        svg.appendChild(text);

        return svg;
    }

    private static _cellTooltip(cell: DashboardCell, _scanner: ScannerId): string {
        if (cell.score === null) {
            return cell.note ?? I18n.t('N/A');
        }
        const summary: string[] = [`${cell.score}%`];
        if (cell.counts.risk > 0) {
            summary.push(`${cell.counts.risk} risk`);
        }
        if (cell.counts.warn > 0) {
            summary.push(`${cell.counts.warn} warn`);
        }
        if (cell.counts.info > 0) {
            summary.push(`${cell.counts.info} info`);
        }
        if (cell.total > 0) {
            summary.push(I18n.t('over {n} packages', {n: String(cell.total)}));
        }
        let text = summary.join(' · ');

        // Top-3 findings as separate lines — the native `title`
        // attribute renders newlines reliably in modern browsers.
        // Full list is available in the FindingsModal on click.
        const topFindings = cell.findings.slice(0, 3);
        if (topFindings.length > 0) {
            const lines = topFindings.map((f) =>
                `${f.severity.toUpperCase()} ${f.label}${f.detail ? ` · ${f.detail}` : ''}`
            );
            text = `${text}\n\n${lines.join('\n')}`;
            const flagged = cell.counts.risk + cell.counts.warn + cell.counts.info;
            if (flagged > topFindings.length) {
                text = `${text}\n…${flagged - topFindings.length} more (click to see all)`;
            }
        }
        return text;
    }

    /** Format an ISO timestamp into a short relative-ish string. */
    private static _formatTimestamp(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return iso;
        }
        const ageSec = (Date.now() - d.getTime()) / 1000;
        if (ageSec < 60) {
            return I18n.t('just now');
        }
        if (ageSec < 3600) {
            return I18n.t('{n} min ago', {n: String(Math.floor(ageSec / 60))});
        }
        if (ageSec < 86400) {
            return I18n.t('{n} h ago', {n: String(Math.floor(ageSec / 3600))});
        }
        return d.toLocaleString();
    }
}