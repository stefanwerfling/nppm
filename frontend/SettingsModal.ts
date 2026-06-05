import {
    ApiConfigMutationRequest,
    ApiConfigMutationResponse,
    ApiConfigResponse,
    ApiConfigSettings
} from '../shared/Api/ApiTypes.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';

type TabId = 'general'|'registry'|'actions'|'security';

const EDITOR_KEYS: readonly string[] = [
    'vscode',
    'vscodium',
    'cursor',
    'phpstorm',
    'webstorm',
    'idea',
    'subl'
];

/**
 * Modal dialog for editing the non-`projects` sections of `nppm.json`.
 * Loads the current config from `GET /api/config` on open and writes
 * it back via `PUT /api/config` on save. Re-uses the `umd-*` modal
 * shell for visual consistency with the other modals; tab navigation
 * + form fields use their own `sm-*` class namespace.
 *
 * Most changes only take effect after a dev-server restart (port,
 * registry URL, cache, security thresholds) — the modal surfaces a
 * heads-up below the actions row so the user knows to bounce `npm
 * run dev` for the new value to apply.
 */
export class SettingsModal {
    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _activeTab: TabId = 'general';
    private _current: ApiConfigSettings = {};

    public open(): void {
        this._mount();
        void this._load();
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

        this._panel.appendChild(this._renderHeader());
        const loading = document.createElement('div');
        loading.className = 'umd-loading';
        loading.textContent = I18n.t('Loading settings …');
        this._panel.appendChild(loading);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    private async _load(): Promise<void> {
        try {
            const res = await fetch('/api/config');
            if (!res.ok) {
                this._renderError(`HTTP ${res.status} — ${await res.text()}`);
                return;
            }
            this._current = await res.json() as ApiConfigResponse;
        } catch (e) {
            this._renderError((e as Error).message);
            return;
        }
        this._render();
    }

    private _renderHeader(): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = I18n.t('Settings');
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

        const hint = document.createElement('div');
        hint.className = 'umd-note';
        hint.textContent = I18n.t(
            'Most settings only take effect after restarting the dev server.'
        );
        this._panel.appendChild(hint);

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

    private _renderTabs(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'sm-tabs';
        const tabs: {id: TabId; label: string}[] = [
            {id: 'general', label: I18n.t('General')},
            {id: 'registry', label: I18n.t('Registry')},
            {id: 'actions', label: I18n.t('Actions')},
            {id: 'security', label: I18n.t('Security')}
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
            case 'registry':
                this._renderRegistry(body);
                return;
            case 'actions':
                this._renderActions(body);
                return;
            case 'security':
                this._renderSecurity(body);
                return;
        }
    }

    private _renderGeneral(body: HTMLElement): void {
        const s = this._current.server ?? {};
        const c = this._current.cache ?? {};
        const b = this._current.browser ?? {};
        const u = this._current.ui ?? {};
        body.appendChild(this._sectionHead(I18n.t('Server')));
        body.appendChild(this._numberField('sm-port', I18n.t('Port'), s.port, '5190'));
        body.appendChild(this._textField('sm-limit', I18n.t('Body size limit'), s.limit, '10mb'));
        body.appendChild(this._sectionHead(I18n.t('Browser')));
        body.appendChild(this._checkboxField('sm-open', I18n.t('Open browser on dev start'), b.open === true));
        body.appendChild(this._sectionHead(I18n.t('User interface')));
        body.appendChild(this._selectField(
            'sm-startview',
            I18n.t('Start page'),
            u.startView === 'dashboard' ? 'dashboard' : 'matrix',
            [
                {value: 'matrix', label: I18n.t('Matrix')},
                {value: 'dashboard', label: I18n.t('Dashboard')}
            ]
        ));
        body.appendChild(this._sectionHead(I18n.t('Cache')));
        body.appendChild(this._textField('sm-cdir', I18n.t('Cache directory'), c.dir, '.nppm/cache'));
        body.appendChild(this._numberField('sm-cttl', I18n.t('Cache TTL (minutes)'), c.ttlMinutes, '60'));
        body.appendChild(this._cacheClearRow());
    }

    /**
     * "Clear cache now" row in the Cache section. Wipes every file in
     * the on-disk cache (registry / fingerprint / releases / OSV /
     * bundlephobia / templates-remote / …) across all projects so the
     * next scan rebuilds against fresh registry data. `.nppm/history/`
     * is preserved — it's the user's audit log, not a cache.
     */
    private _cacheClearRow(): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row sm-cache-clear';

        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = I18n.t('Rebuild cache');
        row.appendChild(lab);

        const right = document.createElement('div');
        right.className = 'sm-cache-clear-right';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'umd-btn';
        btn.textContent = I18n.t('Clear cache now');
        right.appendChild(btn);

        const status = document.createElement('span');
        status.className = 'sm-cache-clear-status';
        status.textContent = I18n.t(
            'Wipes every cache pocket across all projects. History (.nppm/history/) is kept.'
        );
        right.appendChild(status);

        btn.addEventListener('click', () => {
            void this._clearAndRebuild(btn, status);
        });

        row.appendChild(right);
        return row;
    }

