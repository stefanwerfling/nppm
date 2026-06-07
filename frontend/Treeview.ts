import {ApiProject} from '../shared/Api/ApiTypes.js';
import {ConfigProjectType} from '../backend/Config/Config.js';
import {I18n} from './I18n.js';

/**
 * Optional callback the parent component can register to react to
 * project selection.
 */
export type TreeviewSelectHandler = (project: ApiProject) => void;

/** Fired when the user clicks the eye toggle on a project row. */
export type TreeviewVisibilityHandler = (project: ApiProject, hidden: boolean) => void;

/** Fired when the user clicks the "+" button at the top of the treeview. */
export type TreeviewAddHandler = () => void;

/** Fired when the user clicks the gear icon on a project row. */
export type TreeviewEditHandler = (project: ApiProject) => void;

/**
 * Renders the configured projects as a flat list grouped by source
 * kind. Phase 1 only has `local`, but the grouping is in place so
 * adding `github` and `gitea` later is just a config change.
 */
export class Treeview {

    private readonly _root: HTMLElement;
    private _selected: string|null = null;
    private _onSelect: TreeviewSelectHandler|null = null;
    private _onVisibility: TreeviewVisibilityHandler|null = null;
    private _onAdd: TreeviewAddHandler|null = null;
    private _onEdit: TreeviewEditHandler|null = null;
    private _scores: Map<string, number> = new Map();

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    public onSelect(handler: TreeviewSelectHandler): void {
        this._onSelect = handler;
    }

    public onVisibilityToggle(handler: TreeviewVisibilityHandler): void {
        this._onVisibility = handler;
    }

    public onAddProject(handler: TreeviewAddHandler): void {
        this._onAdd = handler;
    }

    public onEditProject(handler: TreeviewEditHandler): void {
        this._onEdit = handler;
    }

