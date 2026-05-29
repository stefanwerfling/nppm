import {ApiBulkUpgradePick} from '../Api/ApiTypes.js';
import {ConfigProjectType} from '../Config/Config.js';
import {DependencyType} from '../Project/PackageManifest.js';
import {MatrixResponse, MatrixRow, MatrixRowStatus} from '../Matrix/MatrixBuilder.js';
import {BinarySeverity, BinarySummary} from '../Security/BinaryScanner.js';
import {LicenseSeverity, LicenseSummary} from '../Security/LicenseScanner.js';
import {MaintainerSeverity, MaintainerSummary} from '../Security/MaintainerScanner.js';
import {PatternSeverity} from '../Security/PatternScanner.js';
import {ScriptSeverity} from '../Security/ScriptScanner.js';
import {PatternSummary, ScriptSummary} from '../Security/SecurityScanner.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';
import {Version} from './Version.js';

/**
 * Filter mode buttons above the matrix.
 *  - all: every row
 *  - drift: only rows where projects disagree
 *  - outdated: only rows behind registry latest
 *  - issues: drift ∪ outdated (everything that needs attention)
 *  - insecure: any row with CVE or risky install script
 */
export enum MatrixFilter {
    all = 'all',
    drift = 'drift',
    outdated = 'outdated',
    issues = 'issues',
    insecure = 'insecure',
    /**
     * Compliance filter: shows rows whose latest version's license is
     * problematic for typical commercial use — strong copyleft (GPL/
     * AGPL), proprietary, or unknown. Permissive + weak-copyleft are
     * hidden because legal teams usually pre-approve those buckets.
     */
    licenseIssue = 'license-issue'
}

/**
 * Row sort modes. `name` (default) is plain alphabetic. `status` puts
 * the most urgent rows at the top: drift > outdated > unknown > aligned,
 * with name as the tie-breaker. `severity` ranks by the aggregated
 * security score (CVE count + script severity) so the riskiest
 * packages float up regardless of drift state.
 */
export enum MatrixSort {
    name = 'name',
    status = 'status',
    severity = 'severity'
}

const STATUS_RANK: Record<MatrixRowStatus, number> = {
    [MatrixRowStatus.drift]: 0,
    [MatrixRowStatus.outdated]: 1,
    [MatrixRowStatus.unknown]: 2,
    [MatrixRowStatus.aligned]: 3
};

/**
 * Per-severity weight tables consumed by `Matrix._severityScore`.
 * Module-level for cheap-and-shared access; the score function lives
 * as a private static on the `Matrix` class.
 */
const SCRIPT_WEIGHT: Record<ScriptSeverity, number> = {
    [ScriptSeverity.info]: 1,
    [ScriptSeverity.warn]: 5,
    [ScriptSeverity.risk]: 20
};

const PATTERN_WEIGHT: Record<PatternSeverity, number> = {
    [PatternSeverity.info]: 1,
    [PatternSeverity.warn]: 3,
    [PatternSeverity.risk]: 15
};

const BINARY_WEIGHT: Record<BinarySeverity, number> = {
    [BinarySeverity.info]: 1,
    [BinarySeverity.warn]: 5,
    [BinarySeverity.risk]: 20
};

const MAINTAINER_WEIGHT: Record<MaintainerSeverity, number> = {
    [MaintainerSeverity.info]: 0,
    [MaintainerSeverity.warn]: 5,
    [MaintainerSeverity.risk]: 25
};

/**
 * Persisted UI state — keeps filter, sort, and search across reloads
 * via localStorage. Stored as one JSON blob so we can extend later
 * without touching every reader.
 */
const STATE_STORAGE_KEY = 'nppm.matrix.state.v1';

type StoredMatrixState = {
    filter?: MatrixFilter;
    sort?: MatrixSort;
    search?: string;
};

/**
 * Renders the cross-project dependency grid. Rows = packages, columns
 * = configured projects + a trailing "Latest" column from the
 * registry.
 */
export class Matrix {