    /**
     * Click handler for the "Clear cache now" button. Three phases:
     *   1. POST /api/cache/clear — wipe every cache file
     *   2. GET /api/matrix — re-walk every project + warm the
     *      registry/bundle/integrity caches
     *   3. SSE /api/lockfile/analyze-all — re-warm the OSV cache for
     *      every unique `name@version` across all projects
     * Phases 2 + 3 are best-effort: a network blip during rebuild
     * doesn't surface as an error to the user because the clear
     * itself already succeeded. Fingerprint + heuristic caches are
     * deliberately not pre-warmed (slow tarball downloads — they
     * fill in lazily as the user opens matrix cells).
     */
    private async _clearAndRebuild(btn: HTMLButtonElement, status: HTMLElement): Promise<void> {
        btn.disabled = true;
        status.textContent = I18n.t('Clearing cache …');

        let cleared = 0;
        try {
            const out = await Api.clearCache();
            cleared = out.removed;
        } catch (e) {
            status.textContent = (e as Error).message;
            btn.disabled = false;
            return;
        }

        status.textContent = I18n.t('Cache cleared ({n} files). Warming registry …', {n: String(cleared)});
        try {
            await fetch('/api/matrix', {cache: 'no-store'});
        } catch {
            // Best-effort — proceed to OSV warmup regardless.
        }

        status.textContent = I18n.t('Cache cleared ({n} files). Re-running OSV scan …', {n: String(cleared)});
        await new Promise<void>((resolve) => {
            const es = new EventSource('/api/lockfile/analyze-all');
            let progress = 0;
            es.addEventListener('progress', () => {
                progress++;
                if (progress % 25 === 0) {
                    status.textContent = I18n.t('Cache cleared ({n} files). Re-running OSV scan ({p} done) …', {
                        n: String(cleared),
                        p: String(progress)
                    });
                }
            });
            es.addEventListener('end', () => {
                es.close();
                resolve();
            });
            es.addEventListener('error', () => {
                // Connection drop or end-of-stream. Treat both as
                // "done with whatever we got".
                es.close();
                resolve();
            });
        });

        status.textContent = I18n.t(
            'Cache rebuilt — {n} file(s) cleared, registry + OSV re-warmed across all projects.',
            {n: String(cleared)}
        );
        btn.disabled = false;
    }

    private _renderRegistry(body: HTMLElement): void {
        const r = this._current.registry ?? {};
        body.appendChild(this._sectionHead(I18n.t('Registry')));
        body.appendChild(this._textField('sm-rurl', I18n.t('Registry URL'), r.url, 'https://registry.npmjs.org'));
        body.appendChild(this._textField('sm-rauth', I18n.t('Bearer token ($ENV_VAR supported)'), r.auth, '$NPM_TOKEN'));
    }

    private _renderActions(body: HTMLElement): void {
        const a = this._current.actions ?? {};
        body.appendChild(this._sectionHead(I18n.t('Actions')));
        body.appendChild(this._checkboxField(
            'sm-allow',
            I18n.t('Allow install + lifecycle scripts (npm install / npm rebuild)'),
            a.allowInstall === true
        ));
        body.appendChild(this._selectField(
            'sm-editor',
            I18n.t('Open-in-IDE editor'),
            a.editor ?? '',
            [
                {value: '', label: I18n.t('(none)')},
                ...EDITOR_KEYS.map((k) => ({value: k, label: k}))
            ]
        ));
    }