    /**
     * Update the per-project health rings in place. Walks each
     * existing project item (sentinels are skipped — they have no
     * package set) and replaces its score slot with a fresh SVG.
     * `setData()` style: incremental, doesn't trigger a full
     * re-render of the treeview.
     */
    public setProjectScores(scores: Map<string, number>): void {
        this._scores = scores;
        for (const item of Array.from(this._root.querySelectorAll<HTMLElement>('.tree-item'))) {
            const unid = item.dataset.unid;
            if (!unid || Treeview._sentinelIcon(unid) !== null) {
                continue;
            }
            const slot = item.querySelector('.tree-item-score');
            if (!slot) {
                continue;
            }
            slot.replaceChildren(Treeview._renderScoreRing(scores.get(unid)));
        }
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

        /*
         * "+ Add project" pinned to the very top so the action is
         * discoverable even when the project list is empty.
         */
        const addBar = document.createElement('div');
        addBar.className = 'tree-addbar';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'tree-add-btn';
        addBtn.title = I18n.t('Add project');
        addBtn.innerHTML = `<span class="tree-add-plus">+</span> ${  I18n.t('Add project')}`;
        addBtn.addEventListener('click', () => this._onAdd?.());
        addBar.appendChild(addBtn);
        this._root.appendChild(addBar);

        /*
         * Always-present sentinel rows on top — Dashboard / Matrix /
         * Templates. Their UUIDs are sentinels the parent component
         * routes specially.
         */
        const matrixGroup = document.createElement('div');
        matrixGroup.className = 'tree-group';

        const dashboardItem: ApiProject = {
            unid: '__dashboard__',
            name: I18n.t('Dashboard'),
            type: ConfigProjectType.local,
            packageCount: 0,
            workspaceCount: 0
        };
        matrixGroup.appendChild(this._renderItem(dashboardItem, true));

        const matrixItem: ApiProject = {
            unid: '__matrix__',
            name: I18n.t('Matrix'),
            type: ConfigProjectType.local,
            packageCount: 0,
            workspaceCount: 0
        };
        matrixGroup.appendChild(this._renderItem(matrixItem, true));

        const templatesItem: ApiProject = {
            unid: '__templates__',
            name: I18n.t('Templates'),
            type: ConfigProjectType.local,
            packageCount: 0,
            workspaceCount: 0
        };
        matrixGroup.appendChild(this._renderItem(templatesItem, true));

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
        if (project.hidden) {
            item.classList.add('tree-item-hidden');
        }

        /*
         * Sentinel entries (Matrix, Templates) get their own class so
         * the user can spot them at a glance — they aren't projects
         * and behave differently when clicked.
         */
        const sentinel = Treeview._sentinelIcon(project.unid);
        if (sentinel) {
            item.classList.add('tree-item-sentinel');
        }

        if (project.unid === this._selected) {
            item.classList.add('tree-item-active');
        }

        const name = document.createElement('div');
        name.className = 'tree-item-name';
        if (sentinel) {
            const icon = document.createElement('span');
            icon.className = 'tree-item-icon';
            icon.textContent = sentinel;
            name.appendChild(icon);
        }
        const label = document.createElement('span');
        label.textContent = project.name;
        name.appendChild(label);
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

            // Per-row action strip: gear + eye-toggle.
            const actions = document.createElement('div');
            actions.className = 'tree-item-actions';
            actions.appendChild(this._renderGearButton(project));
            actions.appendChild(this._renderEyeToggle(project));
            item.appendChild(actions);

            /*
             * Health score ring — filled in asynchronously by
             * `setProjectScores()` once the matrix heuristics arrive.
             */
            const scoreSlot = document.createElement('div');
            scoreSlot.className = 'tree-item-score';
            scoreSlot.appendChild(Treeview._renderScoreRing(this._scores.get(project.unid)));
            item.appendChild(scoreSlot);
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

    /**
     * Gear-icon edit affordance. Clicking it opens the project
     * form modal in edit mode for this project.
     */
    private _renderGearButton(project: ApiProject): HTMLElement {
        const btn = document.createElement('button');
        btn.className = 'tree-item-gear';
        btn.type = 'button';
        btn.innerHTML = Treeview._GEAR_SVG;
        btn.title = I18n.t('Edit project settings');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._onEdit?.(project);
        });
        return btn;
    }

    /**
     * Eye-icon toggle for the cross-project matrix visibility.
     * Renders the open eye when the project is shown, a slashed
     * eye when hidden. Click stops propagation so the row's
     * selection handler doesn't also fire.
     */
    private _renderEyeToggle(project: ApiProject): HTMLElement {
        const btn = document.createElement('button');
        btn.className = 'tree-item-eye';
        btn.type = 'button';
        btn.innerHTML = project.hidden ? Treeview._EYE_OFF_SVG : Treeview._EYE_SVG;
        btn.title = project.hidden
            ? I18n.t('Show in cross-project matrix')
            : I18n.t('Hide from cross-project matrix');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._onVisibility?.(project, !project.hidden);
        });
        return btn;
    }

    /** 14×14 outline gear — feather-style. */
    private static readonly _GEAR_SVG =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + '<circle cx="12" cy="12" r="3"/>'
        + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
        + '</svg>';

    /** 14×14 outline eye — feather-style. */
    private static readonly _EYE_SVG =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>'
        + '<circle cx="12" cy="12" r="3"/>'
        + '</svg>';

    /** 14×14 outline eye-off — feather-style. */
    private static readonly _EYE_OFF_SVG =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>'
        + '<line x1="1" y1="1" x2="23" y2="23"/>'
        + '</svg>';

    /**
     * Icon character for the Matrix / Templates sentinel rows in the
     * treeview. Returns `null` for normal project entries so the
     * caller can branch on its presence.
     */
    private static _sentinelIcon(unid: string): string|null {
        if (unid === '__dashboard__') {
            return '▣';
        }
        if (unid === '__matrix__') {
            return '▦';
        }
        if (unid === '__templates__') {
            return '◈';
        }
        return null;
    }

    /**
     * SVG progress-ring with the health percentage in the centre.
     * `health` may be `undefined` while the matrix data is still
     * loading — in that case the ring renders neutral grey with a
     * dash placeholder so the layout doesn't jump when the real
     * score arrives.
     *
     * Tiers: ≥80 green, ≥60 amber, <60 red.
     */
    private static _renderScoreRing(health: number|undefined): SVGElement {
        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', '0 0 36 36');
        svg.setAttribute('width', '32');
        svg.setAttribute('height', '32');
        const tier = Treeview._healthTier(health);
        svg.setAttribute('class', `tree-score-ring tree-score-${tier}`);

        const bg = document.createElementNS(svgNs, 'circle');
        bg.setAttribute('class', 'tree-score-bg');
        bg.setAttribute('cx', '18');
        bg.setAttribute('cy', '18');
        bg.setAttribute('r', '15');
        bg.setAttribute('fill', 'none');
        svg.appendChild(bg);

        if (health !== undefined) {
            const fg = document.createElementNS(svgNs, 'circle');
            fg.setAttribute('class', 'tree-score-fg');
            fg.setAttribute('cx', '18');
            fg.setAttribute('cy', '18');
            fg.setAttribute('r', '15');
            fg.setAttribute('fill', 'none');
            /*
             * 2πr ≈ 94.25 for r=15. Dasharray "<percent>, 100" uses
             * pathLength=100 so we don't have to compute the
             * circumference — modern browsers handle it.
             */
            fg.setAttribute('pathLength', '100');
            fg.setAttribute('stroke-dasharray', `${health}, 100`);
            fg.setAttribute('stroke-linecap', 'round');
            fg.setAttribute('transform', 'rotate(-90 18 18)');
            svg.appendChild(fg);
        }

        const text = document.createElementNS(svgNs, 'text');
        text.setAttribute('class', 'tree-score-text');
        text.setAttribute('x', '18');
        text.setAttribute('y', '22');
        text.setAttribute('text-anchor', 'middle');
        text.textContent = health === undefined ? '…' : String(health);
        svg.appendChild(text);

        return svg;
    }

    private static _typeLabel(type: ConfigProjectType): string {
        switch (type) {
            case ConfigProjectType.local:
                return 'Lokal';
            case ConfigProjectType.github:
                return 'GitHub';
            case ConfigProjectType.gitea:
                return 'Gitea';
            default:
                return '';
        }
    }

    private static _healthTier(health: number|undefined): string {
        if (health === undefined) {
            return 'loading';
        }
        if (health >= 80) {
            return 'good';
        }
        if (health >= 60) {
            return 'warn';
        }
        return 'risk';
    }

}