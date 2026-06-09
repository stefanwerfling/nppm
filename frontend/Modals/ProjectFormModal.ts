import {ApiProject, ApiProjectMutationRequest, ApiProjectMutationResponse, ApiTemplateSummary} from '../../shared/Api/ApiTypes.js';
import {ConfigProjectType} from '../../backend/Config/Config.js';
import {Api} from '../Util/Api.js';
import {DirectoryPickerModal} from './DirectoryPickerModal.js';
import {I18n} from '../Util/I18n.js';

/**
 * What triggered the modal. `add` opens with empty fields;
 * `edit` pre-fills from the provided `ApiProject` (the form also
 * needs the type-specific fields, which the modal recovers via the
 * `existing` parameter — the backend's GET /api/projects already
 * returns enough metadata for `name`/`type`/`root`).
 */
export type ProjectFormMode =
    | {kind: 'add';}
    | {kind: 'edit'; project: ApiProject; extras: ApiProjectMutationRequest;};

/**
 * Modal form for adding or editing a project in `nppm.json`.
 * Renders a type selector + per-type field set; submitting fires
 * `POST /api/projects` (add) or `PUT /api/projects/:id` (edit) and
 * yields the resulting `ApiProject` to the caller via the
 * `onSaved` callback so the treeview / matrix can refresh.
 *
 * Re-uses the `umd-*` modal CSS for shell consistency with the
 * other modals (`UpgradeModal`, `WhyModal`).
 */