    private _renderSecurity(body: HTMLElement): void {
        const m = this._current.security?.maintainer ?? {};
        const l = this._current.security?.license ?? {};
        const u = this._current.security?.unused ?? {};
        const e = this._current.security?.external ?? {};
        body.appendChild(this._sectionHead(I18n.t('Maintainer handover thresholds (days)')));
        body.appendChild(this._numberField('sm-mqh', I18n.t('Quick handover (risk if ≤)'), m.quickHandoverDays, '14'));
        body.appendChild(this._numberField('sm-msg', I18n.t('Suspicious gap (warn if ≤)'), m.suspiciousGapDays, '90'));
        body.appendChild(this._numberField('sm-mmv', I18n.t('Mature versions (minimum predecessors)'), m.matureVersions, '5'));
        body.appendChild(this._numberField('sm-mtw', I18n.t('Trust window (recent versions inspected)'), m.trustWindow, '30'));

        body.appendChild(this._sectionHead(I18n.t('License policy')));
        body.appendChild(this._textareaField('sm-lal', I18n.t('Allowlist (one SPDX id per line, * wildcard ok)'), (l.allowlist ?? []).join('\n')));
        body.appendChild(this._textareaField('sm-ldl', I18n.t('Denylist (one SPDX id per line, * wildcard ok)'), (l.denylist ?? []).join('\n')));
        body.appendChild(this._selectField('sm-ltu', I18n.t('Treat unknown licenses as'), l.treatUnknownAs ?? '', [
            {value: '', label: I18n.t('(default: unknown)')},
            {value: 'permissive', label: 'permissive'},
            {value: 'weak-copyleft', label: 'weak-copyleft'},
            {value: 'strong-copyleft', label: 'strong-copyleft'},
            {value: 'proprietary', label: 'proprietary'},
            {value: 'unknown', label: 'unknown'}
        ]));

        body.appendChild(this._sectionHead(I18n.t('Unused-deps detector')));
        body.appendChild(this._textareaField('sm-ual', I18n.t('Allowlist (one package name per line)'), (u.allowlist ?? []).join('\n')));
        body.appendChild(this._textareaField('sm-udp', I18n.t('Dev path globs (one per line, replaces defaults)'), (u.devPathGlobs ?? []).join('\n')));

        body.appendChild(this._sectionHead(I18n.t('External reputation sources')));
        // The master switch defaults to "on" — leaving it unchecked
        // here means the user explicitly turned every source off; the
        // backend then short-circuits the scanner without making any
        // network calls.
        body.appendChild(this._checkboxField('sm-ext-en', I18n.t('Enable external sources'), e.enabled !== false));
        body.appendChild(this._checkboxField('sm-ext-socket-en', I18n.t('socket.dev (needs API key)'), e.socket?.enabled !== false));
        body.appendChild(this._textField('sm-ext-socket-key', I18n.t('socket.dev API key ($ENV ok)'), e.socket?.apiKey, '$SOCKET_DEV_API_KEY'));
        body.appendChild(this._checkboxField('sm-ext-openssf-en', I18n.t('OpenSSF Scorecard'), e.openssf?.enabled !== false));
        body.appendChild(this._checkboxField('sm-ext-depsdev-en', I18n.t('deps.dev (info only)'), e.depsDev?.enabled !== false));
    }

    private _sectionHead(label: string): HTMLElement {
        const h = document.createElement('div');
        h.className = 'umd-section-head';
        h.textContent = label;
        return h;
    }

    private _textField(cls: string, label: string, value: string|undefined, placeholder: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = label;
        row.appendChild(lab);
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = `${cls} pfm-input`;
        inp.value = value ?? '';
        inp.placeholder = placeholder;
        row.appendChild(inp);
        return row;
    }

    private _numberField(cls: string, label: string, value: number|undefined, placeholder: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row';
        const lab = document.createElement('label');
        lab.className = 'pfm-label';
        lab.textContent = label;
        row.appendChild(lab);
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = `${cls} pfm-input`;
        inp.value = value === undefined ? '' : String(value);
        inp.placeholder = placeholder;
        row.appendChild(inp);
        return row;
    }

