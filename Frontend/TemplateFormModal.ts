import {ApiTemplateBody, ApiTemplateMutationResponse, ApiTemplateSummary} from '../Api/ApiTypes.js';
import {I18n} from './I18n.js';

type Mode = {kind: 'add'} | {kind: 'edit'; id: string};

type Tab = 'general'|'packages'|'forbidden'|'root'|'files';

type Bucket = 'runtime'|'dev'|'peer'|'optional';

type PkgRow = {name: string; version: string; required: boolean};

type FileRow = {path: string; mode: 'create'|'merge-json'|'report-only'};

/**
 * CRUD form for a single template. Tabbed layout — General /
 * Packages / Forbidden / Root / Files — saves via POST or PUT to
 * `/api/templates`. The `files` tab is read-only metadata
 * (path + mode) per the design decision E: file content stays on
 * disk under `nppm-templates/<id>/files/<path>`. The user edits
 * file bodies with their normal editor; the form just tracks
 * which files are declared.
 *
 * Re-uses the `umd-*` modal shell + `sm-*` tab CSS from
 * SettingsModal for visual consistency. Field-specific styling
 * uses a `tfm-*` namespace.
 */
export class TemplateFormModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _mode: Mode = {kind: 'add'};
    private _activeTab: Tab = 'general';
    private _body: ApiTemplateBody = {id: '', mode: 'additive'};
    private _allTemplates: string[] = [];
    private _onSaved: ((tpl: ApiTemplateSummary) => void)|null = null;

    public onSaved(handler: (tpl: ApiTemplateSummary) => void): void {
        this._onSaved = handler;
    }

    public async open(mode: Mode, allTemplates: string[]): Promise<void> {
        this._mode = mode;
        this._allTemplates = allTemplates;
        if (mode.kind === 'add') {
            this._body = {id: '', mode: 'additive'};
        } else {
            this._body = await TemplateFormModal._loadTemplate(mode.id);
        }
        this._activeTab = 'general';
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
        panel.className = 'umd-panel sm-panel';
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
        this._panel.appendChild(this._renderTabs());

        const body = document.createElement('div');
        body.className = 'sm-body';
        this._panel.appendChild(body);
        this._renderTab(body);

        const actions = document.createElement('div');
        actions.className = 'umd-actions';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'umd-btn umd-btn-primary';
        save.textContent = I18n.t('Save');
        save.addEventListener('click', () => void this._submit());
        actions.appendChild(save);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Cancel');
        cancel.addEventListener('click', () => this.close());
        actions.appendChild(cancel);
        this._panel.appendChild(actions);
    }

    private _renderHeader(): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = this._mode.kind === 'add'
            ? I18n.t('Add template')
            : I18n.t('Edit template: {id}', {id: this._mode.id});
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

    private _renderTabs(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'sm-tabs';
        const tabs: {id: Tab; label: string}[] = [
            {id: 'general', label: I18n.t('General')},
            {id: 'packages', label: I18n.t('Packages')},
            {id: 'forbidden', label: I18n.t('Forbidden')},
            {id: 'root', label: I18n.t('Root')},
            {id: 'files', label: I18n.t('Files')}
        ];
        for (const tab of tabs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sm-tab';
            btn.textContent = tab.label;
            if (tab.id === this._activeTab) {
                btn.classList.add('sm-tab-active');
            }
            btn.addEventListener('click', () => {
                this._collectActiveTab();
                this._activeTab = tab.id;
                this._render();
            });
            bar.appendChild(btn);
        }
        return bar;
    }

    private _renderTab(body: HTMLElement): void {
        switch (this._activeTab) {
            case 'general':
                this._renderGeneral(body);
                return;
            case 'packages':
                this._renderPackages(body);
                return;
            case 'forbidden':
                this._renderForbidden(body);
                return;
            case 'root':
                this._renderRoot(body);
                return;
            case 'files':
                this._renderFiles(body);
                return;
        }
    }

    private _renderGeneral(body: HTMLElement): void {
        body.appendChild(this._textField('tfm-id', I18n.t('Id'), this._body.id ?? '', 'backend-2026'));
        if (this._mode.kind === 'edit') {
            const note = document.createElement('div');
            note.className = 'umd-note';
            note.textContent = I18n.t('Id cannot be renamed via edit. Delete + recreate to change the id.');
            body.appendChild(note);
            const idInput = body.querySelector<HTMLInputElement>('.tfm-id');
            if (idInput) {
                idInput.readOnly = true;
            }
        }
        body.appendChild(this._textField('tfm-name', I18n.t('Name'), this._body.name ?? '', 'Backend Standard 2026'));
        body.appendChild(this._selectField(
            'tfm-mode',
            I18n.t('Mode'),
            this._body.mode ?? 'additive',
            [
                {value: 'additive', label: 'additive'},
                {value: 'strict', label: 'strict'}
            ]
        ));
        body.appendChild(this._multiSelectField(
            'tfm-extends',
            I18n.t('Extends (parent templates, in order)'),
            this._body.extends ?? [],
            this._allTemplates.filter((id) => id !== (this._body.id ?? ''))
        ));
    }

    private _renderPackages(body: HTMLElement): void {
        for (const bucket of ['runtime', 'dev', 'peer', 'optional'] as const) {
            body.appendChild(this._renderBucketSection(bucket));
        }
    }

    private _renderBucketSection(bucket: Bucket): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'tfm-bucket';
        const head = document.createElement('div');
        head.className = 'umd-section-head';
        head.textContent = bucket;
        wrap.appendChild(head);
        const list = document.createElement('div');
        list.className = 'tfm-rows';
        list.dataset.bucket = bucket;
        const existing = TemplateFormModal._rowsFromBody(this._body, bucket);
        for (const r of existing) {
            list.appendChild(this._renderPkgRow(bucket, r));
        }
        wrap.appendChild(list);
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'umd-btn tfm-addrow';
        add.textContent = I18n.t('+ Add package');
        add.addEventListener('click', () => {
            list.appendChild(this._renderPkgRow(bucket, {name: '', version: '', required: false}));
        });
        wrap.appendChild(add);
        return wrap;
    }

    private _renderPkgRow(bucket: Bucket, row: PkgRow): HTMLElement {
        const r = document.createElement('div');
        r.className = 'tfm-pkgrow';
        r.dataset.bucket = bucket;
        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'tfm-pkgname pfm-input';
        name.value = row.name;
        name.placeholder = 'name';
        r.appendChild(name);
        const ver = document.createElement('input');
        ver.type = 'text';
        ver.className = 'tfm-pkgver pfm-input';
        ver.value = row.version;
        ver.placeholder = '^1.2.3 (optional)';
        r.appendChild(ver);
        const req = document.createElement('label');
        req.className = 'tfm-req';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tfm-pkgreq';
        cb.checked = row.required;
        req.appendChild(cb);
        const span = document.createElement('span');
        span.textContent = I18n.t('required');
        req.appendChild(span);
        r.appendChild(req);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'umd-btn tfm-rowdel';
        del.textContent = '×';
        del.title = I18n.t('Remove');
        del.addEventListener('click', () => r.remove());
        r.appendChild(del);
        return r;
    }

    private _renderForbidden(body: HTMLElement): void {
        body.appendChild(this._textareaField(
            'tfm-forbidden',
            I18n.t('Forbidden packages (one per line)'),
            (this._body.forbidden ?? []).join('\n')
        ));
    }

    private _renderRoot(body: HTMLElement): void {
        const r = this._body.root ?? {};
        body.appendChild(this._textareaField(
            'tfm-engines',
            I18n.t('engines (KEY=VALUE per line)'),
            TemplateFormModal._mapToLines(r.engines)
        ));
        body.appendChild(this._textareaField(
            'tfm-scripts',
            I18n.t('scripts (KEY=VALUE per line)'),
            TemplateFormModal._mapToLines(r.scripts)
        ));
        body.appendChild(this._selectField(
            'tfm-private',
            I18n.t('private'),
            r.private === undefined ? '' : String(r.private),
            [
                {value: '', label: I18n.t('(do not enforce)')},
                {value: 'true', label: 'true'},
                {value: 'false', label: 'false'}
            ]
        ));
        body.appendChild(this._textField('tfm-type', I18n.t('type'), r.type ?? '', 'module'));
        body.appendChild(this._textField('tfm-pm', I18n.t('packageManager'), r.packageManager ?? '', 'npm@10'));
    }

    private _renderFiles(body: HTMLElement): void {
        const note = document.createElement('div');
        note.className = 'umd-note';
        note.textContent = I18n.t('File content lives on disk at nppm-templates/<id>/files/<path>. Edit it with your normal editor; this form only tracks declared files.');
        body.appendChild(note);
        const list = document.createElement('div');
        list.className = 'tfm-rows';
        list.dataset.bucket = 'files';
        const files = this._body.files ?? [];
        for (const f of files) {
            list.appendChild(this._renderFileRow({path: f.path, mode: f.mode ?? 'create'}));
        }
        body.appendChild(list);
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'umd-btn tfm-addrow';
        add.textContent = I18n.t('+ Add file');
        add.addEventListener('click', () => {
            list.appendChild(this._renderFileRow({path: '', mode: 'create'}));
        });
        body.appendChild(add);
    }

    private _renderFileRow(row: FileRow): HTMLElement {
        const r = document.createElement('div');
        r.className = 'tfm-filerow';
        const p = document.createElement('input');
        p.type = 'text';
        p.className = 'tfm-fpath pfm-input';
        p.value = row.path;
        p.placeholder = '.eslintrc.json';
        r.appendChild(p);
        const sel = document.createElement('select');
        sel.className = 'tfm-fmode pfm-input';
        for (const m of ['create', 'merge-json', 'report-only'] as const) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === row.mode) {
                opt.selected = true;
            }
            sel.appendChild(opt);
        }
        r.appendChild(sel);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'umd-btn tfm-rowdel';
        del.textContent = '×';
        del.title = I18n.t('Remove');
        del.addEventListener('click', () => r.remove());
        r.appendChild(del);
        return r;
    }

    private _textField(cls: string, label: string, value: string, placeholder: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = label;
        row.appendChild(lab);
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = `${cls} pfm-input`;
        inp.value = value;
        inp.placeholder = placeholder;
        row.appendChild(inp);
        return row;
    }

    private _selectField(
        cls: string,
        label: string,
        value: string,
        options: {value: string; label: string}[]
    ): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = label;
        row.appendChild(lab);
        const sel = document.createElement('select');
        sel.className = `${cls} pfm-input`;
        for (const opt of options) {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (opt.value === value) {
                o.selected = true;
            }
            sel.appendChild(o);
        }
        row.appendChild(sel);
        return row;
    }

    /**
     * Multi-line free-text alternative to a true multi-select —
     * cheap to render and edit, and `extends` rarely has more than a
     * couple of entries. One id per line; empty lines stripped on
     * collect.
     */
    private _multiSelectField(cls: string, label: string, current: string[], _options: string[]): HTMLElement {
        return this._textareaField(cls, label, current.join('\n'));
    }

    private _textareaField(cls: string, label: string, value: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = label;
        row.appendChild(lab);
        const ta = document.createElement('textarea');
        ta.className = `${cls} pfm-input sm-textarea`;
        ta.value = value;
        ta.rows = 4;
        row.appendChild(ta);
        return row;
    }

    private _collectActiveTab(): void {
        if (!this._panel) {
            return;
        }
        switch (this._activeTab) {
            case 'general':
                this._collectGeneral();
                return;
            case 'packages':
                this._collectPackages();
                return;
            case 'forbidden':
                this._collectForbidden();
                return;
            case 'root':
                this._collectRoot();
                return;
            case 'files':
                this._collectFiles();
                return;
        }
    }

    private _collectGeneral(): void {
        const id = this._strVal('.tfm-id');
        const name = this._strVal('.tfm-name');
        const mode = this._strVal('.tfm-mode');
        const ext = this._linesVal('.tfm-extends');
        if (this._mode.kind === 'add') {
            this._body.id = id ?? '';
        }
        this._body.name = name;
        this._body.mode = mode === 'strict' ? 'strict' : 'additive';
        this._body.extends = ext.length > 0 ? ext : undefined;
    }

    private _collectPackages(): void {
        const packages: ApiTemplateBody['packages'] = {};
        if (!this._panel) {
            return;
        }
        for (const bucket of ['runtime', 'dev', 'peer', 'optional'] as const) {
            const rows = Array.from(this._panel.querySelectorAll(`.tfm-pkgrow[data-bucket="${bucket}"]`)) as HTMLElement[];
            const out: Record<string, {version?: string; required?: boolean}> = {};
            for (const r of rows) {
                const name = (r.querySelector('.tfm-pkgname') as HTMLInputElement|null)?.value.trim() ?? '';
                const version = (r.querySelector('.tfm-pkgver') as HTMLInputElement|null)?.value.trim() ?? '';
                const required = (r.querySelector('.tfm-pkgreq') as HTMLInputElement|null)?.checked === true;
                if (name.length === 0) {
                    continue;
                }
                const entry: {version?: string; required?: boolean} = {};
                if (version.length > 0) {
                    entry.version = version;
                }
                if (required) {
                    entry.required = true;
                }
                out[name] = entry;
            }
            if (Object.keys(out).length > 0) {
                packages[bucket] = out;
            }
        }
        this._body.packages = Object.keys(packages).length > 0 ? packages : undefined;
    }

    private _collectForbidden(): void {
        const v = this._linesVal('.tfm-forbidden');
        this._body.forbidden = v.length > 0 ? v : undefined;
    }

    private _collectRoot(): void {
        const root: NonNullable<ApiTemplateBody['root']> = {};
        const engines = TemplateFormModal._linesToMap(this._strVal('.tfm-engines') ?? '');
        const scripts = TemplateFormModal._linesToMap(this._strVal('.tfm-scripts') ?? '');
        if (Object.keys(engines).length > 0) {
            root.engines = engines;
        }
        if (Object.keys(scripts).length > 0) {
            root.scripts = scripts;
        }
        const priv = this._strVal('.tfm-private');
        if (priv === 'true') {
            root.private = true;
        } else if (priv === 'false') {
            root.private = false;
        }
        const t = this._strVal('.tfm-type');
        if (t) {
            root.type = t;
        }
        const pm = this._strVal('.tfm-pm');
        if (pm) {
            root.packageManager = pm;
        }
        this._body.root = Object.keys(root).length > 0 ? root : undefined;
    }

    private _collectFiles(): void {
        if (!this._panel) {
            return;
        }
        const rows = Array.from(this._panel.querySelectorAll('.tfm-filerow')) as HTMLElement[];
        const files: NonNullable<ApiTemplateBody['files']> = [];
        for (const r of rows) {
            const p = (r.querySelector('.tfm-fpath') as HTMLInputElement|null)?.value.trim() ?? '';
            if (p.length === 0) {
                continue;
            }
            const mode = ((r.querySelector('.tfm-fmode') as HTMLSelectElement|null)?.value ?? 'create') as 'create'|'merge-json'|'report-only';
            files.push({path: p, mode});
        }
        this._body.files = files.length > 0 ? files : undefined;
    }

    private _strVal(sel: string): string|undefined {
        const el = this._panel?.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(sel);
        const v = el?.value.trim();
        return v && v.length > 0 ? v : undefined;
    }

    private _linesVal(sel: string): string[] {
        const el = this._panel?.querySelector<HTMLTextAreaElement>(sel);
        const raw = el?.value ?? '';
        return raw.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    }

    private async _submit(): Promise<void> {
        this._collectActiveTab();
        if (!this._body.id || this._body.id.length === 0) {
            this._renderError(I18n.t('Id is required'));
            return;
        }
        try {
            const endpoint = this._mode.kind === 'add'
                ? '/api/templates'
                : `/api/templates/${encodeURIComponent(this._mode.id)}`;
            const res = await fetch(endpoint, {
                method: this._mode.kind === 'add' ? 'POST' : 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(this._body)
            });
            if (!res.ok) {
                this._renderError(`HTTP ${res.status} — ${await res.text()}`);
                return;
            }
            const data = await res.json() as ApiTemplateMutationResponse;
            if (!data.success || !data.template) {
                this._renderError(data.msg ?? 'unknown error');
                return;
            }
            this._onSaved?.(data.template);
            this.close();
        } catch (e) {
            this._renderError((e as Error).message);
        }
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

    private static async _loadTemplate(id: string): Promise<ApiTemplateBody> {
        const res = await fetch(`/api/templates/${encodeURIComponent(id)}`);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} — ${await res.text()}`);
        }
        return await res.json() as ApiTemplateBody;
    }

    private static _rowsFromBody(body: ApiTemplateBody, bucket: Bucket): PkgRow[] {
        const pkgs = body.packages?.[bucket] ?? {};
        return Object.entries(pkgs).map(([name, req]) => ({
            name,
            version: req.version ?? '',
            required: req.required === true
        }));
    }

    private static _mapToLines(m: Record<string, string>|undefined): string {
        if (!m) {
            return '';
        }
        return Object.entries(m).map(([k, v]) => `${k}=${v}`).join('\n');
    }

    private static _linesToMap(raw: string): Record<string, string> {
        const out: Record<string, string> = {};
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                continue;
            }
            const eq = trimmed.indexOf('=');
            if (eq < 0) {
                continue;
            }
            const k = trimmed.slice(0, eq).trim();
            const v = trimmed.slice(eq + 1).trim();
            if (k.length > 0) {
                out[k] = v;
            }
        }
        return out;
    }
}