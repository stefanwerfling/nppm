import {ApiPackagesResponse} from '../../shared/Api/ApiTypes.js';
import {DependencyType} from '../../backend/Project/PackageManifest.js';
import {I18n} from '../Util/I18n.js';
import {ProjectNav} from '../Widgets/ProjectNav.js';

/**
 * Right-panel package list for one selected project: a flat table of
 * every declared dependency across the project's manifests (root +
 * workspaces). Shares its right-pane slot with `InstalledView` —
 * toggle buttons in the header switch between the two.
 */
export class PackageList {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _nav: ProjectNav|null = null;

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    public setNav(nav: ProjectNav): void {
        this._nav = nav;
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

    private _renderHeader(projectName: string): HTMLElement {
        const header = document.createElement('div');
        header.className = 'list-header installed-header';

        const title = document.createElement('div');
        title.className = 'installed-title';
        title.textContent = projectName;
        header.appendChild(title);

        if (this._nav) {
            header.appendChild(this._nav.renderToggle(this._projectUnid, 'declared'));
        }

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