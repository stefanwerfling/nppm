import {DashboardColumn, ScannerId} from '../backend/Dashboard/DashboardBuilder.js';
import {I18n} from './I18n.js';

/**
 * Box identifiers used by the Overall-Evaluation hero card. Each
 * id maps to one metric box on the card; the modal renders a
 * box-specific description + detail breakdown.
 */
export type EcoBoxId =
    | 'projects'
    | 'ecosystem-health'
    | 'healthy-projects'
    | 'info-findings'
    | 'risk-findings'
    | 'cve-flags'
    | 'deprecated'
    | 'at-risk-projects'
    | 'maintainer-alerts'
    | 'typosquat-hits';

/**
 * Optional click handler for one of the modal's CTA buttons.
 * `target` tells the caller which navigation surface the user
 * wants — currently only the cross-project Matrix. Wired by
 * `Nppm` so the modal stays decoupled from the rest of the app.
 */
export type EcoBoxNavHandler = (target: 'matrix') => void;

/** Click handler for a per-project row (jumps to that project). */
export type EcoBoxProjectClickHandler = (projectUnid: string) => void;

/**
 * Detail modal opened from the ecosystem hero card. One modal
 * class handles all ten box types — the dispatch lives in
 * {@link _render}, so adding a new box is one switch case plus
 * one entry in {@link _describe}.
 */
export class EcosystemBoxModal {

    private _backdrop: HTMLElement|null = null;
    private _onNavigate: EcoBoxNavHandler|null = null;
    private _onProjectClick: EcoBoxProjectClickHandler|null = null;

    public onNavigate(handler: EcoBoxNavHandler): void {
        this._onNavigate = handler;
    }

    public onProjectClick(handler: EcoBoxProjectClickHandler): void {
        this._onProjectClick = handler;
    }

