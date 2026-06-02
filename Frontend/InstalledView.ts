import {
    ApiAnalyzeEndEvent,
    ApiAnalyzeErrorEvent,
    ApiAnalyzeProgressEvent,
    ApiAnalyzeResultEvent,
    ApiAnalyzeStartEvent,
    ApiIntegrityResponse
} from '../Api/ApiTypes.js';
import {Lockfile, LockedPackage} from '../Project/Lockfile.js';
import {IntegrityFinding, IntegritySeverity} from '../Security/IntegrityScanner.js';
import {Api} from './Api.js';
import {EditorUrl} from './EditorUrl.js';
import {I18n} from './I18n.js';

/**
 * Active sub-view inside the project detail. Mirrors `PackageList`'s
 * `Deklariert`/`Installiert` toggle so the two views can share the
 * same right-pane slot.
 */
export enum InstalledMode {
    declared = 'declared',
    installed = 'installed'
}

/**
 * Right-panel "resolved versions from package-lock.json" view. Lists
 * every entry from the lockfile (including transitive) and — once the
 * analysis button is wired up — annotates each with CVE / heuristic
 * results from the security scanner.
 */
export class InstalledView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _projectRoot: string|null = null;
    private _editor: string|undefined = undefined;
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _onShowUnused: ((unid: string) => void)|null = null;
    private _onShowVulns: ((unid: string) => void)|null = null;
    private _onShowPr: ((unid: string) => void)|null = null;
    private _onShowTemplate: ((unid: string) => void)|null = null;
    private _onWhy: ((unid: string, name: string, version: string) => void)|null = null;
    private _lockfile: Lockfile|null = null;
    // Inflight SSE stream — kept so we can close it on view switch /
    // re-analysis. `null` means no analysis is running.
    private _stream: EventSource|null = null;
    // Per-`${name}@${version}` vuln list once the analyzer answered.
    // `null` value means OSV failed for that specific entry; missing
    // key means "not yet scanned".
    private _vulnsByKey: Map<string, string[]|null> = new Map();
    // Per-`${name}@${version}` integrity finding from the cross-check
    // against the registry's current `dist` data. Missing key means
    // "clean — no finding".
    private _integrityByKey: Map<string, IntegrityFinding> = new Map();
    private _integrityResp: ApiIntegrityResponse|null = null;
    // DOM references we update mid-stream without re-rendering the
    // whole table.
    private _progressBar: HTMLElement|null = null;
    private _progressText: HTMLElement|null = null;
    private _analyzeBtn: HTMLButtonElement|null = null;
    private _rowsByKey: Map<string, HTMLElement> = new Map();

    constructor(root: HTMLElement) {
        this._root = root;
    }

    public onShowDeclared(handler: (unid: string) => void): void {
        this._onShowDeclared = handler;
    }

    public onShowHistory(handler: (unid: string) => void): void {
        this._onShowHistory = handler;
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

    public onShowVulns(handler: (unid: string) => void): void {
        this._onShowVulns = handler;
    }

    public onShowPr(handler: (unid: string) => void): void {
        this._onShowPr = handler;
    }

    public onShowTemplate(handler: (unid: string) => void): void {
        this._onShowTemplate = handler;
    }

    public onWhy(handler: (unid: string, name: string, version: string) => void): void {
        this._onWhy = handler;
    }

    /**
     * Set the editor key once at boot — Nppm reads it from
     * `/api/projects` and pipes it down. `undefined` (default) hides
     * every "Open in IDE" button.
     */
    public setEditor(editor: string|undefined): void {
        this._editor = editor;
    }

    public async show(unid: string, name: string, root?: string): Promise<void> {
        this._stopStream();
        this._projectUnid = unid;
        this._projectName = name;
        this._projectRoot = root ?? null;
        this._lockfile = null;
        this._vulnsByKey = new Map();
        this._integrityByKey = new Map();
        this._integrityResp = null;
        this._rowsByKey = new Map();
        this._renderLoading();

        try {
            // Lockfile + integrity in parallel — both endpoints read
            // the lockfile, so kicking them off together saves one
            // round-trip. Integrity is cache-only against the
            // already-warmed registry pocket; rarely the slow side.
            const [lockfileResp, integrityResp] = await Promise.all([
                Api.lockfile(unid),
                Api.integrity(unid).catch(() => null)
            ]);

            // Guard against a stale response if the user switched
            // projects while the fetch was in flight.
            if (this._projectUnid !== unid) {
                return;
            }

            this._lockfile = lockfileResp.lockfile;
            if (integrityResp) {
                this._integrityResp = integrityResp;
                for (const f of integrityResp.findings) {
                    this._integrityByKey.set(`${f.name}@${f.version}`, f);
                }
            }
            this._render();
        } catch (e) {
            if (this._projectUnid === unid) {
                this._renderError((e as Error).message);
            }
        }
    }

    private _renderLoading(): void {
        this._root.innerHTML = '';
        const header = this._renderHeader();
        this._root.appendChild(header);

        const hint = document.createElement('div');
        hint.className = 'list-placeholder';
        hint.textContent = I18n.t('Loading package-lock.json …');
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

        if (!this._lockfile) {
            const empty = document.createElement('div');
            empty.className = 'list-placeholder';
            empty.textContent = I18n.t('No package-lock.json in this project.');
            this._root.appendChild(empty);
            return;
        }

        const meta = document.createElement('div');
        meta.className = 'installed-meta';
        meta.textContent =
            I18n.t('{n} resolved packages', {n: this._lockfile.packages.length})
            + ` (${InstalledView._sourceLabel(this._lockfile)})`;

        // Append integrity-summary pill when the scanner reported
        // anything non-trivial. Clean projects stay quiet.
        const sumPill = this._renderIntegritySummaryPill();
        if (sumPill) {
            meta.appendChild(document.createTextNode(' · '));
            meta.appendChild(sumPill);
        }
        this._root.appendChild(meta);

        this._root.appendChild(this._renderAnalyzeBar());

        const table = document.createElement('table');
        table.className = 'pkg-table';

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th>${I18n.t('Package')}</th>
                <th>${I18n.t('Version')}</th>
                <th>${I18n.t('Type')}</th>
                <th>${I18n.t('Path')}</th>
                <th>CVEs</th>
                <th>${I18n.t('Integrity')}</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        // Sort by name + version for predictable display. The user can
        // search/sort interactively once we have CVE annotations.
        const sorted = [...this._lockfile.packages].sort((a, b) => {
            const n = a.name.localeCompare(b.name);
            return n !== 0 ? n : a.version.localeCompare(b.version);
        });

        for (const pkg of sorted) {
            const row = this._renderRow(pkg);
            this._rowsByKey.set(`${pkg.name}@${pkg.version}`, row);
            tbody.appendChild(row);
        }

        table.appendChild(tbody);
        this._root.appendChild(table);
    }

    private _renderRow(pkg: LockedPackage): HTMLElement {
        const row = document.createElement('tr');
        const cveCell = this._renderCveCell(pkg);
        const integrityCell = this._renderIntegrityCell(pkg);
        row.innerHTML = `
            <td class="pkg-name">${InstalledView._esc(pkg.name)}</td>
            <td class="pkg-version">${InstalledView._esc(pkg.version)}</td>
            <td class="pkg-type">${InstalledView._typeLabel(pkg)}</td>
            <td class="pkg-source">${InstalledView._esc(pkg.path)}</td>
        `;
        const ideLink = this._buildIdeLink(pkg);
        if (ideLink) {
            // Append to the path cell so we don't widen the table.
            row.querySelector('.pkg-source')?.appendChild(ideLink);
        }
        const whyBtn = this._buildWhyButton(pkg);
        if (whyBtn) {
            row.querySelector('.pkg-source')?.appendChild(whyBtn);
        }
        row.appendChild(cveCell);
        row.appendChild(integrityCell);
        return row;
    }

    /**
     * `npm why`-style reverse-lookup button. Clicking it opens the
     * `WhyModal` for this `(name, version)` so the user can trace the
     * chain back to the root dependencies. Returns `null` when no
     * handler is wired (typically a test harness) — production always
     * gets one from `Nppm`.
     */
    private _buildWhyButton(pkg: LockedPackage): HTMLButtonElement|null {
        if (!this._onWhy || !this._projectUnid) {
            return null;
        }
        const btn = document.createElement('button');
        btn.className = 'installed-why-btn';
        btn.textContent = '?';
        btn.title = I18n.t('Why is this package installed?');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._onWhy && this._projectUnid) {
                this._onWhy(this._projectUnid, pkg.name, pkg.version);
            }
        });
        return btn;
    }

    /**
     * Integrity column for one row. Renders one of four states:
     *   - finding present → severity-coloured pill with title hint
     *   - clean entry     → "✓" (registry data confirmed match)
     *   - registry cache missing dist data → "—" (cold cache)
     *   - integrity scan not run at all → "—"
     */
    private _renderIntegrityCell(pkg: LockedPackage): HTMLElement {
        const td = document.createElement('td');
        td.className = 'installed-integrity-cell';

        const key = `${pkg.name}@${pkg.version}`;
        const finding = this._integrityByKey.get(key);

        if (!this._integrityResp) {
            td.textContent = '—';
            td.classList.add('pkg-empty');
            return td;
        }

        if (!finding) {
            td.textContent = '✓';
            td.classList.add('installed-integrity-clean');
            return td;
        }

        const pill = document.createElement('span');
        pill.className = `installed-integrity-pill installed-integrity-pill-${finding.severity}`;
        pill.textContent = InstalledView._integrityShortLabel(finding.kind);
        pill.title = `${finding.message}\n\n`
            + (finding.lockfileIntegrity ? `lockfile: ${finding.lockfileIntegrity}\n` : '')
            + (finding.registryIntegrity ? `registry: ${finding.registryIntegrity}` : '');
        td.appendChild(pill);
        return td;
    }

    /**
     * Compact pill label per finding kind. Keeps the column narrow;
     * the full message lives in the `title` tooltip.
     */
    private static _integrityShortLabel(kind: string): string {
        switch (kind) {
            case 'integrity-mismatch': return I18n.t('mismatch');
            case 'tarball-redirect': return I18n.t('mirror');
            case 'integrity-missing': return I18n.t('no-hash');
            case 'version-not-in-registry': return I18n.t('private');
            default: return kind;
        }
    }

    /**
     * Summary pill that sits next to the meta line above the table.
     * Only rendered when the scanner found at least one non-info
     * issue — info-only projects stay quiet so the user is only
     * nudged for actionable signals.
     */
    private _renderIntegritySummaryPill(): HTMLElement|null {
        const r = this._integrityResp;
        if (!r || r.noLockfile) {
            return null;
        }
        const s = r.summary;
        if (s.maxSeverity === null) {
            return null;
        }

        const pill = document.createElement('span');
        pill.className = `installed-integrity-pill installed-integrity-pill-${s.maxSeverity}`;
        const parts: string[] = [];
        if (s.riskCount > 0) {
            parts.push(I18n.t('{n} mismatch', {n: String(s.riskCount)}));
        }
        if (s.warnCount > 0) {
            parts.push(I18n.t('{n} warn', {n: String(s.warnCount)}));
        }
        if (s.infoCount > 0) {
            parts.push(I18n.t('{n} info', {n: String(s.infoCount)}));
        }
        pill.textContent = I18n.t('Integrity') + ': ' + parts.join(' · ');
        return pill;
    }

    /**
     * Build the per-row "Open in IDE" anchor when both the editor key
     * and the project root are known. The package path is the lockfile's
     * `pkg.path` (e.g. `node_modules/foo` or
     * `node_modules/a/node_modules/b`) — joined under the project root
     * for the absolute filesystem location the IDE handler expects.
     * Returns `null` when the affordance should stay hidden.
     */
    private _buildIdeLink(pkg: LockedPackage): HTMLAnchorElement|null {
        if (!this._editor || !this._projectRoot) {
            return null;
        }
        const rel = pkg.path.startsWith('/') ? pkg.path.slice(1) : pkg.path;
        const abs = this._projectRoot.endsWith('/')
            ? this._projectRoot + rel
            : this._projectRoot + '/' + rel;
        const url = EditorUrl.build(this._editor, abs);
        if (!url) {
            return null;
        }
        const a = document.createElement('a');
        a.className = 'installed-ide-btn';
        a.href = url;
        a.textContent = 'IDE';
        a.title = I18n.t('Open in {editor}', {editor: EditorUrl.label(this._editor)});
        return a;
    }

    /**
     * CVE column for one row. Reads from `_vulnsByKey`:
     *   - missing key  → "—" (not yet scanned)
     *   - null         → "?" (OSV failed)
     *   - empty array  → "—" (asked, no vulns)
     *   - non-empty    → red badge with count
     */
    private _renderCveCell(pkg: LockedPackage): HTMLElement {
        const td = document.createElement('td');
        td.className = 'installed-cve-cell';

        const key = `${pkg.name}@${pkg.version}`;
        const vulnIds = this._vulnsByKey.get(key);

        if (vulnIds === undefined) {
            td.textContent = '—';
            td.classList.add('pkg-empty');
            return td;
        }

        if (vulnIds === null) {
            td.textContent = '?';
            td.title = I18n.t('OSV.dev unreachable for this package');
            return td;
        }

        if (vulnIds.length === 0) {
            td.textContent = '✓';
            td.classList.add('installed-cve-clean');
            return td;
        }

        const badge = document.createElement('span');
        badge.className = 'matrix-badge matrix-badge-cve';
        badge.textContent = `${vulnIds.length}`;
        badge.title = vulnIds.join('\n');
        td.appendChild(badge);
        return td;
    }

    /**
     * Analyze-bar: the start button and the progress display. Lives
     * above the table and gets updated mid-stream without re-rendering
     * the table itself.
     */
    private _renderAnalyzeBar(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'installed-analyze-bar';

        const btn = document.createElement('button');
        btn.className = 'installed-analyze-btn';
        btn.textContent = I18n.t('Start analysis');
        btn.addEventListener('click', () => {
            if (!this._projectUnid) {
                return;
            }
            this._startAnalysis(this._projectUnid);
        });
        bar.appendChild(btn);
        this._analyzeBtn = btn;

        const wrap = document.createElement('div');
        wrap.className = 'installed-progress';
        wrap.style.display = 'none';

        const fill = document.createElement('div');
        fill.className = 'installed-progress-fill';
        wrap.appendChild(fill);

        const text = document.createElement('div');
        text.className = 'installed-progress-text';
        wrap.appendChild(text);

        bar.appendChild(wrap);

        this._progressBar = fill;
        this._progressText = text;

        return bar;
    }

    /**
     * Open the SSE stream for `unid` and wire up the four event types
     * (start/result/progress/end + error). The button stays disabled
     * for the duration; closing the view via `show(otherUnid)` or
     * `_stopStream` cancels in-flight requests.
     */
    private _startAnalysis(unid: string): void {
        this._stopStream();
        this._vulnsByKey = new Map();

        if (this._analyzeBtn) {
            this._analyzeBtn.disabled = true;
            this._analyzeBtn.textContent = I18n.t('Analysing …');
        }

        const wrap = this._progressBar?.parentElement;
        if (wrap) {
            wrap.style.display = '';
        }
        this._updateProgress(0, 0);

        const es = new EventSource(`/api/projects/${unid}/lockfile/analyze`);
        this._stream = es;

        es.addEventListener('start', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiAnalyzeStartEvent;
            this._updateProgress(0, data.total);
        });

        es.addEventListener('result', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiAnalyzeResultEvent;
            const key = `${data.name}@${data.version}`;
            this._vulnsByKey.set(key, data.vulnIds);
            this._updateRowCve(key, data.vulnIds);
        });

        es.addEventListener('progress', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiAnalyzeProgressEvent;
            this._updateProgress(data.current, data.total);
        });

        es.addEventListener('end', (e) => {
            const data = JSON.parse((e as MessageEvent).data) as ApiAnalyzeEndEvent;
            this._updateProgress(data.total, data.total);
            this._finishAnalysis(I18n.t('Analyse finished — {n} packages checked', {n: data.total}));
        });

        es.addEventListener('error', (e) => {
            // EventSource emits a bare `error` event on stream close
            // *and* a server-sent `event: error` payload. Distinguish
            // by whether there's data.
            const msg = (e as MessageEvent).data
                ? (JSON.parse((e as MessageEvent).data) as ApiAnalyzeErrorEvent).msg
                : I18n.t('Connection to analyser lost');
            this._finishAnalysis(msg);
        });
    }

    private _stopStream(): void {
        if (this._stream) {
            this._stream.close();
            this._stream = null;
        }
    }

    private _finishAnalysis(message: string): void {
        this._stopStream();

        if (this._progressText) {
            this._progressText.textContent = message;
        }
        if (this._analyzeBtn) {
            this._analyzeBtn.disabled = false;
            this._analyzeBtn.textContent = I18n.t('Re-analyse');
        }
    }

    private _updateProgress(current: number, total: number): void {
        if (!this._progressBar || !this._progressText) {
            return;
        }
        const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
        this._progressBar.style.width = `${pct.toFixed(1)}%`;
        this._progressText.textContent = total > 0
            ? `${current} / ${total}`
            : I18n.t('Starting …');
    }

    /**
     * Replace the CVE cell for every row matching `key` — the lockfile
     * may list the same `name@version` under several `path`s (nested
     * installs), so all of them get the same badge.
     */
    private _updateRowCve(key: string, vulnIds: string[]|null): void {
        if (!this._lockfile) {
            return;
        }

        // Walk every row whose package matches the (name, version) key.
        const [name, version] = InstalledView._splitKey(key);
        for (const pkg of this._lockfile.packages) {
            if (pkg.name !== name || pkg.version !== version) {
                continue;
            }
            const row = this._rowsByKey.get(`${pkg.name}@${pkg.version}`);
            // _rowsByKey stores one entry per name@version (we collide
            // on overwrite — fine, since all paths share the same cell
            // contents). Re-rendering the cell is cheap.
            if (!row) {
                continue;
            }
            const oldCell = row.querySelector('.installed-cve-cell');
            const newCell = this._renderCveCell(pkg);
            if (oldCell && oldCell.parentElement) {
                oldCell.parentElement.replaceChild(newCell, oldCell);
            }
            break;
        }
    }

    private static _splitKey(key: string): [string, string] {
        const at = key.lastIndexOf('@');
        return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, ''];
    }

    /**
     * Build the sticky header: project name + the declared/installed
     * toggle.
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

        const installed = document.createElement('button');
        installed.className = 'installed-toggle-btn installed-toggle-btn-active';
        installed.textContent = I18n.t('Installed');

        const history = document.createElement('button');
        history.className = 'installed-toggle-btn';
        history.textContent = I18n.t('History');
        history.addEventListener('click', () => {
            if (this._projectUnid && this._onShowHistory) {
                this._onShowHistory(this._projectUnid);
            }
        });

        const matrix = document.createElement('button');
        matrix.className = 'installed-toggle-btn';
        matrix.textContent = I18n.t('Matrix');
        matrix.addEventListener('click', () => {
            if (this._projectUnid && this._onShowMatrix) {
                this._onShowMatrix(this._projectUnid);
            }
        });

        const tree = document.createElement('button');
        tree.className = 'installed-toggle-btn';
        tree.textContent = I18n.t('Tree');
        tree.addEventListener('click', () => {
            if (this._projectUnid && this._onShowTree) {
                this._onShowTree(this._projectUnid);
            }
        });

        const unused = document.createElement('button');
        unused.className = 'installed-toggle-btn';
        unused.textContent = I18n.t('Unused');
        unused.addEventListener('click', () => {
            if (this._projectUnid && this._onShowUnused) {
                this._onShowUnused(this._projectUnid);
            }
        });

        const vulns = document.createElement('button');
        vulns.className = 'installed-toggle-btn';
        vulns.textContent = I18n.t('Vulns');
        vulns.addEventListener('click', () => {
            if (this._projectUnid && this._onShowVulns) {
                this._onShowVulns(this._projectUnid);
            }
        });

        const pr = document.createElement('button');
        pr.className = 'installed-toggle-btn';
        pr.textContent = I18n.t('PR');
        pr.addEventListener('click', () => {
            if (this._projectUnid && this._onShowPr) {
                this._onShowPr(this._projectUnid);
            }
        });

        const template = document.createElement('button');
        template.className = 'installed-toggle-btn';
        template.textContent = I18n.t('Template');
        template.addEventListener('click', () => {
            if (this._projectUnid && this._onShowTemplate) {
                this._onShowTemplate(this._projectUnid);
            }
        });

        toggle.appendChild(declared);
        toggle.appendChild(installed);
        toggle.appendChild(history);
        toggle.appendChild(matrix);
        toggle.appendChild(tree);
        toggle.appendChild(unused);
        toggle.appendChild(vulns);
        toggle.appendChild(pr);
        toggle.appendChild(template);
        header.appendChild(toggle);

        return header;
    }

    private static _sourceLabel(lock: Lockfile): string {
        switch (lock.source) {
            case 'committed':
                return I18n.t('package-lock.json v{n}', {n: lock.lockfileVersion});
            case 'hidden':
                return I18n.t('node_modules/.package-lock.json v{n}', {n: lock.lockfileVersion});
            case 'synthesized':
                return I18n.t('Generated from node_modules (no dev/peer flags)');
        }
    }

    private static _typeLabel(pkg: LockedPackage): string {
        const tags: string[] = [];
        if (pkg.dev) {
            tags.push('dev');
        }
        if (pkg.optional) {
            tags.push('opt');
        }
        if (pkg.peer) {
            tags.push('peer');
        }
        return tags.length === 0 ? 'dep' : tags.join('/');
    }

    private static _esc(s: string): string {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
}