    private _checkboxField(cls: string, label: string, checked: boolean): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pfm-row sm-checkbox-row';
        const wrap = document.createElement('label');
        wrap.className = 'sm-checkbox-label';
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.className = cls;
        inp.checked = checked;
        wrap.appendChild(inp);
        const span = document.createElement('span');
        span.textContent = label;
        wrap.appendChild(span);
        row.appendChild(wrap);
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
        ta.rows = 3;
        row.appendChild(ta);
        return row;
    }

    /**
     * Read values off the currently-mounted tab back into `_current`
     * so tab switches don't lose user edits. Each tab pulls its own
     * field subset; absent fields (other tab is mounted) are left
     * alone.
     */
    private _collectActiveTab(): void {
        if (!this._panel) {
            return;
        }
        switch (this._activeTab) {
            case 'general':
                this._collectGeneral();
                return;
            case 'registry':
                this._collectRegistry();
                return;
            case 'actions':
                this._collectActions();
                return;
            case 'security':
                this._collectSecurity();
                return;
        }
    }

    private _collectGeneral(): void {
        const port = this._numVal('.sm-port');
        const limit = this._strVal('.sm-limit');
        const open = this._boolVal('.sm-open');
        const startView = this._strVal('.sm-startview');
        const cdir = this._strVal('.sm-cdir');
        const cttl = this._numVal('.sm-cttl');
        const server: NonNullable<ApiConfigSettings['server']> = {};
        if (port !== undefined) {
            server.port = port;
        }
        if (limit !== undefined) {
            server.limit = limit;
        }
        this._current.server = Object.keys(server).length > 0 ? server : undefined;

        // Browser: persist `{open: true|false}` only when the user
        // toggled it on; if false we drop the section so disk shape
        // stays minimal.
        this._current.browser = open ? {open: true} : undefined;

        // UI: only persist `startView` when the user picked the
        // non-default (dashboard). The matrix fallback is implicit in
        // `Nppm.start()` so an empty `ui` section keeps the existing
        // landing behaviour.
        this._current.ui = startView === 'dashboard' ? {startView} : undefined;

        const cache: NonNullable<ApiConfigSettings['cache']> = {};
        if (cdir !== undefined) {
            cache.dir = cdir;
        }
        if (cttl !== undefined) {
            cache.ttlMinutes = cttl;
        }
        this._current.cache = Object.keys(cache).length > 0 ? cache : undefined;
    }

    private _collectRegistry(): void {
        const url = this._strVal('.sm-rurl');
        const auth = this._strVal('.sm-rauth');
        const reg: NonNullable<ApiConfigSettings['registry']> = {};
        if (url !== undefined) {
            reg.url = url;
        }
        if (auth !== undefined) {
            reg.auth = auth;
        }
        this._current.registry = Object.keys(reg).length > 0 ? reg : undefined;
    }

    private _collectActions(): void {
        const allow = this._boolVal('.sm-allow');
        const editor = this._strVal('.sm-editor');
        const act: NonNullable<ApiConfigSettings['actions']> = {};
        if (allow) {
            act.allowInstall = true;
        }
        if (editor !== undefined) {
            act.editor = editor;
        }
        this._current.actions = Object.keys(act).length > 0 ? act : undefined;
    }

    private _collectSecurity(): void {
        const mqh = this._numVal('.sm-mqh');
        const msg = this._numVal('.sm-msg');
        const mmv = this._numVal('.sm-mmv');
        const mtw = this._numVal('.sm-mtw');
        const lal = this._linesVal('.sm-lal');
        const ldl = this._linesVal('.sm-ldl');
        const ltu = this._strVal('.sm-ltu');
        const ual = this._linesVal('.sm-ual');
        const udp = this._linesVal('.sm-udp');

        const sec: NonNullable<ApiConfigSettings['security']> = {};
        const maintainer: NonNullable<NonNullable<ApiConfigSettings['security']>['maintainer']> = {};
        if (mqh !== undefined) {
            maintainer.quickHandoverDays = mqh;
        }
        if (msg !== undefined) {
            maintainer.suspiciousGapDays = msg;
        }
        if (mmv !== undefined) {
            maintainer.matureVersions = mmv;
        }
        if (mtw !== undefined) {
            maintainer.trustWindow = mtw;
        }
        if (Object.keys(maintainer).length > 0) {
            sec.maintainer = maintainer;
        }

        const license: NonNullable<NonNullable<ApiConfigSettings['security']>['license']> = {};
        if (lal.length > 0) {
            license.allowlist = lal;
        }
        if (ldl.length > 0) {
            license.denylist = ldl;
        }
        if (ltu !== undefined) {
            license.treatUnknownAs = ltu;
        }
        if (Object.keys(license).length > 0) {
            sec.license = license;
        }

        const unused: NonNullable<NonNullable<ApiConfigSettings['security']>['unused']> = {};
        if (ual.length > 0) {
            unused.allowlist = ual;
        }
        if (udp.length > 0) {
            unused.devPathGlobs = udp;
        }
        if (Object.keys(unused).length > 0) {
            sec.unused = unused;
        }

        // External-sources: each checkbox tracks an explicit boolean
        // (default-on) so the persisted value distinguishes "left
        // default" (omit) from "deliberately disabled" (false). The
        // API-key field is optional; falsy values stay absent.
        const ext: NonNullable<NonNullable<ApiConfigSettings['security']>['external']> = {};
        const extEnableEl = this._panel?.querySelector<HTMLInputElement>('.sm-ext-en');
        if (extEnableEl && extEnableEl.checked === false) {
            ext.enabled = false;
        }
        const socket: NonNullable<NonNullable<NonNullable<ApiConfigSettings['security']>['external']>['socket']> = {};
        const socketEnEl = this._panel?.querySelector<HTMLInputElement>('.sm-ext-socket-en');
        if (socketEnEl && socketEnEl.checked === false) {
            socket.enabled = false;
        }
        const socketKey = this._strVal('.sm-ext-socket-key');
        if (socketKey !== undefined) {
            socket.apiKey = socketKey;
        }
        if (Object.keys(socket).length > 0) {
            ext.socket = socket;
        }
        const openssfEnEl = this._panel?.querySelector<HTMLInputElement>('.sm-ext-openssf-en');
        if (openssfEnEl && openssfEnEl.checked === false) {
            ext.openssf = {enabled: false};
        }
        const depsDevEnEl = this._panel?.querySelector<HTMLInputElement>('.sm-ext-depsdev-en');
        if (depsDevEnEl && depsDevEnEl.checked === false) {
            ext.depsDev = {enabled: false};
        }
        if (Object.keys(ext).length > 0) {
            sec.external = ext;
        }

        this._current.security = Object.keys(sec).length > 0 ? sec : undefined;
    }

    private _strVal(sel: string): string|undefined {
        const el = this._panel?.querySelector<HTMLInputElement|HTMLSelectElement>(sel);
        const v = el?.value.trim();
        return v && v.length > 0 ? v : undefined;
    }

    private _numVal(sel: string): number|undefined {
        const el = this._panel?.querySelector<HTMLInputElement>(sel);
        const v = el?.value.trim();
        if (!v || v.length === 0) {
            return undefined;
        }
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }

    private _boolVal(sel: string): boolean {
        const el = this._panel?.querySelector<HTMLInputElement>(sel);
        return el?.checked === true;
    }

    private _linesVal(sel: string): string[] {
        const el = this._panel?.querySelector<HTMLTextAreaElement>(sel);
        const raw = el?.value ?? '';
        return raw.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    }

    private async _submit(): Promise<void> {
        this._collectActiveTab();
        const body: ApiConfigMutationRequest = {
            server: this._current.server,
            browser: this._current.browser,
            registry: this._current.registry,
            cache: this._current.cache,
            actions: this._current.actions,
            security: this._current.security,
            ui: this._current.ui
        };
        // Drop undefined keys — the backend wipes any unmentioned
        // section anyway, but keeping the wire payload tight makes
        // server-side logs cleaner.
        for (const key of Object.keys(body) as (keyof ApiConfigMutationRequest)[]) {
            if (body[key] === undefined) {
                delete body[key];
            }
        }
        try {
            const res = await fetch('/api/config', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                this._renderError(`HTTP ${res.status} — ${await res.text()}`);
                return;
            }
            const data = await res.json() as ApiConfigMutationResponse;
            if (!data.success) {
                this._renderError(data.msg ?? 'unknown error');
                return;
            }
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
}