export class ProjectFormModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _mode: ProjectFormMode = {kind: 'add'};
    private _onSaved: ((project: ApiProject) => void)|null = null;

    public onSaved(handler: (project: ApiProject) => void): void {
        this._onSaved = handler;
    }

    public open(mode: ProjectFormMode): void {
        this._mode = mode;
        this._mount();
        this._render();
    }

    public close(): void {
        this._backdrop?.remove();
        this._backdrop = null;
        this._panel = null;
        document.removeEventListener('keydown', this._onKeyDown);
    }

    private _mount(): void {
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
        panel.className = 'umd-panel';
        backdrop.appendChild(panel);
        this._panel = panel;

        document.addEventListener('keydown', this._onKeyDown);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    private _render(): void {
        if (!this._panel) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());

        const initial = this._initialValues();
        const form = document.createElement('form');
        form.className = 'pfm-form';
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            void this._submit(form);
        });

        form.appendChild(this._renderTypeSelector(initial.type));
        form.appendChild(this._renderNameField(initial.name));
        form.appendChild(this._renderTypeFields(initial));
        const tplField = this._renderTemplatesField(initial.templates ?? []);
        form.appendChild(tplField);
        void this._loadTemplates(tplField, initial.templates ?? []);

        const actions = document.createElement('div');
        actions.className = 'umd-actions';

        const save = document.createElement('button');
        save.type = 'submit';
        save.className = 'umd-btn umd-btn-primary';
        save.textContent = I18n.t('Save');
        actions.appendChild(save);

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Cancel');
        cancel.addEventListener('click', () => this.close());
        actions.appendChild(cancel);

        form.appendChild(actions);

        this._panel.appendChild(form);
        // Re-render type-specific fields when the selector changes.
        const select = form.querySelector<HTMLSelectElement>('.pfm-type');
        select?.addEventListener('change', () => {
            const dyn = form.querySelector('.pfm-typefields');
            if (dyn && dyn.parentElement) {
                dyn.parentElement.replaceChild(
                    this._renderTypeFields({...this._readForm(form), type: select.value as ConfigProjectType}),
                    dyn
                );
            }
        });
    }

    private _renderHeader(): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';

        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = this._mode.kind === 'add'
            ? I18n.t('Add project')
            : I18n.t('Edit project: {name}', {name: this._mode.project.name});
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

    private _renderTypeSelector(current: ConfigProjectType): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';

        const label = document.createElement('label');
        label.className = 'pfm-label';
        label.textContent = I18n.t('Type');
        row.appendChild(label);

        const select = document.createElement('select');
        select.className = 'pfm-type pfm-input';
        for (const t of [ConfigProjectType.local, ConfigProjectType.github, ConfigProjectType.gitea]) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            if (t === current) {
                opt.selected = true;
            }
            select.appendChild(opt);
        }
        row.appendChild(select);

        return row;
    }

    private _renderNameField(current: string|undefined): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const label = document.createElement('label');
        label.className = 'pfm-label';
        label.textContent = I18n.t('Name (optional)');
        row.appendChild(label);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pfm-name pfm-input';
        input.value = current ?? '';
        input.placeholder = I18n.t('falls back to path basename / repo slug');
        row.appendChild(input);
        return row;
    }

    private _renderTypeFields(initial: ReturnType<ProjectFormModal['_initialValues']>): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pfm-typefields';

        if (initial.type === ConfigProjectType.local) {
            wrap.appendChild(this._pathFieldWithBrowse(initial.path ?? ''));
        } else if (initial.type === ConfigProjectType.github) {
            wrap.appendChild(this._field('pfm-repo', I18n.t('Repo (owner/name)'), initial.repo ?? '', 'OpenSourcePKG/nppm'));
            wrap.appendChild(this._field('pfm-ref', I18n.t('Ref (optional)'), initial.ref ?? '', 'main'));
            wrap.appendChild(this._field('pfm-token', I18n.t('Token (optional, $ENV_VAR supported)'), initial.token ?? '', '$GH_TOKEN'));
        } else if (initial.type === ConfigProjectType.gitea) {
            wrap.appendChild(this._field('pfm-url', I18n.t('Gitea repo URL'), initial.url ?? '', 'https://gitea.example.com/group/repo'));
            wrap.appendChild(this._field('pfm-ref', I18n.t('Ref (optional)'), initial.ref ?? '', 'main'));
            wrap.appendChild(this._field('pfm-token', I18n.t('Token (optional, $ENV_VAR supported)'), initial.token ?? '', '$GITEA_TOKEN'));
        }
        return wrap;
    }

    private _field(cls: string, label: string, value: string, placeholder: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = label;
        row.appendChild(lab);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = `${cls} pfm-input`;
        input.value = value;
        input.placeholder = placeholder;
        row.appendChild(input);
        return row;
    }

    /**
     * The `Path` field with a "Browse…" sibling button. The button
     * opens `DirectoryPickerModal` seeded with the current input
     * value (when set + valid on the backend); the picker writes
     * the picked absolute path straight back into the input on
     * select. Only used for `local`-type projects — remote sources
     * (github/gitea) have repo/url fields, not a filesystem path.
     */
    private _pathFieldWithBrowse(value: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = I18n.t('Path');
        row.appendChild(lab);

        const inputRow = document.createElement('div');
        inputRow.className = 'pfm-path-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pfm-path pfm-input';
        input.value = value;
        input.placeholder = I18n.t('absolute or relative to nppm.json');
        inputRow.appendChild(input);

        const browse = document.createElement('button');
        browse.type = 'button';
        browse.className = 'pfm-browse';
        browse.textContent = I18n.t('Browse …');
        browse.addEventListener('click', () => {
            const picker = new DirectoryPickerModal();
            picker.seedPath(input.value.trim() || undefined);
            picker.onPicked((p) => {
                input.value = p;
            });
            picker.open();
        });
        inputRow.appendChild(browse);

        row.appendChild(inputRow);
        return row;
    }

    /**
     * "Templates" pickbox row. Renders a loading placeholder
     * synchronously so the form layout is stable; the available
     * template ids are fetched asynchronously via `_loadTemplates`
     * and replace the placeholder when ready. The container keeps
     * the `pfm-templates` class throughout so `_readForm` can find
     * the checkboxes regardless of load state.
     */
    private _renderTemplatesField(_initial: string[]): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = I18n.t('Templates');
        row.appendChild(lab);

        const box = document.createElement('div');
        box.className = 'pfm-templates';
        const loading = document.createElement('div');
        loading.className = 'pfm-templates-loading';
        loading.textContent = I18n.t('Loading templates …');
        box.appendChild(loading);
        row.appendChild(box);

        return row;
    }

    private async _loadTemplates(field: HTMLElement, initial: string[]): Promise<void> {
        const box = field.querySelector<HTMLElement>('.pfm-templates');
        if (!box) {
            return;
        }
        try {
            const response = await Api.templates();
            box.replaceChildren();
            if (response.templates.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'pfm-templates-empty';
                empty.textContent = I18n.t('No templates configured yet.');
                box.appendChild(empty);
                return;
            }
            for (const t of response.templates) {
                box.appendChild(this._renderTemplateOption(t, initial.includes(t.id)));
            }
        } catch (e) {
            box.replaceChildren();
            const err = document.createElement('div');
            err.className = 'pfm-templates-empty';
            err.textContent = (e as Error).message;
            box.appendChild(err);
        }
    }

    private _renderTemplateOption(t: ApiTemplateSummary, checked: boolean): HTMLElement {
        const label = document.createElement('label');
        label.className = 'pfm-templates-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = t.id;
        cb.className = 'pfm-template-check';
        cb.checked = checked;
        label.appendChild(cb);
        const text = document.createElement('span');
        text.className = 'pfm-templates-name';
        text.textContent = t.name && t.name !== t.id ? `${t.id} — ${t.name}` : t.id;
        label.appendChild(text);
        if (t.source === 'remote') {
            const badge = document.createElement('span');
            badge.className = 'tpv-tpl-remote';
            badge.textContent = 'REMOTE';
            if (t.sourceUrl) {
                badge.title = t.sourceUrl;
            }
            label.appendChild(badge);
        }
        return label;
    }

    private _initialValues(): {
        type: ConfigProjectType;
        name?: string;
        path?: string;
        repo?: string;
        url?: string;
        ref?: string;
        token?: string;
        templates?: string[];
        } {
        if (this._mode.kind === 'add') {
            return {type: ConfigProjectType.local};
        }
        const {project, extras} = this._mode;
        return {
            type: project.type,
            name: extras.name,
            path: extras.path,
            repo: extras.repo,
            url: extras.url,
            ref: extras.ref,
            token: extras.token,
            templates: extras.templates
        };
    }

    /**
     * Pull current field values out of the form DOM. Returns a
     * partial mutation request — the submit path completes it with
     * the selected `type`.
     */
    private _readForm(form: HTMLFormElement): ApiProjectMutationRequest {
        const get = (sel: string): string|undefined => {
            const el = form.querySelector<HTMLInputElement>(sel);
            const v = el?.value.trim();
            return v && v.length > 0 ? v : undefined;
        };
        const type = (form.querySelector<HTMLSelectElement>('.pfm-type')?.value
            ?? ConfigProjectType.local) as ConfigProjectType;
        const templates: string[] = [];
        for (const cb of Array.from(form.querySelectorAll<HTMLInputElement>('.pfm-template-check'))) {
            if (cb.checked) {
                templates.push(cb.value);
            }
        }
        return {
            type: type,
            name: get('.pfm-name'),
            path: get('.pfm-path'),
            repo: get('.pfm-repo'),
            url: get('.pfm-url'),
            ref: get('.pfm-ref'),
            token: get('.pfm-token'),
            templates: templates.length > 0 ? templates : undefined
        };
    }

    private async _submit(form: HTMLFormElement): Promise<void> {
        const body = this._readForm(form);
        try {
            const res = await fetch(this._endpoint(), {
                method: this._mode.kind === 'add' ? 'POST' : 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                const text = await res.text();
                this._renderError(`HTTP ${res.status} — ${text}`);
                return;
            }
            const data = await res.json() as ApiProjectMutationResponse;
            if (!data.success || !data.project) {
                this._renderError(data.msg ?? 'unknown error');
                return;
            }
            this._onSaved?.(data.project);
            this.close();
        } catch (e) {
            this._renderError((e as Error).message);
        }
    }

    private _endpoint(): string {
        if (this._mode.kind === 'add') {
            return '/api/projects';
        }
        return `/api/projects/${this._mode.project.unid}`;
    }

    private _renderError(msg: string): void {
        if (!this._panel) {
            return;
        }
        const existing = this._panel.querySelector('.umd-error');
        existing?.remove();
        const err = document.createElement('div');
        err.className = 'umd-error';
        err.textContent = msg;
        this._panel.appendChild(err);
    }

}