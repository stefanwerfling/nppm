import {ApiPackagesResponse} from '../../shared/Api/ApiTypes.js';
import {DependencyType} from '../../backend/Project/PackageManifest.js';
import {I18n} from '../Util/I18n.js';

/**
 * Right-panel package list for one selected project: a flat table of
 * every declared dependency across the project's manifests (root +
 * workspaces). Shares its right-pane slot with `InstalledView` —
 * toggle buttons in the header switch between the two.
 */
export class PackageList {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _onShowInstalled: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _onShowUnused: ((unid: string) => void)|null = null;
    private _onShowVulns: ((unid: string) => void)|null = null;
    private _onShowPr: ((unid: string) => void)|null = null;
    private _onShowTemplate: ((unid: string) => void)|null = null;

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    public onShowInstalled(handler: (unid: string) => void): void {
        this._onShowInstalled = handler;
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

    public clear(): void {
        this._root.innerHTML = '';
    }

    public renderPlaceholder(): void {
        this._root.innerHTML = '';
        const hint = document.createElement('div');
        hint.className = 'list-placeholder';
        hint.textContent = I18n.t('Select a project on the left.');
        this._root.appendChild(hint);
    }

    public renderError(msg: string): void {
        this._root.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'list-error';
        err.textContent = msg;
        this._root.appendChild(err);
    }

    public render(data: ApiPackagesResponse): void {
        this._projectUnid = data.project.unid;
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader(data.project.name));

        const table = document.createElement('table');
        table.className = 'pkg-table';

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th>${I18n.t('Package')}</th>
                <th>${I18n.t('Version')}</th>
                <th>${I18n.t('Type')}</th>
                <th>${I18n.t('Source')}</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        /*
         * Flatten all manifests into rows. The root manifest writes its
         * workspace label as "root"; workspace manifests write their
         * relative path so the user can see where the dependency was
         * declared.
         */
        for (const manifest of data.manifests) {
            const source = manifest.workspace ?? 'root';

            for (const dep of manifest.dependencies) {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td class="pkg-name">${PackageList._esc(dep.name)}</td>
                    <td class="pkg-version">${PackageList._esc(dep.version)}</td>
                    <td class="pkg-type">${PackageList._depLabel(dep.type)}</td>
                    <td class="pkg-source">${PackageList._esc(source)}</td>
                `;
                tbody.appendChild(row);
            }
        }

        if (tbody.children.length === 0) {
            const empty = document.createElement('tr');
            empty.innerHTML = `<td colspan="4" class="pkg-empty">${I18n.t('No dependencies found.')}</td>`;
            tbody.appendChild(empty);
        }

        table.appendChild(tbody);
        this._root.appendChild(table);
    }

    /**
     * Build the sticky header with the declared/installed toggle.
     * Toggling to "Installiert" hands control back to the orchestrator
     * (Nppm) — this view doesn't know how the other one is mounted.
     */
    private _renderHeader(projectName: string): HTMLElement {
        const header = document.createElement('div');
        header.className = 'list-header installed-header';

        const title = document.createElement('div');
        title.className = 'installed-title';
        title.textContent = projectName;
        header.appendChild(title);

        const toggle = document.createElement('div');
        toggle.className = 'installed-toggle';

        const declared = document.createElement('button');
        declared.className = 'installed-toggle-btn installed-toggle-btn-active';
        declared.textContent = I18n.t('Declared');

        const installed = document.createElement('button');
        installed.className = 'installed-toggle-btn';
        installed.textContent = I18n.t('Installed');
        installed.addEventListener('click', () => {
            if (this._projectUnid && this._onShowInstalled) {
                this._onShowInstalled(this._projectUnid);
            }
        });

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

    private static _depLabel(type: DependencyType): string {
        switch (type) {
            case DependencyType.dependency:
                return 'dep';
            case DependencyType.dev:
                return 'dev';
            case DependencyType.peer:
                return 'peer';
            case DependencyType.optional:
                return 'opt';
            default:
                return '';
        }
    }

    private static _esc(s: string): string {
        return s
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;');
    }

}