import {ApiTemplatesMatrixResponse, ApiTemplatesMatrixRow} from '../../shared/Api/ApiTypes.js';
import {Api} from '../Util/Api.js';
import {I18n} from '../Util/I18n.js';
import {TemplateFormModal} from '../Modals/TemplateFormModal.js';

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

    public constructor(root: HTMLElement) {
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
            modal.onSaved(() => {
                void this.show();
            });
            void modal.open({kind: 'add'}, data.rows.map((r) => r.template.id));
        });
        titleBar.appendChild(add);
        const addRemote = document.createElement('button');
        addRemote.type = 'button';
        addRemote.className = 'umd-btn tpv-add';
        addRemote.textContent = I18n.t('+ Add remote source');
        addRemote.addEventListener('click', () => this._openRemoteSourceModal());
        titleBar.appendChild(addRemote);
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

        /*
         * Project columns come from the first row's cells — same order
         * across every row (the backend iterates the projects map
         * identically).
         */
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
                modal.onSaved(() => {
                    void this.show();
                });
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
        if (row.template.runtimeCount > 0) {parts.push(`runtime ${row.template.runtimeCount}`);}
        if (row.template.devCount > 0) {parts.push(`dev ${row.template.devCount}`);}
        if (row.template.peerCount > 0) {parts.push(`peer ${row.template.peerCount}`);}
        if (row.template.optionalCount > 0) {parts.push(`opt ${row.template.optionalCount}`);}
        if (row.template.forbiddenCount > 0) {parts.push(`forbidden ${row.template.forbiddenCount}`);}
        if (row.template.hasRoot) {parts.push('root');}
        if (row.template.mode === 'strict') {parts.push('strict');}
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

    /**
     * Small URL-prompt modal triggered by "+ Add remote source".
     * Persists the URL to `templateSources` in nppm.json and asks
     * the loader to refresh — on success the templates matrix is
     * reloaded so the new entry shows up with its REMOTE badge.
     */
    private _openRemoteSourceModal(): void {
        const backdrop = document.createElement('div');
        backdrop.className = 'umd-backdrop';
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) {
                backdrop.remove();
            }
        });

        const panel = document.createElement('div');
        panel.className = 'umd-panel';
        panel.style.minWidth = '480px';
        backdrop.appendChild(panel);

        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = I18n.t('Add remote template source');
        head.appendChild(title);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'umd-close';
        close.textContent = '×';
        close.addEventListener('click', () => backdrop.remove());
        head.appendChild(close);
        panel.appendChild(head);

        const body = document.createElement('div');
        body.className = 'sm-body';
        const note = document.createElement('div');
        note.className = 'umd-note';
        note.textContent = I18n.t(
            'URL to a raw template.json file (http or https). Persists to templateSources in nppm.json.'
        );
        body.appendChild(note);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pfm-input';
        input.placeholder = 'https://raw.githubusercontent.com/owner/repo/main/template.json';
        body.appendChild(input);
        const status = document.createElement('div');
        status.className = 'sm-cache-clear-status';
        body.appendChild(status);
        panel.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'umd-actions';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'umd-btn umd-btn-primary';
        addBtn.textContent = I18n.t('Add');
        addBtn.addEventListener('click', async() => {
            const url = input.value.trim();
            if (!url) {
                status.textContent = I18n.t('URL is required');
                return;
            }
            addBtn.disabled = true;
            status.textContent = I18n.t('Fetching template …');
            try {
                const out = await Api.addTemplateSource(url);
                if (out.templateId) {
                    status.textContent = I18n.t('Added remote template: {id}', {id: out.templateId});
                } else {
                    status.textContent = I18n.t(
                        'URL stored, but the body did not load — check the file at the URL.'
                    );
                }
                window.setTimeout(() => {
                    backdrop.remove();
                    void this.show();
                }, 700);
            } catch (e) {
                status.textContent = (e as Error).message;
                addBtn.disabled = false;
            }
        });
        actions.appendChild(addBtn);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Cancel');
        cancel.addEventListener('click', () => backdrop.remove());
        actions.appendChild(cancel);
        panel.appendChild(actions);

        document.body.appendChild(backdrop);
        input.focus();
    }

}