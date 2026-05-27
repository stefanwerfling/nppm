import {ProjectMatrixResponse, ProjectMatrixRow} from '../Matrix/ProjectMatrixBuilder.js';
import {DependencyType} from '../Project/PackageManifest.js';
import {Api} from './Api.js';
import {t} from './I18n.js';

/**
 * Per-project matrix: rows are packages, columns are this project's
 * workspaces (root first, then each declared workspace) plus a
 * trailing Latest column from the registry. Same colouring semantics
 * as the global matrix; cells without a declaration render as `—`.
 *
 * Clicking a cell opens the detail panel for that `pkg@version` —
 * same hook as the global matrix.
 */
export class ProjectMatrixView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _data: ProjectMatrixResponse|null = null;
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowInstalled: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _onCellClick: ((pkg: string, version: string, latest: string|null) => void)|null = null;

    constructor(root: HTMLElement) {
        this._root = root;
    }

    public onShowDeclared(h: (unid: string) => void): void {
        this._onShowDeclared = h;
    }
    public onShowInstalled(h: (unid: string) => void): void {
        this._onShowInstalled = h;
    }
    public onShowHistory(h: (unid: string) => void): void {
        this._onShowHistory = h;
    }
    public onShowTree(h: (unid: string) => void): void {
        this._onShowTree = h;
    }
    public onCellClick(h: (pkg: string, version: string, latest: string|null) => void): void {
        this._onCellClick = h;
    }

    public async show(unid: string, name: string): Promise<void> {
        this._projectUnid = unid;
        this._projectName = name;
        this._renderLoading();

        try {
            const data = await Api.projectMatrix(unid);
            if (this._projectUnid !== unid) {
                return;
            }
            this._data = data;
            this._render();
        } catch (e) {
            if (this._projectUnid === unid) {
                this._renderError((e as Error).message);
            }
        }
    }

    private _renderLoading(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());
        const hint = document.createElement('div');
        hint.className = 'list-placeholder';
        hint.textContent = t('Loading matrix …');
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

        if (!this._data) {
            return;
        }

        if (this._data.workspaces.length === 1 && this._data.workspaces[0].label === 'root') {
            const note = document.createElement('div');
            note.className = 'installed-meta';
            note.textContent = t('This project has no workspaces — the matrix only shows the root column.');
            this._root.appendChild(note);
        }

        const wrap = document.createElement('div');
        wrap.className = 'matrix-wrap';
        wrap.appendChild(this._renderTable());
        this._root.appendChild(wrap);
    }

    private _renderTable(): HTMLElement {
        const table = document.createElement('table');
        table.className = 'matrix-table';

        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        trHead.appendChild(ProjectMatrixView._th(t('Package'), 'matrix-th-name'));
        for (const ws of this._data!.workspaces) {
            trHead.appendChild(ProjectMatrixView._th(ws.label, 'matrix-th-project'));
        }
        trHead.appendChild(ProjectMatrixView._th(t('Latest'), 'matrix-th-latest'));
        thead.appendChild(trHead);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        if (this._data!.rows.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = this._data!.workspaces.length + 2;
            td.className = 'matrix-empty';
            td.textContent = t('No dependencies found.');
            tr.appendChild(td);
            tbody.appendChild(tr);
        } else {
            for (const row of this._data!.rows) {
                tbody.appendChild(this._renderRow(row));
            }
        }

        table.appendChild(tbody);
        return table;
    }

    private _renderRow(row: ProjectMatrixRow): HTMLElement {
        const tr = document.createElement('tr');
        tr.className = `matrix-row matrix-row-${row.status}`;

        const nameCell = document.createElement('td');
        nameCell.className = 'matrix-cell-name';
        nameCell.textContent = row.name;
        tr.appendChild(nameCell);

        for (const ws of this._data!.workspaces) {
            const cellData = row.cells[ws.label];
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

                const v = document.createElement('span');
                v.className = 'matrix-cell-version';
                if (cellData.installedVersion) {
                    v.textContent = cellData.installedVersion;
                    v.title = cellData.version;
                    td.appendChild(v);

                    const gitTag = document.createElement('span');
                    gitTag.className = 'matrix-cell-git';
                    gitTag.textContent = 'git';
                    gitTag.title = cellData.version;
                    td.appendChild(gitTag);
                } else {
                    v.textContent = cellData.version;
                    td.appendChild(v);
                }

                const types = cellData.types
                    .filter((t) => t !== DependencyType.dependency)
                    .map(ProjectMatrixView._depLabel)
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

    /**
     * Four-button toggle in the project-detail header. Active button
     * is "Matrix" here. Each of the four buttons routes back through a
     * Nppm-supplied callback so the host can swap panes.
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
        declared.textContent = t('Declared');
        declared.addEventListener('click', () => {
            if (this._projectUnid && this._onShowDeclared) {
                this._onShowDeclared(this._projectUnid);
            }
        });
        toggle.appendChild(declared);

        const installed = document.createElement('button');
        installed.className = 'installed-toggle-btn';
        installed.textContent = t('Installed');
        installed.addEventListener('click', () => {
            if (this._projectUnid && this._onShowInstalled) {
                this._onShowInstalled(this._projectUnid);
            }
        });
        toggle.appendChild(installed);

        const history = document.createElement('button');
        history.className = 'installed-toggle-btn';
        history.textContent = t('History');
        history.addEventListener('click', () => {
            if (this._projectUnid && this._onShowHistory) {
                this._onShowHistory(this._projectUnid);
            }
        });
        toggle.appendChild(history);

        const matrix = document.createElement('button');
        matrix.className = 'installed-toggle-btn installed-toggle-btn-active';
        matrix.textContent = t('Matrix');
        toggle.appendChild(matrix);

        const tree = document.createElement('button');
        tree.className = 'installed-toggle-btn';
        tree.textContent = t('Tree');
        tree.addEventListener('click', () => {
            if (this._projectUnid && this._onShowTree) {
                this._onShowTree(this._projectUnid);
            }
        });
        toggle.appendChild(tree);

        header.appendChild(toggle);
        return header;
    }

    private static _th(label: string, cls: string): HTMLElement {
        const th = document.createElement('th');
        th.className = cls;
        th.textContent = label;
        return th;
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