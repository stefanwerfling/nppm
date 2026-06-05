import {ApiManifest} from '../shared/Api/ApiTypes.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';

type Row = {
    workspace: string;
    version: string;
    depType: string;
};

/**
 * Drill-down dialog for the `WS` badge in the cross-project matrix.
 * The badge appears when a project's workspaces declared the same
 * package with different version ranges — this modal surfaces the
 * full per-workspace breakdown so the user can see *what* exactly
 * disagrees (e.g. `frontend → webpack@^5.97.1`, `backend →
 * webpack@^5.78.0`) and a button takes them straight to the
 * per-project matrix to fix it.
 *
 * Data source: `GET /api/projects/:id/packages` returns every
 * manifest plus its dependencies; the modal filters down to the
 * single package name passed at open time.
 */
export class WorkspaceDriftModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _onOpenProjectMatrix: ((projectUnid: string) => void)|null = null;

    /**
     * Register a callback for the "Open project matrix" button. Nppm
     * wires this to select the project in the treeview and switch
     * the right pane to the per-project matrix view.
     */
    public onOpenProjectMatrix(handler: (projectUnid: string) => void): void {
        this._onOpenProjectMatrix = handler;
    }

    public async open(projectUnid: string, projectName: string, packageName: string): Promise<void> {
        this._mount(projectName, packageName);
        this._renderLoading();
        try {
            const data = await Api.listPackages(projectUnid);
            this._render(projectUnid, projectName, packageName, data.manifests);
        } catch (e) {
            this._renderError((e as Error).message);
        }
    }

    public close(): void {
        this._backdrop?.remove();
        this._backdrop = null;
        this._panel = null;
        document.removeEventListener('keydown', this._onKeyDown);
    }

    private _mount(projectName: string, packageName: string): void {
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
        panel.className = 'umd-panel wdm-panel';
        backdrop.appendChild(panel);
        this._panel = panel;

        this._panel.appendChild(this._renderHeader(projectName, packageName));
        document.addEventListener('keydown', this._onKeyDown);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    private _renderHeader(projectName: string, packageName: string): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = I18n.t('Workspace drift — {pkg} in {project}', {
            pkg: packageName,
            project: projectName
        });
        head.appendChild(title);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    private _renderLoading(): void {
        if (!this._panel) {
            return;
        }
        const hint = document.createElement('div');
        hint.className = 'umd-loading';
        hint.textContent = I18n.t('Loading workspace breakdown …');
        this._panel.appendChild(hint);
    }

    private _renderError(msg: string): void {
        if (!this._panel) {
            return;
        }
        const err = document.createElement('div');
        err.className = 'umd-error';
        err.textContent = msg;
        this._panel.appendChild(err);
    }

    private _render(
        projectUnid: string,
        projectName: string,
        packageName: string,
        manifests: ApiManifest[]
    ): void {
        if (!this._panel) {
            return;
        }
        for (const node of Array.from(this._panel.querySelectorAll('.umd-loading'))) {
            node.remove();
        }

        const rows: Row[] = [];
        for (const m of manifests) {
            for (const dep of m.dependencies) {
                if (dep.name === packageName) {
                    rows.push({
                        workspace: m.workspace ?? I18n.t('(root)'),
                        version: dep.version,
                        depType: dep.type
                    });
                }
            }
        }

        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'umd-note';
            empty.textContent = I18n.t(
                '{pkg} is not declared in any workspace of {project} — the manifest list may be stale.',
                {pkg: packageName, project: projectName}
            );
            this._panel.appendChild(empty);
            this._panel.appendChild(this._renderActions(projectUnid));
            return;
        }

        const distinctVersions = new Set(rows.map((r) => r.version));
        const summary = document.createElement('div');
        summary.className = 'umd-note';
        summary.textContent = I18n.t(
            '{n} workspace(s) declared {pkg}, with {v} distinct version range(s).',
            {n: String(rows.length), pkg: packageName, v: String(distinctVersions.size)}
        );
        this._panel.appendChild(summary);

        const table = document.createElement('table');
        table.className = 'wdm-table';
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        for (const label of [I18n.t('Workspace'), I18n.t('Version'), I18n.t('Type')]) {
            const th = document.createElement('th');
            th.textContent = label;
            trh.appendChild(th);
        }
        thead.appendChild(trh);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        rows.sort((a, b) => a.workspace.localeCompare(b.workspace));
        for (const r of rows) {
            const tr = document.createElement('tr');
            const tdW = document.createElement('td');
            tdW.textContent = r.workspace;
            tdW.className = 'wdm-ws';
            tr.appendChild(tdW);
            const tdV = document.createElement('td');
            tdV.textContent = r.version;
            tdV.className = 'wdm-v';
            tr.appendChild(tdV);
            const tdT = document.createElement('td');
            tdT.textContent = r.depType;
            tdT.className = 'wdm-t';
            tr.appendChild(tdT);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        this._panel.appendChild(table);

        this._panel.appendChild(this._renderActions(projectUnid));
    }

    private _renderActions(projectUnid: string): HTMLElement {
        const actions = document.createElement('div');
        actions.className = 'umd-actions';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'umd-btn umd-btn-primary';
        open.textContent = I18n.t('Open project matrix');
        open.addEventListener('click', () => {
            this.close();
            this._onOpenProjectMatrix?.(projectUnid);
        });
        actions.appendChild(open);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Close');
        cancel.addEventListener('click', () => this.close());
        actions.appendChild(cancel);
        return actions;
    }

}