    private readonly _root: HTMLElement;
    private _data: MatrixResponse|null = null;
    private _filter: MatrixFilter = MatrixFilter.all;
    private _sort: MatrixSort = MatrixSort.name;
    private _search: string = '';
    private _onProjectClick: ((unid: string) => void)|null = null;
    private _onCellClick: ((pkg: string, version: string, latest: string|null) => void)|null = null;
    private _onSecurityClick: ((pkg: string, version: string) => void)|null = null;
    private _onBulkUpgradeClick: ((picks: ApiBulkUpgradePick[]) => void)|null = null;
    // Multi-select state for the cross-project Bulk-Upgrade Wizard.
    // Keyed by `${unid}|${pkg}` — workspace is always root in the global
    // matrix (cells aggregate workspaces), so the key collapses to that
    // pair. Cleared on `setData`.
    private _selected: Map<string, ApiBulkUpgradePick> = new Map();
    // Cached batched vuln lookups, keyed by package name (we always
    // batch against `latest`, so the version is implicit). `null` means
    // OSV failed for that package; `[]` means "asked, no vulns".
    private _vulnsByName: Map<string, string[]|null> = new Map();
    // Cached script summaries, same keying as `_vulnsByName`. Populated
    // by the (slow on cold start) /api/matrix/heuristics endpoint.
    private _scriptsByName: Map<string, ScriptSummary> = new Map();
    private _patternsByName: Map<string, PatternSummary> = new Map();
    private _binariesByName: Map<string, BinarySummary> = new Map();
    private _maintainersByName: Map<string, MaintainerSummary> = new Map();
    private _licensesByName: Map<string, LicenseSummary> = new Map();
    // Generation counter so a late security response from a previous
    // `setData` call cannot overwrite a newer matrix.
    private _securityGen: number = 0;

    constructor(root: HTMLElement) {
        this._root = root;

        const state = Matrix._loadState();
        if (state.filter) {
            this._filter = state.filter;
        }
        if (state.sort) {
            this._sort = state.sort;
        }
        if (typeof state.search === 'string') {
            this._search = state.search;
        }
    }

    private _persist(): void {
        Matrix._saveState({filter: this._filter, sort: this._sort, search: this._search});
    }

    private static _loadState(): StoredMatrixState {
        try {
            const raw = localStorage.getItem(STATE_STORAGE_KEY);
            return raw ? JSON.parse(raw) as StoredMatrixState : {};
        } catch {
            return {};
        }
    }

    private static _saveState(state: StoredMatrixState): void {
        try {
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
        } catch {
            // localStorage may be disabled (private mode etc) — best effort.
        }
    }

    /**
     * Weighted aggregate of CVE + heuristic severities. Higher =
     * worse. Designed so one CVE outweighs a benign-but-present
     * prepare-script (10 vs 1) and a single risky postinstall outweighs
     * a CVE (20 vs 10). Score is computed against whatever heuristic
     * data has arrived; absent pieces contribute 0 — the badge
     * progressively gets more accurate as the lazy batch endpoints
     * settle.
     */
    private static _severityScore(
        vulnIds: string[]|null|undefined,
        scripts: ScriptSummary|undefined,
        patterns: PatternSummary|undefined,
        binaries: BinarySummary|undefined,
        maintainer: MaintainerSummary|undefined
    ): number {
        let score = 0;
        if (vulnIds && vulnIds.length > 0) {
            score += vulnIds.length * 10;
        }
        if (scripts && scripts.maxSeverity !== null) {
            score += SCRIPT_WEIGHT[scripts.maxSeverity];
        }
        if (patterns && patterns.maxSeverity !== null) {
            // count multiplied by per-finding weight, capped at one
            // full "risk hit" — otherwise a noisy library (50
            // child_process refs) dominates the sort and drowns out
            // the true outliers.
            const perWeight = PATTERN_WEIGHT[patterns.maxSeverity];
            score += Math.min(patterns.count, 5) * perWeight;
        }
        if (binaries && binaries.maxSeverity !== null) {
            score += BINARY_WEIGHT[binaries.maxSeverity];
        }
        if (maintainer && maintainer.severity !== null) {
            score += MAINTAINER_WEIGHT[maintainer.severity];
        }
        return score;
    }

    public onProjectClick(handler: (unid: string) => void): void {
        this._onProjectClick = handler;
    }

    public onCellClick(handler: (pkg: string, version: string, latest: string|null) => void): void {
        this._onCellClick = handler;
    }

    public onSecurityClick(handler: (pkg: string, version: string) => void): void {
        this._onSecurityClick = handler;
    }

