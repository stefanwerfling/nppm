import {
    ApiAnalyzeEndEvent,
    ApiAnalyzeErrorEvent,
    ApiAnalyzeProgressEvent,
    ApiAnalyzeResultEvent,
    ApiAnalyzeStartEvent
} from '../Api/ApiTypes.js';
import {Lockfile, LockedPackage} from '../Project/Lockfile.js';
import {Api} from './Api.js';
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
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _lockfile: Lockfile|null = null;
    // Inflight SSE stream — kept so we can close it on view switch /
    // re-analysis. `null` means no analysis is running.
    private _stream: EventSource|null = null;
    // Per-`${name}@${version}` vuln list once the analyzer answered.
    // `null` value means OSV failed for that specific entry; missing
    // key means "not yet scanned".
    private _vulnsByKey: Map<string, string[]|null> = new Map();
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

    public async show(unid: string, name: string): Promise<void> {
        this._stopStream();
        this._projectUnid = unid;
        this._projectName = name;
        this._lockfile = null;
        this._vulnsByKey = new Map();
        this._rowsByKey = new Map();
        this._renderLoading();

        try {
            const response = await Api.lockfile(unid);

            // Guard against a stale response if the user switched
            // projects while the fetch was in flight.
            if (this._projectUnid !== unid) {
                return;
            }

            this._lockfile = response.lockfile;
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
        row.innerHTML = `
            <td class="pkg-name">${InstalledView._esc(pkg.name)}</td>
            <td class="pkg-version">${InstalledView._esc(pkg.version)}</td>
            <td class="pkg-type">${InstalledView._typeLabel(pkg)}</td>
            <td class="pkg-source">${InstalledView._esc(pkg.path)}</td>
        `;
        row.appendChild(cveCell);
        return row;
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

        toggle.appendChild(declared);
        toggle.appendChild(installed);
        toggle.appendChild(history);
        toggle.appendChild(matrix);
        toggle.appendChild(tree);
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