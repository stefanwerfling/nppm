import {ApiProject} from '../Api/ApiTypes.js';
import {ConfigProjectType} from '../Config/Config.js';
import {I18n} from './I18n.js';

/**
 * Optional callback the parent component can register to react to
 * project selection.
 */
export type TreeviewSelectHandler = (project: ApiProject) => void;

/**
 * Renders the configured projects as a flat list grouped by source
 * kind. Phase 1 only has `local`, but the grouping is in place so
 * adding `github` and `gitea` later is just a config change.
 */
export class Treeview {

    private readonly _root: HTMLElement;
    private _selected: string|null = null;
    private _onSelect: TreeviewSelectHandler|null = null;

    constructor(root: HTMLElement) {
        this._root = root;
    }

    public onSelect(handler: TreeviewSelectHandler): void {
        this._onSelect = handler;
    }

    /**
     * Sync the visible highlight when the active item is chosen
     * elsewhere (e.g. from a matrix column click).
     */
    public setSelected(unid: string): void {
        this._selected = unid;

        for (const el of Array.from(this._root.querySelectorAll('.tree-item-active'))) {
            el.classList.remove('tree-item-active');
        }

        const match = this._root.querySelector(`.tree-item[data-unid="${unid}"]`);
        if (match) {
            match.classList.add('tree-item-active');
        }
    }

    public render(projects: ApiProject[]): void {
        this._root.innerHTML = '';

        // Always-present "Matrix" entry on top — its UUID is a sentinel
        // the parent component routes specially.
        const matrixGroup = document.createElement('div');
        matrixGroup.className = 'tree-group';

        const matrixItem: ApiProject = {
            unid: '__matrix__',
            name: I18n.t('Matrix'),
            type: ConfigProjectType.local,
            packageCount: 0,
            workspaceCount: 0
        };

        const matrixEl = this._renderItem(matrixItem, true);
        matrixGroup.appendChild(matrixEl);
        this._root.appendChild(matrixGroup);

        if (projects.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-empty';
            empty.textContent = I18n.t('No projects configured in nppm.json.');
            this._root.appendChild(empty);
            return;
        }

        const byType = new Map<ConfigProjectType, ApiProject[]>();

        for (const p of projects) {
            const list = byType.get(p.type) ?? [];
            list.push(p);
            byType.set(p.type, list);
        }

        for (const [type, list] of byType.entries()) {
            const group = document.createElement('div');
            group.className = 'tree-group';

            const header = document.createElement('div');
            header.className = 'tree-group-header';
            header.textContent = Treeview._typeLabel(type);
            group.appendChild(header);

            for (const project of list) {
                group.appendChild(this._renderItem(project, false));
            }

            this._root.appendChild(group);
        }
    }

    private _renderItem(project: ApiProject, hideMeta: boolean): HTMLElement {
        const item = document.createElement('div');
        item.className = 'tree-item';
        item.dataset.unid = project.unid;

        if (project.unid === this._selected) {
            item.classList.add('tree-item-active');
        }

        const name = document.createElement('div');
        name.className = 'tree-item-name';
        name.textContent = project.name;
        item.appendChild(name);

        if (!hideMeta) {
            const meta = document.createElement('div');
            meta.className = 'tree-item-meta';

            if (project.error) {
                meta.classList.add('tree-item-meta-error');
                meta.textContent = project.error;
            } else {
                const ws = project.workspaceCount > 0
                    ? `, ${project.workspaceCount} Workspaces`
                    : '';
                meta.textContent = `${project.packageCount} Pakete${ws}`;
            }

            item.appendChild(meta);
        }

        item.addEventListener('click', () => {
            this._selected = project.unid;

            for (const el of Array.from(this._root.querySelectorAll('.tree-item-active'))) {
                el.classList.remove('tree-item-active');
            }

            item.classList.add('tree-item-active');
            this._onSelect?.(project);
        });

        return item;
    }

    private static _typeLabel(type: ConfigProjectType): string {
        switch (type) {
            case ConfigProjectType.local:
                return 'Lokal';
            case ConfigProjectType.github:
                return 'GitHub';
            case ConfigProjectType.gitea:
                return 'Gitea';
        }
    }
}