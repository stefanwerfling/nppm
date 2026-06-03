import {CellFinding, DashboardCell, ScannerId} from '../Dashboard/DashboardBuilder.js';
import {I18n} from './I18n.js';

/**
 * Optional drill-down handler — invoked when the user clicks the
 * "Open in <view>" button at the bottom of the modal. Wired from
 * `Nppm` per project (CVE / Integrity / Unused / Template each route
 * to their own per-project view).
 */
export type FindingsDrillHandler = (projectUnid: string, scanner: ScannerId) => void;

/**
 * Click handler for an individual finding row. Wired by `Nppm` for
 * scanners whose label is a `name@version` coordinate that maps
 * cleanly onto the PackageDetailPanel — the user gets a one-click
 * jump from the modal's row list into the per-package details
 * (currently used for the external-sources scanner; the Security
 * tab already renders the per-source breakdown the modal can't show
 * inline).
 */
export type FindingsRowClickHandler = (name: string, version: string) => void;

/**
 * Generic findings modal — opened on Dashboard cell click. Shows the
 * scanner label + project name + score + severity counts + the
 * top-N findings carried in the cell payload, sorted risk → warn →
 * info. For scanners that have a dedicated drill-down view (CVE /
 * Integrity / Unused / Template), surfaces a one-click jump button
 * at the bottom; the handler is provided by `Nppm`.
 *
 * Modeled on the ImpactModal / WhyModal lifecycle (Esc + backdrop
 * click close, single instance at a time, no SSE state).
 */
export class FindingsModal {

    private _backdrop: HTMLElement|null = null;
    private _onDrill: FindingsDrillHandler|null = null;
    private _onRowClick: FindingsRowClickHandler|null = null;

    public onDrill(handler: FindingsDrillHandler): void {
        this._onDrill = handler;
    }

    public onRowClick(handler: FindingsRowClickHandler): void {
        this._onRowClick = handler;
    }

    public open(
        scanner: ScannerId,
        scannerLabel: string,
        projectUnid: string,
        projectName: string,
        cell: DashboardCell
    ): void {
        this._mount(scanner, scannerLabel, projectUnid, projectName, cell);
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

    private _mount(
        scanner: ScannerId,
        scannerLabel: string,
        projectUnid: string,
        projectName: string,
        cell: DashboardCell
    ): void {
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
        panel.className = 'umd-panel fmd-panel';
        backdrop.appendChild(panel);

        panel.appendChild(this._renderHeader(scannerLabel, projectName));
        panel.appendChild(this._renderSummary(cell));
        panel.appendChild(this._renderList(cell.findings, cell, scanner));

        const drillBtn = FindingsModal._drillScanner(scanner);
        if (drillBtn && this._onDrill) {
            panel.appendChild(this._renderDrillFooter(scanner, projectUnid, drillBtn));
        }

        document.addEventListener('keydown', this._onKeyDown);
    }

    private _renderHeader(scannerLabel: string, projectName: string): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = `${scannerLabel} — ${projectName}`;
        head.appendChild(title);
        const close = document.createElement('button');
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    private _renderSummary(cell: DashboardCell): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'fmd-summary';

        const scoreBadge = document.createElement('span');
        scoreBadge.className = 'fmd-score';
        if (cell.score === null) {
            scoreBadge.classList.add('fmd-score-na');
            scoreBadge.textContent = I18n.t('N/A');
        } else {
            const tier = cell.score >= 80 ? 'good' : cell.score >= 60 ? 'warn' : 'risk';
            scoreBadge.classList.add(`fmd-score-${tier}`);
            scoreBadge.textContent = `${cell.score}%`;
        }
        wrap.appendChild(scoreBadge);

        const counts = document.createElement('span');
        counts.className = 'fmd-counts';
        const parts: string[] = [];
        if (cell.counts.risk > 0) {
            parts.push(`${cell.counts.risk} risk`);
        }
        if (cell.counts.warn > 0) {
            parts.push(`${cell.counts.warn} warn`);
        }
        if (cell.counts.info > 0) {
            parts.push(`${cell.counts.info} info`);
        }
        if (cell.total > 0) {
            parts.push(I18n.t('over {n} packages', {n: String(cell.total)}));
        }
        counts.textContent = parts.length > 0 ? parts.join(' · ') : I18n.t('nothing flagged');
        wrap.appendChild(counts);

        if (cell.note) {
            const note = document.createElement('div');
            note.className = 'fmd-note';
            note.textContent = cell.note;
            wrap.appendChild(note);
        }
        return wrap;
    }

