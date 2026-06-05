import {ApiImpactResponse} from '../shared/Api/ApiTypes.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';

/**
 * Cross-project blast-radius modal. Given a package name (and an
 * optional version pattern), queries `/api/impact` and renders a
 * three-column overview:
 *   1. projects with hits — grouped, with the dep chain per hit
 *   2. projects scanned clean
 *   3. projects skipped (no lockfile / scan error)
 *
 * Modeled on WhyModal's tree — same Esc-to-close, backdrop-click-to-close,
 * single-instance behaviour. Reusing the `umd-` modal chrome keeps the
 * visual language consistent without extra CSS.
 */
export class ImpactModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _body: HTMLElement|null = null;
    private _nameInput: HTMLInputElement|null = null;
    private _versionInput: HTMLInputElement|null = null;
    private _runBtn: HTMLButtonElement|null = null;
    private _inflight: boolean = false;

    public open(seed?: {name?: string; version?: string;}): void {
        this._mount();
        if (seed?.name && this._nameInput) {
            this._nameInput.value = seed.name;
        }
        if (seed?.version && this._versionInput) {
            this._versionInput.value = seed.version;
        }
        /*
         * Auto-run when the caller pre-fills a name — the typical
         * "PackageDetailPanel → Impact" flow already knows which package
         * the user cares about, so making them click again is friction.
         */
        if (seed?.name) {
            void this._run();
        }
        this._nameInput?.focus();
    }

    public close(): void {
        this._backdrop?.remove();
        this._backdrop = null;
        this._panel = null;
        this._body = null;
        this._nameInput = null;
        this._versionInput = null;
        this._runBtn = null;
        document.removeEventListener('keydown', this._onKeyDown);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

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
        panel.className = 'umd-panel imd-panel';
        backdrop.appendChild(panel);
        this._panel = panel;

        panel.appendChild(this._renderHeader());
        panel.appendChild(this._renderQueryBar());

        const body = document.createElement('div');
        body.className = 'imd-body';
        panel.appendChild(body);
        this._body = body;

        document.addEventListener('keydown', this._onKeyDown);
        this._renderEmptyState();
    }

    private _renderHeader(): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = I18n.t('Impact analysis');
        head.appendChild(title);
        const close = document.createElement('button');
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    private _renderQueryBar(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'imd-query';

        const nameLabel = document.createElement('label');
        nameLabel.className = 'imd-field';
        const nameText = document.createElement('span');
        nameText.textContent = I18n.t('Package name');
        nameLabel.appendChild(nameText);
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'lodash';
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void this._run();
            }
        });
        nameLabel.appendChild(nameInput);
        this._nameInput = nameInput;

        const versionLabel = document.createElement('label');
        versionLabel.className = 'imd-field';
        const versionText = document.createElement('span');
        versionText.textContent = I18n.t('Version (optional)');
        versionLabel.appendChild(versionText);
        const versionInput = document.createElement('input');
        versionInput.type = 'text';
        versionInput.placeholder = '4.17.x';
        versionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void this._run();
            }
        });
        versionLabel.appendChild(versionInput);
        this._versionInput = versionInput;

        const runBtn = document.createElement('button');
        runBtn.className = 'umd-btn umd-btn-primary';
        runBtn.textContent = I18n.t('Scan impact');
        runBtn.addEventListener('click', () => void this._run());
        this._runBtn = runBtn;

        bar.appendChild(nameLabel);
        bar.appendChild(versionLabel);
        bar.appendChild(runBtn);
        return bar;
    }

    private async _run(): Promise<void> {
        if (this._inflight) {
            return;
        }
        const name = (this._nameInput?.value ?? '').trim();
        if (name === '') {
            this._nameInput?.focus();
            return;
        }
        const version = (this._versionInput?.value ?? '').trim();

        this._inflight = true;
        if (this._runBtn) {
            this._runBtn.disabled = true;
            this._runBtn.textContent = I18n.t('Scanning …');
        }
        this._renderLoading();

        try {
            const report = await Api.impact(name, version === '' ? undefined : version);
            this._renderReport(report);
        } catch (e) {
            this._renderError((e as Error).message);
        } finally {
            this._inflight = false;
            if (this._runBtn) {
                this._runBtn.disabled = false;
                this._runBtn.textContent = I18n.t('Scan impact');
            }
        }
    }

    private _renderEmptyState(): void {
        if (!this._body) {
            return;
        }
        this._body.innerHTML = '';
        const hint = document.createElement('div');
        hint.className = 'imd-hint';
        hint.textContent = I18n.t('Enter a package name to scan every configured project for direct + transitive uses. Patterns like "4.17.x" or "4.x" narrow by version.');
        this._body.appendChild(hint);
    }

    private _renderLoading(): void {
        if (!this._body) {
            return;
        }
        this._body.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'umd-loading';
        wrap.textContent = I18n.t('Scanning all configured projects …');
        this._body.appendChild(wrap);
    }

    private _renderError(msg: string): void {
        if (!this._body) {
            return;
        }
        this._body.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'umd-error';
        err.textContent = msg;
        this._body.appendChild(err);
    }

    private _renderReport(report: ApiImpactResponse): void {
        if (!this._body) {
            return;
        }
        this._body.innerHTML = '';

        const summary = document.createElement('div');
        summary.className = 'imd-summary';
        const totalProjects = report.projects.length + report.cleanProjects.length + report.skippedProjects.length;
        const versionSuffix = report.query.versionPattern
            ? `@${report.query.versionPattern}`
            : '';
        summary.textContent = I18n.t(
            '{name}{version} — {hits} hits across {affected}/{total} projects',
            {
                name: report.query.name,
                version: versionSuffix,
                hits: String(report.totalHits),
                affected: String(report.projects.length),
                total: String(totalProjects)
            }
        );
        this._body.appendChild(summary);

        if (report.totalHits === 0 && report.skippedProjects.length === 0) {
            const clean = document.createElement('div');
            clean.className = 'imd-clean-all';
            clean.textContent = I18n.t('No project ships this package — you are not exposed.');
            this._body.appendChild(clean);
            return;
        }

        if (report.projects.length > 0) {
            const affectedHead = document.createElement('h3');
            affectedHead.className = 'imd-section-head';
            affectedHead.textContent = I18n.t('Affected projects ({n})', {n: String(report.projects.length)});
            this._body.appendChild(affectedHead);

            for (const proj of report.projects) {
                this._body.appendChild(this._renderProjectCard(proj));
            }
        }

        if (report.cleanProjects.length > 0) {
            const cleanHead = document.createElement('h3');
            cleanHead.className = 'imd-section-head';
            cleanHead.textContent = I18n.t('Clean projects ({n})', {n: String(report.cleanProjects.length)});
            this._body.appendChild(cleanHead);

            const cleanList = document.createElement('div');
            cleanList.className = 'imd-clean-list';
            for (const proj of report.cleanProjects) {
                const chip = document.createElement('span');
                chip.className = 'imd-chip imd-chip-clean';
                chip.textContent = proj.name;
                cleanList.appendChild(chip);
            }
            this._body.appendChild(cleanList);
        }

        if (report.skippedProjects.length > 0) {
            const skippedHead = document.createElement('h3');
            skippedHead.className = 'imd-section-head';
            skippedHead.textContent = I18n.t('Skipped projects ({n})', {n: String(report.skippedProjects.length)});
            this._body.appendChild(skippedHead);

            const skippedList = document.createElement('div');
            skippedList.className = 'imd-skipped-list';
            for (const proj of report.skippedProjects) {
                const row = document.createElement('div');
                row.className = 'imd-skipped-row';
                const name = document.createElement('span');
                name.className = 'imd-chip imd-chip-skipped';
                name.textContent = proj.name;
                const reason = document.createElement('span');
                reason.className = 'imd-skipped-reason';
                reason.textContent = proj.reason;
                row.appendChild(name);
                row.appendChild(reason);
                skippedList.appendChild(row);
            }
            this._body.appendChild(skippedList);
        }
    }

    private _renderProjectCard(proj: ApiImpactResponse['projects'][number]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'imd-card';

        const head = document.createElement('div');
        head.className = 'imd-card-head';
        const name = document.createElement('span');
        name.className = 'imd-card-name';
        name.textContent = proj.project.name;
        head.appendChild(name);
        const count = document.createElement('span');
        count.className = 'imd-card-count';
        count.textContent = I18n.t('{n} hits', {n: String(proj.hits.length)});
        head.appendChild(count);
        card.appendChild(head);

        const hitList = document.createElement('div');
        hitList.className = 'imd-hits';
        for (const hit of proj.hits) {
            const row = document.createElement('div');
            row.className = 'imd-hit';

            const kindBadge = document.createElement('span');
            kindBadge.className = `imd-kind imd-kind-${hit.kind}`;
            kindBadge.textContent = hit.kind === 'direct'
                ? I18n.t('direct')
                : I18n.t('transitive');
            row.appendChild(kindBadge);

            const pathEl = document.createElement('span');
            pathEl.className = 'imd-path';
            pathEl.textContent = hit.path.join('  →  ');
            row.appendChild(pathEl);

            if (hit.vulnCount > 0) {
                const vuln = document.createElement('span');
                vuln.className = 'imd-vuln';
                vuln.textContent = I18n.t('{n} CVE', {n: String(hit.vulnCount)});
                row.appendChild(vuln);
            }

            hitList.appendChild(row);
        }
        card.appendChild(hitList);

        return card;
    }

}