    public onBulkUpgradeClick(handler: (picks: ApiBulkUpgradePick[]) => void): void {
        this._onBulkUpgradeClick = handler;
    }

    public renderLoading(): void {
        this._root.innerHTML = `<div class="list-placeholder">${I18n.t('Loading matrix …')}</div>`;
    }

    public renderError(msg: string): void {
        this._root.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'list-error';
        err.textContent = msg;
        this._root.appendChild(err);
    }

    public setData(data: MatrixResponse): void {
        this._data = data;
        this._selected = new Map();
        this._vulnsByName = new Map();
        this._scriptsByName = new Map();
        this._patternsByName = new Map();
        this._binariesByName = new Map();
        this._maintainersByName = new Map();
        this._licensesByName = new Map();
        this._render();

        const gen = ++this._securityGen;
        const packages: {name: string; version: string}[] = [];
        for (const row of data.rows) {
            if (row.latest) {
                packages.push({name: row.name, version: Version.cleanRange(row.latest)});
            }
        }

        // CVE lookup is fast (OSV batch); the fingerprint-derived
        // heuristics (scripts + patterns) are slow on cold start
        // (tarball downloads). Fire both in parallel — whichever
        // returns first repaints, the other follows.
        void this._loadVulnBadges(gen, packages);
        void this._loadHeuristicBadges(gen, packages);
    }

    private async _loadVulnBadges(gen: number, packages: {name: string; version: string}[]): Promise<void> {
        if (packages.length === 0) {
            return;
        }

        try {
            const response = await Api.matrixSecurity(packages);

            if (gen !== this._securityGen) {
                return;
            }

            let anyHit = false;
            for (const entry of response.results) {
                this._vulnsByName.set(entry.name, entry.vulnIds);
                if (entry.vulnIds && entry.vulnIds.length > 0) {
                    anyHit = true;
                }
            }

            if (anyHit) {
                this._rerenderTable();
            }
        } catch {
            // Best-effort: silent on failure (detail panel still has it).
        }
    }

    private async _loadHeuristicBadges(gen: number, packages: {name: string; version: string}[]): Promise<void> {
        if (packages.length === 0) {
            return;
        }

        try {
            const response = await Api.matrixHeuristics(packages);

            if (gen !== this._securityGen) {
                return;
            }

            let anyHit = false;
            for (const entry of response.results) {
                this._scriptsByName.set(entry.name, entry.scripts);
                this._patternsByName.set(entry.name, entry.patterns);
                this._binariesByName.set(entry.name, entry.binaries);
                this._maintainersByName.set(entry.name, entry.maintainer);
                this._licensesByName.set(entry.name, entry.license);
                if (entry.scripts.maxSeverity !== null
                    || entry.patterns.maxSeverity !== null
                    || entry.binaries.maxSeverity !== null
                    || (entry.maintainer.severity !== null
                        && entry.maintainer.severity !== MaintainerSeverity.info)
                    || Matrix._isLicenseNotable(entry.license.severity)) {
                    anyHit = true;
                }
            }

            if (anyHit) {
                this._rerenderTable();
            }
        } catch {
            // Best-effort: silent on failure.
        }
    }

    private _render(): void {
        if (!this._data) {
            return;
        }

        this._root.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'matrix-header';
        header.appendChild(this._renderFilters());
        header.appendChild(this._renderStats());
        this._root.appendChild(header);

        const tableWrap = document.createElement('div');
        tableWrap.className = 'matrix-wrap';
        tableWrap.appendChild(this._renderTable());
        this._root.appendChild(tableWrap);

        this._root.appendChild(this._renderBulkFooter());
    }

