import {
    ApiDashboardGrowthResponse,
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
} from '../shared/Api/ApiTypes.js';
import {DashboardCell, DashboardColumn, ScannerId} from '../backend/Dashboard/DashboardBuilder.js';
import {DashboardHistoryEntry} from '../backend/Dashboard/DashboardHistoryStore.js';
import {ChartRenderer} from './Dashboard/ChartRenderer.js';
import {Formatters} from './Dashboard/Formatters.js';
import {ScannerMeta} from './Dashboard/ScannerMeta.js';
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
    private _growth: ApiDashboardGrowthResponse|null = null;
    private _trendRangeDays: 30|90|365 = 90;
    private _trendMetric: 'score'|'packages'|'size'|'downloads' = 'score';
    private _widgetStripHost: HTMLElement|null = null;

    public constructor(root: HTMLElement) {
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
        /*
         * Fetch history in parallel — drives the macro-donut delta and
         * pre-warms the trend tab. A history failure is non-fatal; the
         * donut just hides its delta line.
         */
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
            /*
             * Re-render in case the user is already looking at the
             * scanner-score tab — the macro-donut needs to re-paint
             * its delta line now that the previous-overall is known.
             */
            this._renderTable();
        } catch {
            // ignore; donut just hides its delta line
        }
    }

    /**
     * Lazy-load the growth series only when the user actually picks
     * the "Packages" metric — score is the default and most users
     * will never touch the other chip on most sessions. Cached for
     * the lifetime of `show()` so flipping back and forth between
     * metrics is instant after the first fetch.
     */
    private async _loadGrowth(): Promise<void> {
        try {
            const res = await fetch(`/api/dashboard/growth?days=${this._trendRangeDays}`);
            if (!res.ok) {
                return;
            }
            const payload = (await res.json()) as ApiDashboardGrowthResponse;
            this._growth = payload;
            this._renderTable();
        } catch {
            // ignore; trend tab shows empty state
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
                ? I18n.t('Showing cached snapshot from {time}', {time: Formatters.timestamp(timestamp)})
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

        /*
         * Widget strip sits between the tab bar and the table body.
         * Painted only on the scanner-score tab — Overall has its own
         * hero card, Trend has its own chart.
         */
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
        const tabs: {value: 'scanner-score'|'overall'|'trend'; label: string;}[] = [
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
                        /*
                         * `type` is filled in by column-end; placeholder
                         * is good enough for the partial table render.
                         */
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
            const scannerLabel = data.scanner ? ScannerMeta.label(data.scanner) : '';
            /*
             * `detail` (when set) is the substring the user actually
             * wants to read — "Fingerprinting lodash@4.17.21 (32/84)
             * — kavula". It already encodes project/scanner context,
             * so the original `{project} — {scanner}` fallback only
             * kicks in for cell-level progress events.
             */
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
            /*
             * Per-project score is final once the column ends — emit
             * so the treeview ring updates progressively instead of
             * waiting for the whole scan.
             */
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

        /*
         * Header row — scanner column + one per project. Project
         * headers are clickable: they route through `onProjectClick`
         * so the user can jump from a worrying column straight into
         * the project's drill-down view (Nppm.handles).
         */
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
                /*
                 * Soft annotation (e.g. "no lockfile — scanned against
                 * registry latest"). Adds a small info marker after the
                 * project name without flipping the column to the red
                 * error style.
                 */
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

        /*
         * One row per scanner — `dash-row` lets CSS highlight the full
         * row on hover so the user can track project ↔ scanner
         * intersections at a glance.
         */
        const tbody = document.createElement('tbody');
        for (const scanner of this._scanners) {
            const row = document.createElement('tr');
            row.className = 'dash-row';
            row.appendChild(ScannerMeta.renderScannerCell(scanner));

            for (const unid of this._columnOrder) {
                const col = this._columns.get(unid);
                const cell = col?.cells[scanner];
                const td = document.createElement('td');
                td.className = 'dash-td-cell';
                if (cell) {
                    td.appendChild(ScannerMeta.renderRing(cell));
                    td.title = ScannerMeta.cellTooltip(cell);
                    td.classList.add('dash-td-clickable');
                    const projectName = col?.project.name ?? unid;
                    td.addEventListener('click', () => {
                        this._onCellClick?.(unid, projectName, scanner,
                            ScannerMeta.label(scanner), cell);
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
        /*
         * Project-health list and top-problem-packages roll-ups are
         * intentionally suppressed for now — the hero card carries
         * the same information in summary form and the modals offer
         * the drill-down. The `_renderOverall*` helpers stay around
         * so it's one-line to bring either back.
         */

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

        /*
         * SVG overlay must sit above the background image but below
         * the boxes — the boxes' z-index bumps them over it.
         */
        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('class', 'dash-eco-svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        card.appendChild(svg);

        // Compute ecosystem aggregates over every column we've seen.
        let totalRisk = 0;
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

        /*
         * Box layout — coordinates in % of the card, anchor points
         * (where the connector tip lands) likewise in %. Box origin
         * is its top-left corner.
         */
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
                /*
                 * Aim across the canopy toward the upper-centre tree
                 * foliage — longer, clearly visible diagonal instead
                 * of a stub that sits next to the box.
                 */
                anchorX: 40, anchorY: 26,
                label: I18n.t('Ecosystem health'),
                value: ecosystemHealth === null ? '—' : `${ecosystemHealth}/100`,
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
                /*
                 * Box bottom-left, anchor previously sat *inside* the
                 * box's X range so the line was a stub. Send it up
                 * and right toward the mushroom cluster at the
                 * tree's base — clear diagonal away from the box.
                 */
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
                /*
                 * Mirror of the info-findings box: the previous
                 * anchor sat inside the box's X range. Aim up and
                 * left toward the shield + dark-roots cluster so the
                 * diagonal is visible.
                 */
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

        /*
         * Draw connectors first so the boxes (added next) paint on
         * top. Start each line a few percent inside the box so the
         * origin is guaranteed to sit behind the solid box fill —
         * the visible portion of the line then emerges cleanly at
         * the box edge that faces the anchor. Boxes render at ~9-12%
         * tall on the 960×640 card; `+4` keeps the start well above
         * the bottom edge even on the shortest box.
         */
        for (const b of boxes) {
            const boxCenterX = b.left + (b.w / 2);
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
                unid: unid,
                name: col.project.name,
                avg: scanned > 0 ? Math.round(sum / scanned) : null,
                risk: risk, warn: warn, info: info,
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
                scoreEl.classList.add(DashboardView._overallScoreClass(a.avg));
            }
            scoreEl.title = I18n.t('{scanned} of {total} scanners contributed', {
                scanned: a.scannedCells, total: a.totalCells
            });
            row.appendChild(scoreEl);

            row.appendChild(Formatters.renderPills(a.risk, a.warn, a.info));
            section.appendChild(row);
        }
        return section;
    }

    private _renderOverallPackages(): HTMLElement|null {
        type Agg = {label: string; risk: number; warn: number; info: number; projects: Set<string>;};
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

            row.appendChild(Formatters.renderPills(a.risk, a.warn, a.info));
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

        /*
         * Donut background ring (light grey) — sits behind so an
         * unscored ecosystem still shows the shape.
         */
        const bg = document.createElementNS(svgNs, 'circle');
        bg.setAttribute('cx', '50');
        bg.setAttribute('cy', '50');
        bg.setAttribute('r', '40');
        bg.setAttribute('fill', 'none');
        bg.setAttribute('class', 'dash-donut-bg');
        svg.appendChild(bg);

        /*
         * Segments — stroke-dasharray / -dashoffset rotated counter-
         * clockwise so the slice order starts at 12 o'clock and walks
         * clockwise. Circumference of r=40 is 2π·40 ≈ 251.33.
         */
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
        num.textContent = overall === null ? '—' : `${overall}`;
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
                sign: sign,
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
                const parsed = Formatters.parseFindingLabel(a.label);
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
                ? ScannerMeta.label(topScanner[0] as ScannerId)
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

        /*
         * Metric selector — flipping between "Score" (uses the
         * dashboard-history payload) and "Packages" (uses the
         * growth payload reconstructed from per-project HistoryStore
         * files). The two metrics live on different Y axes so we
         * re-render the chart wholesale on switch.
         */
        const metrics = document.createElement('div');
        metrics.className = 'dash-trend-controls';
        const metricLabel = document.createElement('span');
        metricLabel.className = 'dash-trend-controls-label';
        metricLabel.textContent = I18n.t('Metric:');
        metrics.appendChild(metricLabel);
        const metricOpts: {value: 'score'|'packages'|'size'|'downloads'; label: string;}[] = [
            {value: 'score', label: I18n.t('Score')},
            {value: 'packages', label: I18n.t('Packages')},
            {value: 'size', label: I18n.t('Size')},
            {value: 'downloads', label: I18n.t('Downloads')}
        ];
        for (const m of metricOpts) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dash-trend-range';
            if (m.value === this._trendMetric) {
                btn.classList.add('dash-trend-range-active');
            }
            btn.textContent = m.label;
            btn.addEventListener('click', () => {
                if (this._trendMetric === m.value) {
                    return;
                }
                this._trendMetric = m.value;
                if (m.value === 'packages' && this._growth === null) {
                    void this._loadGrowth();
                } else {
                    this._renderTable();
                }
            });
            metrics.appendChild(btn);
        }
        wrap.appendChild(metrics);

        /*
         * Range selector — clicking a chip re-fetches with the new
         * window and re-renders. Cheap, the endpoint is sub-100ms.
         */
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
                /*
                 * Range change invalidates the cached growth payload
                 * (the endpoint clips server-side), so refetch both.
                 */
                this._growth = null;
                void this._loadHistory();
                if (this._trendMetric === 'packages') {
                    void this._loadGrowth();
                }
            });
            controls.appendChild(btn);
        }
        wrap.appendChild(controls);

        if (this._trendMetric === 'score') {
            if (this._historyEntries.length === 0) {
                wrap.appendChild(DashboardView._renderTrendEmpty(
                    I18n.t('No history yet — trigger a scan and come back tomorrow.')
                ));
                this._tableHost.appendChild(wrap);
                return;
            }
            wrap.appendChild(this._renderScoreChart(this._historyEntries));
        } else if (this._trendMetric === 'packages') {
            if (this._growth === null) {
                wrap.appendChild(DashboardView._renderTrendEmpty(I18n.t('Loading …')));
                this._tableHost.appendChild(wrap);
                return;
            }
            if (this._growth.series.length === 0) {
                wrap.appendChild(DashboardView._renderTrendEmpty(
                    I18n.t('No package-history yet — run a project lockfile call or git-backfill from the History view.')
                ));
                this._tableHost.appendChild(wrap);
                return;
            }
            wrap.appendChild(this._renderGrowthChart(this._growth));
        } else if (this._trendMetric === 'size') {
            /*
             * size — derived from the same DashboardHistoryEntry payload
             * the score chart reads. `typeof === 'number'` so older
             * entries persisted before the size field was added (where
             * the JSON lacks the key entirely) drop out cleanly.
             */
            const sized = this._historyEntries.filter((e) => typeof e.totalSizeBytes === 'number');
            if (sized.length === 0) {
                wrap.appendChild(DashboardView._renderTrendEmpty(
                    I18n.t('No size data yet — older scans pre-date the size metric. Re-scan to populate it.')
                ));
                this._tableHost.appendChild(wrap);
                return;
            }
            wrap.appendChild(this._renderSizeChart(sized));
        } else {
            // downloads
            const dl = this._historyEntries.filter(
                (e) => typeof e.totalDownloadsLastWeek === 'number'
            );
            if (dl.length === 0) {
                wrap.appendChild(DashboardView._renderTrendEmpty(
                    I18n.t('No downloads data yet — older scans pre-date the downloads metric. Re-scan to populate it.')
                ));
                this._tableHost.appendChild(wrap);
                return;
            }
            wrap.appendChild(this._renderDownloadsChart(dl));
        }

        this._tableHost.appendChild(wrap);
    }

    private static _renderTrendEmpty(msg: string): HTMLElement {
        const empty = document.createElement('div');
        empty.className = 'dash-trend-empty';
        empty.textContent = msg;
        return empty;
    }

    /**
     * Score-over-time chart. Y axis fixed at 0..100 since the
     * dashboard score formula caps there. Reuses the generic
     * `_renderChartSvg` helper after projecting the history entries
     * into the {series, overall} shape it expects.
     */
    private _renderScoreChart(entries: DashboardHistoryEntry[]): SVGElement {
        type Pt = {timestamp: string; value: number;};
        const seriesByUnid = new Map<string, {unid: string; name: string; points: Pt[];}>();
        for (const e of entries) {
            for (const p of e.perProject) {
                if (p.avg === null) {
                    continue;
                }
                let s = seriesByUnid.get(p.unid);
                if (!s) {
                    s = {unid: p.unid, name: p.name, points: []};
                    seriesByUnid.set(p.unid, s);
                }
                s.points.push({timestamp: e.timestamp, value: p.avg});
            }
        }
        const overall: Pt[] = entries
        .filter((e) => e.overall !== null)
        .map((e) => ({timestamp: e.timestamp, value: e.overall!}));
        return ChartRenderer.render({
            series: Array.from(seriesByUnid.values()),
            overall: overall,
            yMin: 0,
            yMax: 100,
            yTicks: [0, 25, 50, 75, 100],
            overallLabel: I18n.t('Ecosystem overall'),
            valueFormatter: (v) => String(v)
        });
    }

    /**
     * Package-count-over-time chart. Y axis derived from the data
     * (0..ceil(maxCount * 1.05)) so a slow-growing 50-package project
     * doesn't get visually flattened by a 5000-package monorepo on
     * the same axis. Total line carries the carry-forward ecosystem
     * sum from the growth builder.
     */
    private _renderGrowthChart(g: ApiDashboardGrowthResponse): SVGElement {
        type Pt = {timestamp: string; value: number;};
        const series = g.series.map((s) => ({
            unid: s.unid,
            name: s.name,
            points: s.points.map((p) => ({timestamp: p.timestamp, value: p.count}))
        }));
        const overall: Pt[] = g.total.map((p) => ({timestamp: p.timestamp, value: p.count}));
        let max = 0;
        for (const s of series) {
            for (const p of s.points) {
                if (p.value > max) {
                    max = p.value;
                }
            }
        }
        for (const p of overall) {
            if (p.value > max) {
                max = p.value;
            }
        }
        const yMax = Formatters.niceCeil(Math.max(max, 1));
        const yTicks = [0, Math.round(yMax * 0.25), Math.round(yMax * 0.5), Math.round(yMax * 0.75), yMax];
        return ChartRenderer.render({
            series: series,
            overall: overall,
            yMin: 0,
            yMax: yMax,
            yTicks: yTicks,
            overallLabel: I18n.t('Ecosystem total'),
            valueFormatter: (v) => String(v)
        });
    }

    /**
     * Installed-bytes chart. Reads per-project + ecosystem totals
     * from the DashboardHistoryEntry payload (recorded at each scan).
     * Y axis auto-scales with `_niceCeil` and labels use the
     * byte-formatter so the gridlines read "120 MB" not "125829120".
     */
    private _renderSizeChart(entries: DashboardHistoryEntry[]): SVGElement {
        type Pt = {timestamp: string; value: number;};
        const seriesByUnid = new Map<string, {unid: string; name: string; points: Pt[];}>();
        for (const e of entries) {
            for (const p of e.perProject) {
                if (typeof p.sizeBytes !== 'number') {
                    continue;
                }
                let s = seriesByUnid.get(p.unid);
                if (!s) {
                    s = {unid: p.unid, name: p.name, points: []};
                    seriesByUnid.set(p.unid, s);
                }
                s.points.push({timestamp: e.timestamp, value: p.sizeBytes});
            }
        }
        const overall: Pt[] = entries
        .filter((e) => typeof e.totalSizeBytes === 'number')
        .map((e) => ({timestamp: e.timestamp, value: e.totalSizeBytes as number}));
        let max = 0;
        for (const s of seriesByUnid.values()) {
            for (const p of s.points) {
                if (p.value > max) {
                    max = p.value;
                }
            }
        }
        for (const p of overall) {
            if (p.value > max) {
                max = p.value;
            }
        }
        const yMax = Formatters.niceCeil(Math.max(max, 1));
        const yTicks = [0, Math.round(yMax * 0.25), Math.round(yMax * 0.5), Math.round(yMax * 0.75), yMax];
        return ChartRenderer.render({
            series: Array.from(seriesByUnid.values()),
            overall: overall,
            yMin: 0,
            yMax: yMax,
            yTicks: yTicks,
            overallLabel: I18n.t('Ecosystem total'),
            valueFormatter: (v) => Formatters.bytes(v)
        });
    }

    /**
     * Downloads-per-week chart. Reads `perProject[].downloadsLastWeek`
     * + `totalDownloadsLastWeek` from the history payload. Y axis
     * auto-scaled; value formatter shows abbreviated counts (k / M).
     */
    private _renderDownloadsChart(entries: DashboardHistoryEntry[]): SVGElement {
        type Pt = {timestamp: string; value: number;};
        const seriesByUnid = new Map<string, {unid: string; name: string; points: Pt[];}>();
        for (const e of entries) {
            for (const p of e.perProject) {
                if (typeof p.downloadsLastWeek !== 'number') {
                    continue;
                }
                let s = seriesByUnid.get(p.unid);
                if (!s) {
                    s = {unid: p.unid, name: p.name, points: []};
                    seriesByUnid.set(p.unid, s);
                }
                s.points.push({timestamp: e.timestamp, value: p.downloadsLastWeek});
            }
        }
        const overall: Pt[] = entries
        .filter((e) => typeof e.totalDownloadsLastWeek === 'number')
        .map((e) => ({timestamp: e.timestamp, value: e.totalDownloadsLastWeek as number}));
        let max = 0;
        for (const s of seriesByUnid.values()) {
            for (const p of s.points) {
                if (p.value > max) {
                    max = p.value;
                }
            }
        }
        for (const p of overall) {
            if (p.value > max) {
                max = p.value;
            }
        }
        const yMax = Formatters.niceCeil(Math.max(max, 1));
        const yTicks = [0, Math.round(yMax * 0.25), Math.round(yMax * 0.5), Math.round(yMax * 0.75), yMax];
        return ChartRenderer.render({
            series: Array.from(seriesByUnid.values()),
            overall: overall,
            yMin: 0,
            yMax: yMax,
            yTicks: yTicks,
            overallLabel: I18n.t('Ecosystem total (deduplicated)'),
            valueFormatter: (v) => Formatters.count(v)
        });
    }

    /*
     * Map a 0-100 overall-score average to one of the three colour
     * classes (good ≥ 80, warn ≥ 60, risk otherwise). Pulled out of
     * the inline ternary so the call site stays single-statement.
     */
    private static _overallScoreClass(avg: number): string {
        if (avg >= 80) {
            return 'dash-overall-score-good';
        }
        if (avg >= 60) {
            return 'dash-overall-score-warn';
        }
        return 'dash-overall-score-risk';
    }

}