import {ApiComplianceFinding, ApiComplianceResponse} from '../../shared/Api/ApiTypes.js';
import {ConfigProjectType} from '../../backend/Config/Config.js';
import {I18n} from '../I18n.js';
import {TemplateApplyModal} from '../Modals/TemplateApplyModal.js';

/**
 * Per-project right-pane tab showing the compliance diff against the
 * project's configured template chain. Reuses the `list-*` /
 * `installed-*` CSS for header consistency with the other right-pane
 * views; the table body uses a `tv-*` namespace.
 */
export class TemplateView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _projectType: ConfigProjectType = ConfigProjectType.local;
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowInstalled: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _onShowUnused: ((unid: string) => void)|null = null;
    private _onShowVulns: ((unid: string) => void)|null = null;
    private _onShowPr: ((unid: string) => void)|null = null;

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    public onShowDeclared(handler: (unid: string) => void): void {
        this._onShowDeclared = handler;
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

    public async show(unid: string, projectName: string, projectType: ConfigProjectType): Promise<void> {
        this._projectUnid = unid;
        this._projectName = projectName;
        this._projectType = projectType;
        this._renderLoading(projectName);
        try {
            const res = await fetch(`/api/projects/${encodeURIComponent(unid)}/compliance`);
            if (!res.ok) {
                this._renderError(projectName, `HTTP ${res.status} — ${await res.text()}`);
                return;
            }
            const data = await res.json() as ApiComplianceResponse;
            this._render(projectName, data);
        } catch (e) {
            this._renderError(projectName, (e as Error).message);
        }
    }

    private _renderLoading(projectName: string): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader(projectName));
        const loading = document.createElement('div');
        loading.className = 'list-placeholder';
        loading.textContent = I18n.t('Loading template compliance …');
        this._root.appendChild(loading);
    }

    private _renderError(projectName: string, msg: string): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader(projectName));
        const err = document.createElement('div');
        err.className = 'list-error';
        err.textContent = msg;
        this._root.appendChild(err);
    }

    private _render(projectName: string, data: ApiComplianceResponse): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader(projectName));

        if (data.unresolvedIds.length > 0) {
            const banner = document.createElement('div');
            banner.className = 'tv-banner tv-banner-error';
            banner.textContent = I18n.t(
                'Unknown template ids in this project: {ids}',
                {ids: data.unresolvedIds.join(', ')}
            );
            this._root.appendChild(banner);
        }

        if (data.templateIds.length === 0) {
            const note = document.createElement('div');
            note.className = 'tv-banner';
            note.textContent = I18n.t('No templates assigned to this project. Edit the project to attach one.');
            this._root.appendChild(note);
            return;
        }

        const chain = document.createElement('div');
        chain.className = 'tv-chain';
        chain.textContent = I18n.t('Effective template chain: {ids}', {ids: data.templateIds.join(' ← ')});
        this._root.appendChild(chain);

        if (data.findings.length === 0) {
            const ok = document.createElement('div');
            ok.className = 'tv-banner tv-banner-ok';
            ok.textContent = I18n.t('Project is fully compliant with its template chain.');
            this._root.appendChild(ok);
            return;
        }

        /*
         * Apply bar — opens TemplateApplyModal for the user to pick +
         * apply a subset of findings. Skipped for remote projects:
         * the backend rejects compliance-apply for non-local projects
         * anyway, but we'd rather not even offer the button than show
         * an error after the user clicked it.
         */
        if (this._projectType === ConfigProjectType.local) {
            const applyBar = document.createElement('div');
            applyBar.className = 'tv-applybar';
            const applyBtn = document.createElement('button');
            applyBtn.type = 'button';
            applyBtn.className = 'umd-btn umd-btn-primary';
            applyBtn.textContent = I18n.t('Apply …');
            applyBtn.addEventListener('click', () => {
                if (!this._projectUnid) {
                    return;
                }
                const modal = new TemplateApplyModal();
                modal.onApplied(() => {
                    if (this._projectUnid) {
                        void this.show(this._projectUnid, this._projectName ?? '', this._projectType);
                    }
                });
                modal.open(this._projectUnid, this._projectName ?? '', data.findings);
            });
            applyBar.appendChild(applyBtn);
            this._root.appendChild(applyBar);
        } else {
            const note = document.createElement('div');
            note.className = 'installed-meta installed-meta-readonly';
            note.textContent = I18n.t('Read-only: remote project — upgrades and template apply are disabled.');
            this._root.appendChild(note);
        }

        const grouped = TemplateView._groupBySeverity(data.findings);
        for (const sev of ['risk', 'warn', 'info'] as const) {
            const list = grouped[sev];
            if (list.length === 0) {
                continue;
            }
            this._root.appendChild(this._renderGroup(sev, list));
        }
    }

    private _renderGroup(sev: 'risk'|'warn'|'info', findings: ApiComplianceFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = `tv-group tv-group-${sev}`;
        const head = document.createElement('div');
        head.className = 'tv-group-head';
        head.textContent = `${TemplateView._severityLabel(sev)} (${findings.length})`;
        wrap.appendChild(head);

        const table = document.createElement('table');
        table.className = 'tv-table';
        const thead = document.createElement('thead');
        thead.innerHTML = `<tr>
            <th>${I18n.t('Kind')}</th>
            <th>${I18n.t('Target')}</th>
            <th>${I18n.t('Expected')}</th>
            <th>${I18n.t('Actual')}</th>
            <th>${I18n.t('From')}</th>
        </tr>`;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const f of findings) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${TemplateView._kindLabel(f.kind)}</td>
                <td><code>${TemplateView._escape(f.target)}</code></td>
                <td>${f.expected ? `<code>${TemplateView._escape(f.expected)}</code>` : '–'}</td>
                <td>${f.actual ? `<code>${TemplateView._escape(f.actual)}</code>` : '–'}</td>
                <td>${TemplateView._escape(f.sourceId)}</td>
            `;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    private _renderHeader(projectName: string): HTMLElement {
        const header = document.createElement('div');
        header.className = 'list-header installed-header';

        const title = document.createElement('div');
        title.className = 'installed-title';
        title.textContent = projectName;
        header.appendChild(title);

        const toggle = document.createElement('div');
        toggle.className = 'installed-toggle';

        const mk = (label: string, handler: (() => void)|null, active = false): HTMLButtonElement => {
            const b = document.createElement('button');
            b.className = active
                ? 'installed-toggle-btn installed-toggle-btn-active'
                : 'installed-toggle-btn';
            b.textContent = label;
            if (handler) {
                b.addEventListener('click', handler);
            }
            return b;
        };

        const wrap = (cb: ((unid: string) => void)|null): (() => void)|null => {
            if (!cb) {
                return null;
            }
            return () => {
                if (this._projectUnid) {
                    cb(this._projectUnid);
                }
            };
        };

        toggle.appendChild(mk(I18n.t('Declared'), wrap(this._onShowDeclared)));
        toggle.appendChild(mk(I18n.t('Installed'), wrap(this._onShowInstalled)));
        toggle.appendChild(mk(I18n.t('History'), wrap(this._onShowHistory)));
        toggle.appendChild(mk(I18n.t('Matrix'), wrap(this._onShowMatrix)));
        toggle.appendChild(mk(I18n.t('Tree'), wrap(this._onShowTree)));
        toggle.appendChild(mk(I18n.t('Unused'), wrap(this._onShowUnused)));
        toggle.appendChild(mk(I18n.t('Vulns'), wrap(this._onShowVulns)));
        toggle.appendChild(mk(I18n.t('PR'), wrap(this._onShowPr)));
        toggle.appendChild(mk(I18n.t('Template'), null, true));

        header.appendChild(toggle);
        return header;
    }

    private static _groupBySeverity(
        findings: ApiComplianceFinding[]
    ): {risk: ApiComplianceFinding[]; warn: ApiComplianceFinding[]; info: ApiComplianceFinding[];} {
        const out = {risk: [] as ApiComplianceFinding[], warn: [] as ApiComplianceFinding[], info: [] as ApiComplianceFinding[]};
        for (const f of findings) {
            out[f.severity].push(f);
        }
        return out;
    }

    private static _severityLabel(s: 'risk'|'warn'|'info'): string {
        switch (s) {
            case 'risk': return I18n.t('Risk');
            case 'warn': return I18n.t('Warning');
            case 'info': return I18n.t('Info');
            default: return '';
        }
    }

    private static _kindLabel(k: ApiComplianceFinding['kind']): string {
        switch (k) {
            case 'missing': return I18n.t('Missing');
            case 'divergent': return I18n.t('Divergent');
            case 'forbidden': return I18n.t('Forbidden');
            case 'extra': return I18n.t('Extra (strict mode)');
            case 'bucket-wrong': return I18n.t('Wrong bucket');
            case 'root-missing': return I18n.t('Root field missing');
            case 'root-divergent': return I18n.t('Root field drift');
            case 'file-missing': return I18n.t('File missing');
            case 'file-drift': return I18n.t('File drift');
            case 'workspace-missing': return I18n.t('Workspace missing');
            default: return '';
        }
    }

    private static _escape(s: string): string {
        return s
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;');
    }

}