    private _renderFilters(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'matrix-filters';

        const opts: {value: MatrixFilter; label: string}[] = [
            {value: MatrixFilter.all, label: I18n.t('All')},
            {value: MatrixFilter.issues, label: I18n.t('Issues')},
            {value: MatrixFilter.drift, label: I18n.t('Drift')},
            {value: MatrixFilter.outdated, label: I18n.t('Outdated')},
            {value: MatrixFilter.insecure, label: I18n.t('Unsafe')},
            {value: MatrixFilter.licenseIssue, label: I18n.t('Licenses')}
        ];

        for (const opt of opts) {
            const btn = document.createElement('button');
            btn.className = 'matrix-filter-btn';
            if (this._filter === opt.value) {
                btn.classList.add('matrix-filter-btn-active');
            }
            btn.textContent = opt.label;
            btn.addEventListener('click', () => {
                this._filter = opt.value;
                this._persist();
                this._render();
            });
            bar.appendChild(btn);
        }

        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'matrix-search';
        search.placeholder = I18n.t('Search package …');
        search.value = this._search;
        // Re-render on each keystroke. The dataset is small (≤ a few
        // hundred rows) and re-rendering also re-applies the filter +
        // sort, so this stays consistent without extra plumbing.
        search.addEventListener('input', () => {
            this._search = search.value;
            this._persist();
            this._rerenderTable();
        });
        bar.appendChild(search);

        const sortLabel = document.createElement('span');
        sortLabel.className = 'matrix-sort-label';
        sortLabel.textContent = I18n.t('Sort:');
        bar.appendChild(sortLabel);

        const sorts: {value: MatrixSort; label: string}[] = [
            {value: MatrixSort.name, label: I18n.t('Name')},
            {value: MatrixSort.status, label: I18n.t('Status')},
            {value: MatrixSort.severity, label: I18n.t('Severity')}
        ];

        for (const s of sorts) {
            const btn = document.createElement('button');
            btn.className = 'matrix-sort-btn';
            if (this._sort === s.value) {
                btn.classList.add('matrix-sort-btn-active');
            }
            btn.textContent = s.label;
            btn.addEventListener('click', () => {
                this._sort = s.value;
                this._persist();
                this._render();
            });
            bar.appendChild(btn);
        }

        return bar;
    }

    /**
     * Re-render only the table region — used on each keystroke in the
     * search input so we don't blow away the input element (and thus
     * the focus + caret position) on every character.
     */
    private _rerenderTable(): void {
        const wrap = this._root.querySelector('.matrix-wrap');

        if (!wrap) {
            this._render();
            return;
        }

        wrap.innerHTML = '';
        wrap.appendChild(this._renderTable());
    }

    private _renderStats(): HTMLElement {
        const stats = document.createElement('div');
        stats.className = 'matrix-stats';

        if (!this._data) {
            return stats;
        }

        const counts = {
            aligned: 0,
            outdated: 0,
            drift: 0,
            unknown: 0
        };

        for (const row of this._data.rows) {
            counts[row.status]++;
        }

        stats.innerHTML = `
            <span class="matrix-stat matrix-stat-aligned">${counts.aligned} aligned</span>
            <span class="matrix-stat matrix-stat-outdated">${counts.outdated} outdated</span>
            <span class="matrix-stat matrix-stat-drift">${counts.drift} drift</span>
            <span class="matrix-stat matrix-stat-unknown">${counts.unknown} unknown</span>
        `;

        return stats;
    }

    private _renderTable(): HTMLElement {
        const table = document.createElement('table');
        table.className = 'matrix-table';

        // -- header row --------------------------------------------
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');

        trHead.appendChild(Matrix._th(I18n.t('Package'), 'matrix-th-name'));

        for (const project of this._data!.projects) {
            const th = Matrix._th(project.name, 'matrix-th-project');
            th.title = project.error ?? '';
            th.addEventListener('click', () => this._onProjectClick?.(project.unid));
            trHead.appendChild(th);
        }

        trHead.appendChild(Matrix._th(I18n.t('Latest'), 'matrix-th-latest'));
        thead.appendChild(trHead);
        table.appendChild(thead);

        // -- body --------------------------------------------------
        const tbody = document.createElement('tbody');
        const visibleRows = this._sortRows(this._data!.rows.filter((r) => this._isVisible(r)));

        if (visibleRows.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = this._data!.projects.length + 2;
            td.className = 'matrix-empty';
            td.textContent = I18n.t('No matches for this filter.');
            tr.appendChild(td);
            tbody.appendChild(tr);
        } else {
            for (const row of visibleRows) {
                tbody.appendChild(this._renderRow(row));
            }
        }

        table.appendChild(tbody);
        return table;
    }

