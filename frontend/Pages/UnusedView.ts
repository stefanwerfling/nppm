import {ApiUnusedResponse} from '../../shared/Api/ApiTypes.js';
import {
    MisplacedFinding,
    MissingFinding,
    ScanLimit,
    UnusedFinding,
    UnusedSeverity
} from '../../backend/Unused/UnusedReport.js';
import {Api} from '../Util/Api.js';
import {I18n} from '../Util/I18n.js';

/**
 * Per-project depcheck-style hygiene scan. Renders three sections —
 * unused / misplaced / missing — using the same severity-pill styling
 * as the security tab so the visual ladder stays consistent across
 * scanners. Remote projects render an info banner explaining v1
 * doesn't support them.
 *
 * Shares the right-pane slot with the other per-project views; the
 * header toggle is the same six-button group as everywhere else.
 */
export class UnusedView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowInstalled: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _onShowVulns: ((unid: string) => void)|null = null;
    private _onShowPr: ((unid: string) => void)|null = null;
    private _onShowTemplate: ((unid: string) => void)|null = null;
    private _onShowSource: ((unid: string) => void)|null = null;

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

    public onShowVulns(handler: (unid: string) => void): void {
        this._onShowVulns = handler;
    }

    public onShowPr(handler: (unid: string) => void): void {
        this._onShowPr = handler;
    }

    public onShowTemplate(handler: (unid: string) => void): void {
        this._onShowTemplate = handler;
    }

    public onShowSource(handler: (unid: string) => void): void {
        this._onShowSource = handler;
    }

    public async show(unid: string, name: string): Promise<void> {
        this._projectUnid = unid;
        this._projectName = name;
        this._renderLoading();

        try {
            const response = await Api.unused(unid);

            // Stale-response guard.
            if (this._projectUnid !== unid) {
                return;
            }

            this._render(response);
        } catch (e) {
            if (this._projectUnid === unid) {
                this._renderError((e as Error).message);
            }
        }
    }

    private _renderLoading(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());
        const hint = document.createElement('div');
        hint.className = 'list-placeholder';
        hint.textContent = I18n.t('Loading unused-deps scan …');
        this._root.appendChild(hint);
    }

    private _renderError(msg: string): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());
        const err = document.createElement('div');
        err.className = 'list-error';
        err.textContent = msg;
        this._root.appendChild(err);
    }

    private _render(report: ApiUnusedResponse): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());

        if (!report.supported) {
            const banner = document.createElement('div');
            banner.className = 'list-placeholder';
            banner.textContent = report.unsupportedReason
                ?? I18n.t('Unused-deps scan is not supported for this project type in v1.');
            this._root.appendChild(banner);
            return;
        }

        const body = document.createElement('div');
        body.className = 'pdp-scripts';

        body.appendChild(this._renderUnusedSection(report.unused));
        body.appendChild(this._renderMisplacedSection(report.misplaced));
        body.appendChild(this._renderMissingSection(report.missing));
        if (report.scanLimits.length > 0) {
            body.appendChild(this._renderScanLimitsSection(report.scanLimits));
        }

        this._root.appendChild(body);

        const footer = document.createElement('div');
        footer.className = 'pdp-section pdp-section-head';
        footer.textContent = I18n.t('Scanned {n} source files', {n: report.filesScanned});
        this._root.appendChild(footer);
    }

    private _renderUnusedSection(findings: UnusedFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const head = document.createElement('div');
        head.className = 'pdp-section-head';
        head.textContent = `${I18n.t('Unused dependencies')} (${findings.length})`;
        wrap.appendChild(head);

        if (findings.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pdp-script-reason';
            empty.textContent = I18n.t(
                'No unused dependencies — every declared package is imported, on the allowlist, or referenced in `scripts:`.'
            );
            wrap.appendChild(empty);
            return wrap;
        }

        for (const f of findings) {
            wrap.appendChild(this._renderUnusedCard(f));
        }
        return wrap;
    }

    private _renderUnusedCard(f: UnusedFinding): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pdp-script';

        const head = document.createElement('div');
        head.className = 'pdp-script-head';

        const name = document.createElement('span');
        name.className = 'pdp-script-hook';
        name.textContent = f.name;
        head.appendChild(name);

        const sev = document.createElement('span');
        sev.className = `pdp-sev ${UnusedView._sevClass(f.severity)}`;
        sev.textContent = f.severity;
        head.appendChild(sev);

        const bucket = document.createElement('span');
        bucket.className = 'pdp-script-reason';
        bucket.textContent = I18n.t('declared in {bucket}', {bucket: f.declaredIn});
        head.appendChild(bucket);

        card.appendChild(head);

        const reason = document.createElement('div');
        reason.className = 'pdp-script-reason';
        reason.textContent = f.reason;
        card.appendChild(reason);

        return card;
    }

    private _renderMisplacedSection(findings: MisplacedFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const head = document.createElement('div');
        head.className = 'pdp-section-head';
        head.textContent = `${I18n.t('Misplaced dependencies (only used in dev paths)')} (${findings.length})`;
        wrap.appendChild(head);

        if (findings.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pdp-script-reason';
            empty.textContent = I18n.t('No misplaced dependencies — every dep is in the right bucket.');
            wrap.appendChild(empty);
            return wrap;
        }

        for (const f of findings) {
            const card = document.createElement('div');
            card.className = 'pdp-script';

            const headRow = document.createElement('div');
            headRow.className = 'pdp-script-head';

            const name = document.createElement('span');
            name.className = 'pdp-script-hook';
            name.textContent = f.name;
            headRow.appendChild(name);

            const sev = document.createElement('span');
            sev.className = 'pdp-sev pdp-sev-warn';
            sev.textContent = I18n.t('move to devDependencies');
            headRow.appendChild(sev);

            card.appendChild(headRow);

            const reason = document.createElement('div');
            reason.className = 'pdp-script-reason';
            reason.textContent = I18n.t('first import: {path}', {path: f.firstImport});
            card.appendChild(reason);

            wrap.appendChild(card);
        }

        return wrap;
    }

    private _renderMissingSection(findings: MissingFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const head = document.createElement('div');
        head.className = 'pdp-section-head';
        head.textContent = `${I18n.t('Missing dependencies (imported but not declared)')} (${findings.length})`;
        wrap.appendChild(head);

        if (findings.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pdp-script-reason';
            empty.textContent = I18n.t('No missing dependencies — every import resolves to a declared name.');
            wrap.appendChild(empty);
            return wrap;
        }

        for (const f of findings) {
            const card = document.createElement('div');
            card.className = 'pdp-script';

            const headRow = document.createElement('div');
            headRow.className = 'pdp-script-head';

            const name = document.createElement('span');
            name.className = 'pdp-script-hook';
            name.textContent = f.name;
            headRow.appendChild(name);

            const sev = document.createElement('span');
            sev.className = 'pdp-sev pdp-sev-risk';
            sev.textContent = UnusedSeverity.risk;
            headRow.appendChild(sev);

            card.appendChild(headRow);

            const reason = document.createElement('div');
            reason.className = 'pdp-script-reason';
            reason.textContent = I18n.t('first import: {path}', {path: f.firstImport});
            card.appendChild(reason);

            wrap.appendChild(card);
        }

        return wrap;
    }

    private _renderScanLimitsSection(limits: ScanLimit[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const head = document.createElement('div');
        head.className = 'pdp-section-head';
        head.textContent = `${I18n.t('Files the regex scanner could only partially resolve')} (${limits.length})`;
        wrap.appendChild(head);

        for (const l of limits) {
            const card = document.createElement('div');
            card.className = 'pdp-script';

            const file = document.createElement('div');
            file.className = 'pdp-script-hook';
            file.textContent = l.file;
            card.appendChild(file);

            const reason = document.createElement('div');
            reason.className = 'pdp-script-reason';
            reason.textContent = l.reason;
            card.appendChild(reason);

            wrap.appendChild(card);
        }
        return wrap;
    }

    private static _sevClass(sev: UnusedSeverity): string {
        switch (sev) {
            case UnusedSeverity.risk: return 'pdp-sev-risk';
            case UnusedSeverity.warn: return 'pdp-sev-warn';
            case UnusedSeverity.info: return 'pdp-sev-info';
            default: return '';
        }
    }

    /**
     * Header with the six-way toggle. Mirrors the other per-project
     * views; the Unused button is the active one here.
     */
    private _renderHeader(): HTMLElement {
        const header = document.createElement('div');
        header.className = 'list-header installed-header';

        const title = document.createElement('div');
        title.className = 'installed-title';
        title.textContent = this._projectName ?? '';
        header.appendChild(title);

        const toggle = document.createElement('div');
        toggle.className = 'installed-toggle';

        const declared = document.createElement('button');
        declared.className = 'installed-toggle-btn';
        declared.textContent = I18n.t('Declared');
        declared.addEventListener('click', () => {
            if (this._projectUnid && this._onShowDeclared) {
                this._onShowDeclared(this._projectUnid);
            }
        });
        toggle.appendChild(declared);

        const installed = document.createElement('button');
        installed.className = 'installed-toggle-btn';
        installed.textContent = I18n.t('Installed');
        installed.addEventListener('click', () => {
            if (this._projectUnid && this._onShowInstalled) {
                this._onShowInstalled(this._projectUnid);
            }
        });
        toggle.appendChild(installed);

        const history = document.createElement('button');
        history.className = 'installed-toggle-btn';
        history.textContent = I18n.t('History');
        history.addEventListener('click', () => {
            if (this._projectUnid && this._onShowHistory) {
                this._onShowHistory(this._projectUnid);
            }
        });
        toggle.appendChild(history);

        const matrix = document.createElement('button');
        matrix.className = 'installed-toggle-btn';
        matrix.textContent = I18n.t('Matrix');
        matrix.addEventListener('click', () => {
            if (this._projectUnid && this._onShowMatrix) {
                this._onShowMatrix(this._projectUnid);
            }
        });
        toggle.appendChild(matrix);

        const tree = document.createElement('button');
        tree.className = 'installed-toggle-btn';
        tree.textContent = I18n.t('Tree');
        tree.addEventListener('click', () => {
            if (this._projectUnid && this._onShowTree) {
                this._onShowTree(this._projectUnid);
            }
        });
        toggle.appendChild(tree);

        const unused = document.createElement('button');
        unused.className = 'installed-toggle-btn installed-toggle-btn-active';
        unused.textContent = I18n.t('Unused');
        toggle.appendChild(unused);

        const vulns = document.createElement('button');
        vulns.className = 'installed-toggle-btn';
        vulns.textContent = I18n.t('Vulns');
        vulns.addEventListener('click', () => {
            if (this._projectUnid && this._onShowVulns) {
                this._onShowVulns(this._projectUnid);
            }
        });
        toggle.appendChild(vulns);

        const pr = document.createElement('button');
        pr.className = 'installed-toggle-btn';
        pr.textContent = I18n.t('PR');
        pr.addEventListener('click', () => {
            if (this._projectUnid && this._onShowPr) {
                this._onShowPr(this._projectUnid);
            }
        });
        toggle.appendChild(pr);

        const template = document.createElement('button');
        template.className = 'installed-toggle-btn';
        template.textContent = I18n.t('Template');
        template.addEventListener('click', () => {
            if (this._projectUnid && this._onShowTemplate) {
                this._onShowTemplate(this._projectUnid);
            }
        });
        toggle.appendChild(template);

        const source = document.createElement('button');
        source.className = 'installed-toggle-btn';
        source.textContent = I18n.t('Graph');
        source.addEventListener('click', () => {
            if (this._projectUnid && this._onShowSource) {
                this._onShowSource(this._projectUnid);
            }
        });
        toggle.appendChild(source);

        header.appendChild(toggle);
        return header;
    }

}