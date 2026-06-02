import {ApiTemplatesMatrixResponse, ApiTemplatesMatrixRow} from '../Api/ApiTypes.js';
import {I18n} from './I18n.js';
import {TemplateFormModal} from './TemplateFormModal.js';

/**
 * Cross-project template-compliance matrix. Rows = templates, columns
 * = projects, cells = traffic light + finding-count. Click on a
 * cell that has findings to drill into the per-project TemplateView.
 *
 * Replaces the cross-package matrix when the "Templates" treeview
 * entry is selected. Loads once per open; the user can hit reload by
 * re-clicking the entry.
 */
export class TemplatesView {

    private readonly _root: HTMLElement;
    private _onCellClick: ((projectUnid: string) => void)|null = null;

    constructor(root: HTMLElement) {
        this._root = root;
    }

    public onCellClick(handler: (projectUnid: string) => void): void {
        this._onCellClick = handler;
    }

    public async show(): Promise<void> {
        this._renderLoading();
        try {
            const res = await fetch('/api/templates/matrix');
            if (!res.ok) {
                this._renderError(`HTTP ${res.status} — ${await res.text()}`);
                return;
            }
            const data = await res.json() as ApiTemplatesMatrixResponse;
            this._render(data);
        } catch (e) {
            this._renderError((e as Error).message);
        }
    }

    private _renderLoading(): void {
        this._root.innerHTML = '';
        const h = document.createElement('div');
        h.className = 'tpv-title';
        h.textContent = I18n.t('Templates');
        this._root.appendChild(h);
        const loading = document.createElement('div');
        loading.className = 'list-placeholder';
        loading.textContent = I18n.t('Loading templates …');
        this._root.appendChild(loading);
    }

    private _renderError(msg: string): void {
        this._root.innerHTML = '';
        const h = document.createElement('div');
        h.className = 'tpv-title';
        h.textContent = I18n.t('Templates');
        this._root.appendChild(h);
        const err = document.createElement('div');
        err.className = 'list-error';
        err.textContent = msg;
        this._root.appendChild(err);
    }

    private _render(data: ApiTemplatesMatrixResponse): void {
        this._root.innerHTML = '';

        const titleBar = document.createElement('div');
        titleBar.className = 'tpv-titlebar';
        const h = document.createElement('div');
        h.className = 'tpv-title';
        h.textContent = I18n.t('Templates');
        titleBar.appendChild(h);
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'umd-btn umd-btn-primary tpv-add';
        add.textContent = I18n.t('+ Add template');
        add.addEventListener('click', () => {
            const modal = new TemplateFormModal();
            modal.onSaved(() => void this.show());
            void modal.open({kind: 'add'}, data.rows.map((r) => r.template.id));
        });
        titleBar.appendChild(add);
        this._root.appendChild(titleBar);

        if (data.rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'list-placeholder';
            empty.innerHTML = I18n.t(
                'No templates configured. Click "+ Add template" to create one, or add a folder at <code>nppm-templates/&lt;id&gt;/template.json</code>.'
            );
            this._root.appendChild(empty);
            return;
        }

        // Project columns come from the first row's cells — same order
        // across every row (the backend iterates the projects map
        // identically).
        const projects = data.rows[0].cells.map((c) => ({unid: c.projectUnid, name: c.projectName}));

        const tableWrap = document.createElement('div');
        tableWrap.className = 'tpv-tablewrap';

        const table = document.createElement('table');
        table.className = 'tpv-table';

        const thead = document.createElement('thead');
        const headTr = document.createElement('tr');
        const corner = document.createElement('th');
        corner.className = 'tpv-corner';
        corner.textContent = I18n.t('Template');
        headTr.appendChild(corner);
        for (const p of projects) {
            const th = document.createElement('th');
            th.className = 'tpv-proj';
            th.textContent = p.name;
            th.title = p.name;
            headTr.appendChild(th);
        }
        thead.appendChild(headTr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of data.rows) {
            tbody.appendChild(this._renderRow(row));
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        this._root.appendChild(tableWrap);
    }

    private async _deleteTemplate(id: string): Promise<void> {
        try {
            const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, {method: 'DELETE'});
            if (!res.ok) {
                this._renderError(`HTTP ${res.status} — ${await res.text()}`);
                return;
            }
            void this.show();
        } catch (e) {
            this._renderError((e as Error).message);
        }
    }