    private _renderRow(row: MatrixRow): HTMLElement {
        const tr = document.createElement('tr');
        tr.className = `matrix-row matrix-row-${row.status}`;

        const nameCell = document.createElement('td');
        nameCell.className = 'matrix-cell-name';

        const nameText = document.createElement('span');
        nameText.textContent = row.name;
        nameCell.appendChild(nameText);

        const vulnIds = this._vulnsByName.get(row.name);
        if (vulnIds && vulnIds.length > 0) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-cve';
            badge.textContent = `CVE ${vulnIds.length}`;
            badge.title = vulnIds.join('\n');
            // Clicking the badge opens the detail panel on the latest
            // version so the user lands on the security tab they care
            // about. We piggy-back on the existing cell-click contract.
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        const scripts = this._scriptsByName.get(row.name);
        if (scripts && scripts.maxSeverity !== null) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-script matrix-badge-script-${scripts.maxSeverity}`;
            badge.textContent = Matrix._scriptBadgeLabel(scripts.maxSeverity);
            badge.title = I18n.t('{count} install hook(s) — severity {severity}', {count: scripts.count, severity: scripts.maxSeverity});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Pattern badge only for the loudest signal (`risk` = eval/
        // Function call) — `warn` patterns like `child_process` are
        // legitimate in dozens of libraries and would clutter every row.
        const patterns = this._patternsByName.get(row.name);
        if (patterns && patterns.maxSeverity === PatternSeverity.risk) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-pattern';
            badge.textContent = `EVAL ${patterns.count}`;
            badge.title = I18n.t('{count} dynamic code executions in tarball', {count: patterns.count});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Binary badge only for risk-tier — `.node`/`.wasm` (warn/info)
        // are routine in many native-binding packages and would
        // clutter every row otherwise.
        const binaries = this._binariesByName.get(row.name);
        if (binaries && binaries.maxSeverity === BinarySeverity.risk) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-binary';
            badge.textContent = `BIN ${binaries.riskCount}`;
            badge.title = I18n.t('{count} native binary file(s) (.exe/.dll/.so/…) in tarball', {count: binaries.riskCount});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Maintainer badge only for risk-tier — first-time publishers
        // alone (`warn`) are common when a project moves to CI; we'd
        // train the user to ignore the badge.
        const maintainer = this._maintainersByName.get(row.name);
        if (maintainer && maintainer.severity === MaintainerSeverity.risk) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-maintainer';
            badge.textContent = 'OWNER!';
            badge.title = I18n.t('New publisher ({publisher}) after long silence — possible account takeover', {publisher: maintainer.publisher ?? '?'});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // License badge only for strong-copyleft and proprietary —
        // weak-copyleft is too noisy (legal teams pre-approve LGPL /
        // MPL in most shops). `unknown` packages get a smaller grey
        // badge so they're noticeable without screaming.
        const license = this._licensesByName.get(row.name);
        if (license) {
            const badge = Matrix._licenseBadge(license);
            if (badge) {
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (row.latest) {
                        this._onSecurityClick?.(row.name, row.latest);
                    }
                });
                nameCell.appendChild(badge);
            }
        }

        tr.appendChild(nameCell);

        for (const project of this._data!.projects) {
            const cellData = row.cells[project.unid];
            const td = document.createElement('td');
            td.className = 'matrix-cell';

            if (!cellData) {
                td.classList.add('matrix-cell-missing');
                td.textContent = '—';
            } else {
                td.classList.add(`matrix-cell-${row.status}`);
                td.classList.add('matrix-cell-clickable');
                td.addEventListener('click', () => {
                    this._onCellClick?.(row.name, cellData.version, row.latest);
                });

                // Bulk-Upgrade checkbox: only for outdated rows on
                // local projects with a known registry `latest` and a
                // non-git installation. Click is stopped so it doesn't
                // also open the detail panel.
                if (
                    row.status === MatrixRowStatus.outdated
                    && row.latest
                    && !cellData.installedVersion
                    && project.type === ConfigProjectType.local
                ) {
                    const key = Matrix._pickKey(project.unid, row.name);
                    const check = document.createElement('input');
                    check.type = 'checkbox';
                    check.className = 'matrix-cell-check';
                    check.checked = this._selected.has(key);
                    check.title = I18n.t('Add to Bulk Update');
                    check.addEventListener('click', (e) => e.stopPropagation());
                    check.addEventListener('change', () => {
                        if (check.checked) {
                            this._selected.set(key, {
                                projectUnid: project.unid,
                                workspace: '',
                                name: row.name,
                                depType: Matrix._toApiDepType(cellData.types[0]),
                                fromRange: cellData.version,
                                toRange: `^${row.latest}`
                            });
                        } else {
                            this._selected.delete(key);
                        }
                        this._refreshBulkFooter();
                    });
                    td.appendChild(check);
                }

                const v = document.createElement('span');
                v.className = 'matrix-cell-version';
                if (cellData.installedVersion) {
                    // Git-pinned cell: show the *installed* version
                    // primary, raw URL as tooltip. The clicked
                    // `version` is still the git URL so the detail
                    // panel can resolve the tarball.
                    v.textContent = cellData.installedVersion;
                    v.title = cellData.version;
                    const gitTag = document.createElement('span');
                    gitTag.className = 'matrix-cell-git';
                    gitTag.textContent = 'git';
                    gitTag.title = cellData.version;
                    td.appendChild(v);
                    td.appendChild(gitTag);
                } else {
                    v.textContent = cellData.version;
                    td.appendChild(v);
                }

                if (cellData.internalDrift) {
                    const badge = document.createElement('span');
                    badge.className = 'matrix-badge matrix-badge-drift';
                    badge.title = I18n.t('Workspaces of this project declared different versions');
                    badge.textContent = 'WS';
                    td.appendChild(badge);
                }

                const types = cellData.types
                    .filter((t) => t !== DependencyType.dependency)
                    .map(Matrix._depLabel)
                    .join('/');

                if (types) {
                    const tag = document.createElement('span');
                    tag.className = 'matrix-cell-type';
                    tag.textContent = types;
                    td.appendChild(tag);
                }
            }

            tr.appendChild(td);
        }

        const latestTd = document.createElement('td');
        latestTd.className = 'matrix-cell-latest';
        latestTd.textContent = row.latest ?? '?';
        tr.appendChild(latestTd);

        return tr;
    }

    private _scoreFor(row: MatrixRow): number {
        return Matrix._severityScore(
            this._vulnsByName.get(row.name),
            this._scriptsByName.get(row.name),
            this._patternsByName.get(row.name),
            this._binariesByName.get(row.name),
            this._maintainersByName.get(row.name)
        );
    }

    private _isVisible(row: MatrixRow): boolean {
        const needle = this._search.trim().toLowerCase();
        if (needle && !row.name.toLowerCase().includes(needle)) {
            return false;
        }

        switch (this._filter) {
            case MatrixFilter.all:
                return true;
            case MatrixFilter.drift:
                return row.status === MatrixRowStatus.drift;
            case MatrixFilter.outdated:
                return row.status === MatrixRowStatus.outdated;
            case MatrixFilter.issues:
                return row.status === MatrixRowStatus.drift
                    || row.status === MatrixRowStatus.outdated;
            case MatrixFilter.insecure:
                return this._scoreFor(row) > 0;
            case MatrixFilter.licenseIssue: {
                const lic = this._licensesByName.get(row.name);
                return lic !== undefined && Matrix._isLicenseNotable(lic.severity);
            }
        }
    }

    /**
     * Sort by name (alphabetic), status rank, or aggregated severity
     * score. Backend already delivers rows sorted by name, so the
     * `name` case is a no-op clone but kept explicit for clarity.
     */
    private _sortRows(rows: MatrixRow[]): MatrixRow[] {
        const copy = [...rows];

        if (this._sort === MatrixSort.status) {
            copy.sort((a, b) => {
                const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
                return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name);
            });
        } else if (this._sort === MatrixSort.severity) {
            copy.sort((a, b) => {
                const diff = this._scoreFor(b) - this._scoreFor(a);
                return diff !== 0 ? diff : a.name.localeCompare(b.name);
            });
        } else {
            copy.sort((a, b) => a.name.localeCompare(b.name));
        }

        return copy;
    }

    /**
     * Sticky footer that surfaces the Bulk-Upgrade selection state
     * and the "Update selected" trigger. Hidden (display:none via
     * `matrix-footer-empty`) until the first checkbox is ticked —
     * otherwise it would overlap the last matrix row in the default
     * "All" view without offering anything to act on.
     */
    private _renderBulkFooter(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'matrix-footer';

        const count = document.createElement('span');
        count.className = 'matrix-footer-count';
        bar.appendChild(count);

        const clear = document.createElement('button');
        clear.className = 'matrix-footer-clear';
        clear.textContent = I18n.t('Clear selection');
        clear.addEventListener('click', () => {
            this._selected.clear();
            this._rerenderTable();
            this._refreshBulkFooter();
        });
        bar.appendChild(clear);

        const apply = document.createElement('button');
        apply.className = 'matrix-footer-apply';
        apply.textContent = I18n.t('Update selected');
        apply.addEventListener('click', () => {
            if (this._selected.size === 0) {
                return;
            }
            this._onBulkUpgradeClick?.(Array.from(this._selected.values()));
        });
        bar.appendChild(apply);

        Matrix._fillBulkFooter(bar, this._selected.size);
        return bar;
    }

    /**
     * In-place update of the sticky footer's count and disabled state
     * — avoids tearing down + re-rendering the whole table on every
     * checkbox toggle.
     */
    private _refreshBulkFooter(): void {
        const bar = this._root.querySelector<HTMLElement>('.matrix-footer');
        if (!bar) {
            return;
        }
        Matrix._fillBulkFooter(bar, this._selected.size);
    }

    private static _fillBulkFooter(bar: HTMLElement, n: number): void {
        const count = bar.querySelector<HTMLElement>('.matrix-footer-count');
        const apply = bar.querySelector<HTMLButtonElement>('.matrix-footer-apply');
        const clear = bar.querySelector<HTMLButtonElement>('.matrix-footer-clear');
        if (count) {
            count.textContent = I18n.t('{n} selected', {n});
        }
        if (apply) {
            apply.disabled = n === 0;
        }
        if (clear) {
            clear.disabled = n === 0;
        }
        bar.classList.toggle('matrix-footer-empty', n === 0);
    }

    private static _pickKey(projectUnid: string, name: string): string {
        return `${projectUnid}|${name}`;
    }

    /**
     * `DependencyType` (string enum) → the literal union the Upgrade
     * API request expects. Identity at runtime; the cast keeps the
     * static types narrow for the route handler.
     */
    private static _toApiDepType(t: DependencyType): 'dependency'|'dev'|'peer'|'optional' {
        return t as unknown as 'dependency'|'dev'|'peer'|'optional';
    }

    private static _th(label: string, cls: string): HTMLElement {
        const th = document.createElement('th');
        th.className = cls;
        th.textContent = label;
        return th;
    }

    private static _isLicenseNotable(s: LicenseSeverity): boolean {
        return s === LicenseSeverity.strongCopyleft
            || s === LicenseSeverity.proprietary
            || s === LicenseSeverity.unknown;
    }

    private static _licenseBadge(summary: LicenseSummary): HTMLElement|null {
        const sev = summary.severity;
        let label: string;
        let cls: string;

        switch (sev) {
            case LicenseSeverity.strongCopyleft:
                label = 'GPL';
                cls = 'matrix-badge-license-strong';
                break;
            case LicenseSeverity.proprietary:
                label = 'UNLIC';
                cls = 'matrix-badge-license-proprietary';
                break;
            case LicenseSeverity.unknown:
                label = 'LIC?';
                cls = 'matrix-badge-license-unknown';
                break;
            default:
                return null;
        }

        const badge = document.createElement('span');
        badge.className = `matrix-badge matrix-badge-license ${cls}`;
        badge.textContent = label;
        badge.title = summary.spdx
            ? I18n.t('License: {spdx}', {spdx: summary.spdx})
            : I18n.t('No license declared');
        return badge;
    }

    private static _scriptBadgeLabel(s: ScriptSeverity): string {
        switch (s) {
            case ScriptSeverity.risk: return 'SCRIPT!';
            case ScriptSeverity.warn: return 'SCRIPT';
            case ScriptSeverity.info: return 'script';
        }
    }

    private static _depLabel(t: DependencyType): string {
        switch (t) {
            case DependencyType.dependency:
                return 'dep';
            case DependencyType.dev:
                return 'dev';
            case DependencyType.peer:
                return 'peer';
            case DependencyType.optional:
                return 'opt';
        }
    }
}