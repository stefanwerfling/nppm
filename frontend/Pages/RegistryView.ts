import {
    ApiRegistryLogEntry,
    ApiRegistryPackage,
    ApiRegistryStatusResponse
} from '../../shared/Api/ApiTypes.js';
import {Api} from '../Util/Api.js';
import {I18n} from '../Util/I18n.js';

/**
 * Right-pane view for the package-registry / proxy (step 18.6).
 * Reached via the treeview's `⬢ Registry` sentinel and the topbar
 * status pill. Shows whether the proxy is on, how to point npm at it,
 * what's mirrored in `.nppm/register/`, and a live feed of proxy
 * requests (store HIT vs upstream MISS) driven by the
 * `/api/registry/log` SSE stream.
 *
 * Self-contained: owns its own status/packages fetches, the log
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

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    /**
     * Build the scaffold once, then refresh status + packages and
     * (re)open the live log. Idempotent — safe to call on every
     * navigation to the sentinel.
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

        const tableWrap = document.createElement('div');
        tableWrap.className = 'reg-table-wrap';
        this._tableEl = document.createElement('div');
        this._tableEl.className = 'reg-table';
        tableWrap.appendChild(this._tableEl);
        this._root.appendChild(tableWrap);

        const logWrap = document.createElement('div');
        logWrap.className = 'reg-log-wrap';
        const logHead = document.createElement('div');
        logHead.className = 'reg-log-head';
        logHead.textContent = I18n.t('Live requests');
        logWrap.appendChild(logHead);
        this._logEl = document.createElement('div');
        this._logEl.className = 'reg-log';
        logWrap.appendChild(this._logEl);
        this._root.appendChild(logWrap);
    }

    private async _refresh(): Promise<void> {
        try {
            const [status, pkgs] = await Promise.all([Api.registryStatus(), Api.registryPackages()]);
            this._renderStatus(status);
            this._renderConnect(status);
            this._renderTable(pkgs.packages);
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
        this._connectEl.appendChild(RegistryView._cmdRow(`registry=${url}`, I18n.t('# or per-project in .npmrc')));

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
        for (const label of [I18n.t('Package'), I18n.t('Versions'), I18n.t('Store size')]) {
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

        return tr;
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