    private _renderRow(row: ApiTemplatesMatrixRow): HTMLElement {
        const tr = document.createElement('tr');

        const tplCell = document.createElement('td');
        tplCell.className = 'tpv-tpl';
        const nameRow = document.createElement('div');
        nameRow.className = 'tpv-tpl-namerow';
        const name = document.createElement('div');
        name.className = 'tpv-tpl-name';
        name.textContent = row.template.name;
        nameRow.appendChild(name);
        const actions = document.createElement('div');
        actions.className = 'tpv-tpl-actions';
        if (row.template.source === 'remote') {
            const badge = document.createElement('span');
            badge.className = 'tpv-tpl-remote';
            badge.textContent = 'REMOTE';
            badge.title = row.template.sourceUrl
                ? I18n.t('Remote template from {url}', {url: row.template.sourceUrl})
                : I18n.t('Remote template (read-only)');
            actions.appendChild(badge);
        } else {
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'tpv-tpl-act';
            edit.textContent = '⚙';
            edit.title = I18n.t('Edit template');
            edit.addEventListener('click', () => {
                const modal = new TemplateFormModal();
                modal.onSaved(() => void this.show());
                void modal.open({kind: 'edit', id: row.template.id}, []);
            });
            actions.appendChild(edit);
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'tpv-tpl-act tpv-tpl-act-danger';
            del.textContent = '🗑';
            del.title = I18n.t('Delete template');
            del.addEventListener('click', () => {
                if (!confirm(I18n.t('Delete template {id}? This removes the entire nppm-templates/{id}/ folder including files.', {id: row.template.id}))) {
                    return;
                }
                void this._deleteTemplate(row.template.id);
            });
            actions.appendChild(del);
        }
        nameRow.appendChild(actions);
        tplCell.appendChild(nameRow);
        const meta = document.createElement('div');
        meta.className = 'tpv-tpl-meta';
        const parts: string[] = [];
        if (row.template.runtimeCount > 0) parts.push(`runtime ${row.template.runtimeCount}`);
        if (row.template.devCount > 0) parts.push(`dev ${row.template.devCount}`);
        if (row.template.peerCount > 0) parts.push(`peer ${row.template.peerCount}`);
        if (row.template.optionalCount > 0) parts.push(`opt ${row.template.optionalCount}`);
        if (row.template.forbiddenCount > 0) parts.push(`forbidden ${row.template.forbiddenCount}`);
        if (row.template.hasRoot) parts.push('root');
        if (row.template.mode === 'strict') parts.push('strict');
        meta.textContent = parts.join(' · ');
        tplCell.appendChild(meta);
        tr.appendChild(tplCell);

        for (const cell of row.cells) {
            const td = document.createElement('td');
            td.className = 'tpv-cell';
            if (cell.matchedTemplateIds.length === 0) {
                td.classList.add('tpv-cell-na');
                td.textContent = '–';
                td.title = I18n.t('Template not assigned to this project');
            } else if (cell.worst === null) {
                td.classList.add('tpv-cell-ok');
                td.textContent = '✓';
                td.title = I18n.t('Compliant');
                td.addEventListener('click', () => this._onCellClick?.(cell.projectUnid));
            } else {
                td.classList.add(`tpv-cell-${cell.worst}`);
                td.textContent = `${cell.findingCount}`;
                td.title = I18n.t('{n} finding(s) – click to inspect', {n: cell.findingCount});
                td.addEventListener('click', () => this._onCellClick?.(cell.projectUnid));
            }
            tr.appendChild(td);
        }

        return tr;
    }
}