    public open(id: EcoBoxId, title: string, columns: Map<string, DashboardColumn>): void {
        if (this._backdrop) {
            this._backdrop.remove();
        }
        const backdrop = document.createElement('div');
        backdrop.className = 'umd-backdrop';
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) {
                this.close();
            }
        });
        document.body.appendChild(backdrop);
        this._backdrop = backdrop;

        const panel = document.createElement('div');
        panel.className = 'umd-panel ebm-panel';
        backdrop.appendChild(panel);

        panel.appendChild(this._renderHeader(title));
        panel.appendChild(this._renderDescription(id));
        panel.appendChild(this._renderBody(id, columns));

        const footer = this._renderFooter(id);
        if (footer) {
            panel.appendChild(footer);
        }

        document.addEventListener('keydown', this._onKeyDown);
    }

    public close(): void {
        this._backdrop?.remove();
        this._backdrop = null;
        document.removeEventListener('keydown', this._onKeyDown);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    private _renderHeader(title: string): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const titleEl = document.createElement('div');
        titleEl.className = 'umd-title';
        titleEl.textContent = title;
        head.appendChild(titleEl);
        const close = document.createElement('button');
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    private _renderDescription(id: EcoBoxId): HTMLElement {
        const desc = document.createElement('div');
        desc.className = 'ebm-desc';
        desc.textContent = EcosystemBoxModal._describe(id);
        return desc;
    }

    private _renderBody(id: EcoBoxId, columns: Map<string, DashboardColumn>): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'ebm-body';

        switch (id) {
            case 'projects':
                wrap.appendChild(this._renderProjectList(columns, () => true));
                return wrap;
            case 'healthy-projects':
                wrap.appendChild(this._renderProjectList(columns,
                    (avg) => avg !== null && avg >= 80));
                return wrap;
            case 'at-risk-projects':
                wrap.appendChild(this._renderProjectList(columns,
                    (avg) => avg !== null && avg < 60));
                return wrap;
            case 'ecosystem-health':
                wrap.appendChild(this._renderScannerAverages(columns));
                return wrap;
            case 'info-findings':
                wrap.appendChild(this._renderSeverityBreakdown(columns, 'info'));
                return wrap;
            case 'risk-findings':
                wrap.appendChild(this._renderSeverityBreakdown(columns, 'risk'));
                return wrap;
            case 'cve-flags':
                wrap.appendChild(this._renderPackageList(columns, 'cve'));
                return wrap;
            case 'deprecated':
                wrap.appendChild(this._renderPackageList(columns, 'deprecation'));
                return wrap;
            case 'maintainer-alerts':
                wrap.appendChild(this._renderPackageList(columns, 'maintainer'));
                return wrap;
            case 'typosquat-hits':
                wrap.appendChild(this._renderPackageList(columns, 'typosquat'));
                return wrap;
            default:
                return wrap;
        }
    }

    private _renderProjectList(
        columns: Map<string, DashboardColumn>,
        predicate: (avg: number|null) => boolean
    ): HTMLElement {
        type Row = {unid: string; name: string; avg: number|null;};
        const rows: Row[] = [];
        for (const [unid, col] of columns) {
            let sum = 0;
            let scanned = 0;
            for (const cell of Object.values(col.cells)) {
                if (cell.score !== null) {
                    sum += cell.score;
                    scanned++;
                }
            }
            const avg = scanned > 0 ? Math.round(sum / scanned) : null;
            if (predicate(avg)) {
                rows.push({unid: unid, name: col.project.name, avg: avg});
            }
        }
        rows.sort((a, b) => {
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

        const list = document.createElement('div');
        list.className = 'ebm-list';
        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ebm-empty';
            empty.textContent = I18n.t('No matching projects.');
            list.appendChild(empty);
            return list;
        }
        for (const r of rows) {
            const row = document.createElement('div');
            row.className = 'ebm-row ebm-row-clickable';
            row.title = I18n.t('Open project');
            row.addEventListener('click', () => {
                this._onProjectClick?.(r.unid);
                this.close();
            });
            const name = document.createElement('span');
            name.className = 'ebm-row-name';
            name.textContent = r.name;
            row.appendChild(name);
            const score = document.createElement('span');
            score.className = 'ebm-row-score';
            score.textContent = r.avg === null ? '—' : `${r.avg}/100`;
            if (r.avg !== null) {
                score.classList.add(EcosystemBoxModal._scoreClass(r.avg));
            }
            row.appendChild(score);
            list.appendChild(row);
        }
        return list;
    }

    private _renderScannerAverages(columns: Map<string, DashboardColumn>): HTMLElement {
        const byScanner = new Map<string, {sum: number; count: number;}>();
        for (const col of columns.values()) {
            for (const [scanner, cell] of Object.entries(col.cells)) {
                if (cell.score === null) {
                    continue;
                }
                let entry = byScanner.get(scanner);
                if (!entry) {
                    entry = {sum: 0, count: 0};
                    byScanner.set(scanner, entry);
                }
                entry.sum += cell.score;
                entry.count++;
            }
        }
        const rows = Array.from(byScanner.entries())
        .map(([scanner, e]) => ({scanner: scanner, avg: Math.round(e.sum / e.count)}))
        .sort((a, b) => a.avg - b.avg);

        const list = document.createElement('div');
        list.className = 'ebm-list';
        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ebm-empty';
            empty.textContent = I18n.t('No scanner data yet.');
            list.appendChild(empty);
            return list;
        }
        for (const r of rows) {
            const row = document.createElement('div');
            row.className = 'ebm-row';
            const name = document.createElement('span');
            name.className = 'ebm-row-name';
            name.textContent = r.scanner;
            row.appendChild(name);
            const score = document.createElement('span');
            score.className = 'ebm-row-score';
            score.textContent = `${r.avg}/100`;
            score.classList.add(EcosystemBoxModal._scoreClass(r.avg));
            row.appendChild(score);
            list.appendChild(row);
        }
        return list;
    }

    private _renderSeverityBreakdown(
        columns: Map<string, DashboardColumn>,
        severity: 'info'|'warn'|'risk'
    ): HTMLElement {
        const byScanner = new Map<string, number>();
        for (const col of columns.values()) {
            for (const [scanner, cell] of Object.entries(col.cells)) {
                const n = cell.counts[severity];
                if (n > 0) {
                    byScanner.set(scanner, (byScanner.get(scanner) ?? 0) + n);
                }
            }
        }
        const rows = Array.from(byScanner.entries())
        .sort((a, b) => b[1] - a[1]);

        const list = document.createElement('div');
        list.className = 'ebm-list';
        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ebm-empty';
            empty.textContent = I18n.t('No findings yet.');
            list.appendChild(empty);
            return list;
        }
        for (const [scanner, count] of rows) {
            const row = document.createElement('div');
            row.className = 'ebm-row';
            const name = document.createElement('span');
            name.className = 'ebm-row-name';
            name.textContent = scanner;
            row.appendChild(name);
            const countEl = document.createElement('span');
            countEl.className = `ebm-row-pill ebm-row-pill-${severity}`;
            countEl.textContent = String(count);
            row.appendChild(countEl);
            list.appendChild(row);
        }
        return list;
    }

    private _renderPackageList(
        columns: Map<string, DashboardColumn>,
        scanner: ScannerId
    ): HTMLElement {
        type Row = {label: string; projects: {unid: string; name: string;}[]; risk: number; warn: number;};
        const byLabel = new Map<string, Row>();
        for (const [unid, col] of columns) {
            const cell = col.cells[scanner];
            if (!cell) {
                continue;
            }
            for (const f of cell.findings) {
                let entry = byLabel.get(f.label);
                if (!entry) {
                    entry = {label: f.label, projects: [], risk: 0, warn: 0};
                    byLabel.set(f.label, entry);
                }
                if (!entry.projects.some((p) => p.unid === unid)) {
                    entry.projects.push({unid: unid, name: col.project.name});
                }
                if (f.severity === 'risk') {
                    entry.risk++;
                } else if (f.severity === 'warn') {
                    entry.warn++;
                }
            }
        }
        const rows = Array.from(byLabel.values())
        .sort((a, b) => {
            if (a.risk !== b.risk) {
                return b.risk - a.risk;
            }
            return b.warn - a.warn;
        });

        const list = document.createElement('div');
        list.className = 'ebm-list';
        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ebm-empty';
            empty.textContent = I18n.t('No matching packages.');
            list.appendChild(empty);
            return list;
        }
        for (const r of rows) {
            const row = document.createElement('div');
            row.className = 'ebm-row';
            const name = document.createElement('span');
            name.className = 'ebm-row-name';
            name.textContent = r.label;
            row.appendChild(name);

            const projList = document.createElement('span');
            projList.className = 'ebm-row-projects';
            const projNames = r.projects.map((p) => p.name);
            projList.textContent = projNames.length === 1
                ? I18n.t('in {name}', {name: projNames[0]})
                : I18n.t('in {n} projects', {n: projNames.length});
            projList.title = projNames.join(', ');
            row.appendChild(projList);

            const pills = document.createElement('span');
            pills.className = 'ebm-row-pills';
            if (r.risk > 0) {
                const p = document.createElement('span');
                p.className = 'ebm-row-pill ebm-row-pill-risk';
                p.textContent = String(r.risk);
                pills.appendChild(p);
            }
            if (r.warn > 0) {
                const p = document.createElement('span');
                p.className = 'ebm-row-pill ebm-row-pill-warn';
                p.textContent = String(r.warn);
                pills.appendChild(p);
            }
            row.appendChild(pills);
            list.appendChild(row);
        }
        return list;
    }

    private _renderFooter(id: EcoBoxId): HTMLElement|null {
        /*
         * Only the project-list boxes have a meaningful jump target —
         * the cross-project Matrix is where the user can dig into
         * the projects further (workspaces, deps, scanner badges).
         */
        if (id !== 'projects' && id !== 'healthy-projects' && id !== 'at-risk-projects') {
            return null;
        }
        const footer = document.createElement('div');
        footer.className = 'ebm-footer';
        const btn = document.createElement('button');
        btn.className = 'umd-btn umd-btn-primary';
        btn.textContent = I18n.t('Open in Matrix');
        btn.addEventListener('click', () => {
            this.close();
            this._onNavigate?.('matrix');
        });
        footer.appendChild(btn);
        return footer;
    }

    /**
     * Short paragraph explaining what the box measures and when
     * the user should care. Kept terse — the details below carry
     * the actual data.
     */
    private static _describe(id: EcoBoxId): string {
        switch (id) {
            case 'projects':
                return I18n.t('Every project nppm currently scans. The list shows each project\'s average score across all non-N/A scanner cells, worst first.');
            case 'ecosystem-health':
                return I18n.t('Average score across every project and every scanner. The list breaks that average down per scanner so you can spot which dimension is dragging the ecosystem down.');
            case 'healthy-projects':
                return I18n.t('Projects whose average scanner score is 80 or above — solid green ring in the treeview. Click to open one.');
            case 'info-findings':
                return I18n.t('Lowest-severity findings (info) across all projects and scanners. These rarely block anything but they\'re the early-warning layer — drift here often precedes warn / risk later.');
            case 'risk-findings':
                return I18n.t('Highest-severity findings across all projects and scanners. The breakdown shows which scanner produced how many — the top entries are usually the ones to fix first.');
            case 'cve-flags':
                return I18n.t('Packages whose installed version has known CVE entries on OSV.dev. Each row lists the packages with the project(s) it appears in.');
            case 'deprecated':
                return I18n.t('Packages whose installed or latest published version carries a deprecation marker on the npm registry. Risk-level entries are the urgent ones (the version you ship today is deprecated).');
            case 'at-risk-projects':
                return I18n.t('Projects whose average scanner score is below 60 — red ring in the treeview. Click to open one.');
            case 'maintainer-alerts':
                return I18n.t('Packages with maintainer-handover or 2FA-status patterns matching the event-stream / ua-parser-js incident profiles. Each row shows the project(s) affected.');
            case 'typosquat-hits':
                return I18n.t('Package names a Levenshtein distance of 1-2 from a popular package, or carrying confusable (non-ASCII) characters. Most matches are intentional namesakes; the rows surface the suspicious ones.');
            default:
                return '';
        }
    }

    private static _scoreClass(avg: number): string {
        if (avg >= 80) {
            return 'ebm-row-score-good';
        }
        if (avg >= 60) {
            return 'ebm-row-score-warn';
        }
        return 'ebm-row-score-risk';
    }

}