    private _renderList(findings: CellFinding[], cell: DashboardCell, scanner: ScannerId): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'fmd-list-wrap';

        if (findings.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'fmd-empty';
            empty.textContent = cell.score === null
                ? I18n.t('Scanner did not run.')
                : I18n.t('Nothing flagged in this project.');
            wrap.appendChild(empty);
            return wrap;
        }

        const totalFlagged = cell.counts.risk + cell.counts.warn + cell.counts.info;
        if (findings.length < totalFlagged) {
            const cap = document.createElement('div');
            cap.className = 'fmd-cap-hint';
            cap.textContent = I18n.t('Showing top {n} of {total} findings (severity desc).',
                {n: String(findings.length), total: String(totalFlagged)});
            wrap.appendChild(cap);
        }

        // Scanners whose findings are keyed by `name@version` (every
        // per-package one) get clickable rows that jump straight into
        // the PackageDetailPanel — the modal lists the *which*, the
        // detail panel shows the *what*. External is the explicit
        // motivator: each row's detail is just "N source(s)", so the
        // user needs to drill in to see what socket/OpenSSF/deps.dev
        // actually returned.
        const rowsClickable = FindingsModal._rowsAreClickable(scanner) && this._onRowClick !== null;

        const list = document.createElement('div');
        list.className = 'fmd-list';
        for (const f of findings) {
            const row = document.createElement('div');
            row.className = 'fmd-row';

            const sev = document.createElement('span');
            sev.className = `fmd-sev fmd-sev-${f.severity}`;
            sev.textContent = f.severity;
            row.appendChild(sev);

            const label = document.createElement('span');
            label.className = 'fmd-label';
            label.textContent = f.label;
            row.appendChild(label);

            if (f.detail) {
                const detail = document.createElement('span');
                detail.className = 'fmd-detail';
                detail.textContent = f.detail;
                row.appendChild(detail);
            }

            if (rowsClickable) {
                const parsed = FindingsModal._parseLabel(f.label);
                if (parsed) {
                    row.classList.add('fmd-row-clickable');
                    row.title = I18n.t('Open package details');
                    row.addEventListener('click', () => {
                        this._onRowClick?.(parsed.name, parsed.version);
                        this.close();
                    });
                }
            }
            list.appendChild(row);
        }
        wrap.appendChild(list);
        return wrap;
    }

    /**
     * Whether finding rows for `scanner` carry a `name@version`
     * label that the PackageDetailPanel can resolve. Per-project
     * scanners (unused/template) use a different label shape and
     * stay non-clickable.
     */
    private static _rowsAreClickable(scanner: ScannerId): boolean {
        switch (scanner) {
            case 'cve':
            case 'license':
            case 'scripts':
            case 'patterns':
            case 'binaries':
            case 'maintainer':
            case 'churn':
            case 'cadence':
            case 'freshness':
            case 'ignoreScripts':
            case 'typosquat':
            case 'provenance':
            case 'external':
            case 'deprecation':
            case 'integrity':
                return true;
            case 'unused':
            case 'template':
                return false;
        }
    }

    /**
     * Split a `name@version` label back into its pieces. Scoped names
     * (`@scope/pkg@1.2.3`) split on the *last* `@` — `name` keeps the
     * leading `@scope/`. Returns `null` for labels that don't carry
     * a version at all.
     */
    private static _parseLabel(label: string): {name: string; version: string}|null {
        const at = label.lastIndexOf('@');
        if (at <= 0) {
            return null;
        }
        const name = label.slice(0, at);
        const version = label.slice(at + 1);
        if (!name || !version) {
            return null;
        }
        return {name, version};
    }

    private _renderDrillFooter(scanner: ScannerId, projectUnid: string, viewLabel: string): HTMLElement {
        const foot = document.createElement('div');
        foot.className = 'fmd-foot';
        const btn = document.createElement('button');
        btn.className = 'umd-btn umd-btn-primary';
        btn.textContent = I18n.t('Open in {view}', {view: viewLabel});
        btn.addEventListener('click', () => {
            this._onDrill?.(projectUnid, scanner);
            this.close();
        });
        foot.appendChild(btn);
        return foot;
    }

    /**
     * Drill-down target name for the scanners that own a dedicated
     * view. Returning `null` hides the footer button — the modal then
     * stands alone (the findings list is the full answer).
     */
    private static _drillScanner(scanner: ScannerId): string|null {
        switch (scanner) {
            case 'cve':
            case 'integrity':
                return I18n.t('Installed view');
            case 'unused': return I18n.t('Unused view');
            case 'template': return I18n.t('Template view');
            default: return null;
        }
    }
}