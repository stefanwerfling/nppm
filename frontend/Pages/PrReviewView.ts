import {ApiPrReviewResponse} from '../../shared/Api/ApiTypes.js';
import {ConfigProjectType} from '../../backend/Config/Config.js';
import {PrChangeKind, PrDepChange} from '../../backend/PrReview/PrReview.js';
import {Api} from '../Api.js';
import {I18n} from '../I18n.js';

/**
 * PR Review — diffs `package.json` + `package-lock.json` between two
 * git refs (default `main` vs `HEAD`) and renders one card per dep
 * change with the CVE delta from the OSV cache. Local projects only.
 *
 * Header carries a base/head input pair so the reviewer can re-run
 * against alternate refs. Reload on Enter; explicit "Refresh" button
 * for the cautious.
 *
 * V1 surfaces CVE delta only. Maintainer / install-script / pattern
 * deltas need a `SecurityScanner.scan` call per side and are
 * deferred — fits the same SSE pattern as the Vulnerability Timeline
 * scan when we add it.
 */
export class PrReviewView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _projectType: string|null = null;
    private _base: string = 'main';
    private _head: string = 'HEAD';
    private _report: ApiPrReviewResponse|null = null;
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowInstalled: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _onShowUnused: ((unid: string) => void)|null = null;
    private _onShowVulns: ((unid: string) => void)|null = null;
    private _onShowTemplate: ((unid: string) => void)|null = null;
    private _onDepClick: ((name: string, version: string) => void)|null = null;

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    public onShowDeclared(handler: (unid: string) => void): void { this._onShowDeclared = handler; }
    public onShowInstalled(handler: (unid: string) => void): void { this._onShowInstalled = handler; }
    public onShowHistory(handler: (unid: string) => void): void { this._onShowHistory = handler; }
    public onShowMatrix(handler: (unid: string) => void): void { this._onShowMatrix = handler; }
    public onShowTree(handler: (unid: string) => void): void { this._onShowTree = handler; }
    public onShowUnused(handler: (unid: string) => void): void { this._onShowUnused = handler; }
    public onShowVulns(handler: (unid: string) => void): void { this._onShowVulns = handler; }
    public onShowTemplate(handler: (unid: string) => void): void { this._onShowTemplate = handler; }

    /**
     * Click handler for a dep change row — opens the package detail
     * panel landing on the security tab with the new resolved version.
     */
    public onDepClick(handler: (name: string, version: string) => void): void {
        this._onDepClick = handler;
    }

    public async show(unid: string, name: string, type: string): Promise<void> {
        this._projectUnid = unid;
        this._projectName = name;
        this._projectType = type;
        /*
         * Reset refs to defaults when entering from a fresh project
         * switch; staying on the previous user-typed value would
         * confuse cross-project navigation.
         */
        this._base = 'main';
        this._head = 'HEAD';
        await this._reload();
    }

    private async _reload(): Promise<void> {
        const unid = this._projectUnid;
        if (!unid) {
            return;
        }
        /*
         * PR-review needs a local git checkout to walk `git log` over,
         * so the backend rejects remote projects with a 400. Short-
         * circuit here with a friendlier explanation than the raw
         * "PR review only supported for local projects" error.
         */
        if (this._projectType !== ConfigProjectType.local) {
            this._renderNotApplicable();
            return;
        }
        this._renderLoading();
        try {
            const report = await Api.prReview(unid, this._base, this._head);
            if (this._projectUnid !== unid) {
                return;
            }
            this._report = report;
            this._render();
        } catch (e) {
            if (this._projectUnid === unid) {
                this._renderError((e as Error).message);
            }
        }
    }

    private _renderNotApplicable(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());
        const note = document.createElement('div');
        note.className = 'installed-meta installed-meta-readonly';
        note.textContent = I18n.t(
            'PR review needs a local git checkout to diff refs against — not available for remote projects. Clone the repo locally and add it as a local project to use this view.'
        );
        this._root.appendChild(note);
    }

    private _renderLoading(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());
        const hint = document.createElement('div');
        hint.className = 'list-placeholder';
        hint.textContent = I18n.t('Loading PR review …');
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

    private _render(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());

        const t = this._report;
        if (!t) {
            return;
        }

        this._root.appendChild(this._renderRefBar());

        if (t.notes.length > 0) {
            const notes = document.createElement('div');
            notes.className = 'pr-notes';
            for (const n of t.notes) {
                const line = document.createElement('div');
                line.className = 'pr-note';
                line.textContent = n;
                notes.appendChild(line);
            }
            this._root.appendChild(notes);
        }

        if (!t.baseExists || !t.headExists) {
            const banner = document.createElement('div');
            banner.className = 'list-placeholder';
            banner.textContent = I18n.t(
                'One of the refs does not resolve — fix and retry.'
            );
            this._root.appendChild(banner);
            return;
        }

        this._root.appendChild(this._renderSummary(t));

        if (t.changes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'list-placeholder';
            empty.textContent = I18n.t(
                'No dep changes between {base} and {head}.',
                {base: t.base, head: t.head}
            );
            this._root.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'pr-list';
        for (const c of t.changes) {
            list.appendChild(this._renderChange(c));
        }
        this._root.appendChild(list);
    }

    private _renderRefBar(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'pr-refbar';

        const mk = (label: string, value: string, onCommit: (v: string) => void): HTMLElement => {
            const wrap = document.createElement('label');
            wrap.className = 'pr-ref';
            const txt = document.createElement('span');
            txt.className = 'pr-ref-label';
            txt.textContent = label;
            wrap.appendChild(txt);
            const input = document.createElement('input');
            input.className = 'pr-ref-input';
            input.type = 'text';
            input.value = value;
            input.addEventListener('change', () => onCommit(input.value.trim()));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    onCommit(input.value.trim());
                }
            });
            wrap.appendChild(input);
            return wrap;
        };

        bar.appendChild(mk(I18n.t('Base'), this._base, (v) => {
            this._base = v || 'main';
            void this._reload();
        }));
        bar.appendChild(mk(I18n.t('Head'), this._head, (v) => {
            this._head = v || 'HEAD';
            void this._reload();
        }));

        const refresh = document.createElement('button');
        refresh.className = 'installed-analyze-btn';
        refresh.textContent = I18n.t('Refresh');
        refresh.addEventListener('click', () => {
            void this._reload();
        });
        bar.appendChild(refresh);

        return bar;
    }

    private _renderSummary(t: ApiPrReviewResponse): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pr-summary';
        const s = t.summary;

        const mk = (cls: string, label: string, count: number): HTMLElement => {
            const pill = document.createElement('span');
            pill.className = `pr-pill pr-pill-${cls}`;
            pill.textContent = `${label}: ${count}`;
            return pill;
        };

        wrap.appendChild(mk('added', I18n.t('added'), s.added));
        wrap.appendChild(mk('updated', I18n.t('updated'), s.updated));
        wrap.appendChild(mk('removed', I18n.t('removed'), s.removed));
        if (s.bucketChanged > 0) {
            wrap.appendChild(mk('bucket', I18n.t('bucket'), s.bucketChanged));
        }
        if (s.totalVulnsAdded > 0) {
            wrap.appendChild(mk('vuln-added', I18n.t('+{n} CVE', {n: String(s.totalVulnsAdded)}), s.totalVulnsAdded));
        }
        if (s.totalVulnsRemoved > 0) {
            wrap.appendChild(mk('vuln-removed', I18n.t('−{n} CVE', {n: String(s.totalVulnsRemoved)}), s.totalVulnsRemoved));
        }
        return wrap;
    }

    private _renderChange(c: PrDepChange): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pr-card';

        const head = document.createElement('div');
        head.className = 'pr-card-head';

        const kind = document.createElement('span');
        kind.className = `pr-kind pr-kind-${c.kind}`;
        kind.textContent = PrReviewView._kindLabel(c.kind);
        head.appendChild(kind);

        const name = document.createElement('span');
        name.className = 'pr-name';
        name.textContent = c.name;
        head.appendChild(name);

        /*
         * Click → open security panel on the new version (after).
         * Falls back to the old version when the dep was removed.
         */
        const targetVersion = c.resolvedAfter ?? c.resolvedBefore;
        if (targetVersion) {
            head.classList.add('pr-card-head-clickable');
            head.title = I18n.t('Open security details');
            head.addEventListener('click', () => {
                if (this._onDepClick) {
                    this._onDepClick(c.name, targetVersion);
                }
            });
        }

        card.appendChild(head);

        const versions = document.createElement('div');
        versions.className = 'pr-card-versions';
        const declared = PrReviewView._renderTransition(
            I18n.t('declared'),
            PrReviewView._fmtDeclared(c.declaredBucketBefore, c.declaredRangeBefore),
            PrReviewView._fmtDeclared(c.declaredBucketAfter, c.declaredRangeAfter)
        );
        versions.appendChild(declared);
        if (c.resolvedBefore || c.resolvedAfter) {
            const resolved = PrReviewView._renderTransition(
                I18n.t('resolved'),
                c.resolvedBefore ?? '—',
                c.resolvedAfter ?? '—'
            );
            versions.appendChild(resolved);
        }
        card.appendChild(versions);

        if (c.vulnsAdded.length > 0 || c.vulnsRemoved.length > 0) {
            card.appendChild(this._renderVulnDelta(c));
        }

        return card;
    }

    private _renderVulnDelta(c: PrDepChange): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pr-vulns';

        if (c.vulnsAdded.length > 0) {
            const section = document.createElement('div');
            section.className = 'pr-vulns-section pr-vulns-added';
            const head = document.createElement('div');
            head.className = 'pr-vulns-head';
            head.textContent = I18n.t('New exposures ({n})', {n: String(c.vulnsAdded.length)});
            section.appendChild(head);
            for (const id of c.vulnsAdded) {
                section.appendChild(PrReviewView._vulnPill(id, 'added'));
            }
            wrap.appendChild(section);
        }
        if (c.vulnsRemoved.length > 0) {
            const section = document.createElement('div');
            section.className = 'pr-vulns-section pr-vulns-removed';
            const head = document.createElement('div');
            head.className = 'pr-vulns-head';
            head.textContent = I18n.t('Closed by this PR ({n})', {n: String(c.vulnsRemoved.length)});
            section.appendChild(head);
            for (const id of c.vulnsRemoved) {
                section.appendChild(PrReviewView._vulnPill(id, 'removed'));
            }
            wrap.appendChild(section);
        }
        return wrap;
    }

    private static _vulnPill(id: string, polarity: 'added'|'removed'): HTMLElement {
        const a = document.createElement('a');
        a.className = `pr-vuln-pill pr-vuln-pill-${polarity}`;
        a.textContent = id;
        a.href = `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        return a;
    }

    private static _renderTransition(label: string, before: string, after: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pr-transition';

        const lbl = document.createElement('span');
        lbl.className = 'pr-transition-label';
        lbl.textContent = label;
        row.appendChild(lbl);

        const from = document.createElement('span');
        from.className = 'pr-transition-from';
        from.textContent = before;
        row.appendChild(from);

        const arrow = document.createElement('span');
        arrow.className = 'pr-transition-arrow';
        arrow.textContent = '→';
        row.appendChild(arrow);

        const to = document.createElement('span');
        to.className = 'pr-transition-to';
        to.textContent = after;
        row.appendChild(to);

        return row;
    }

    private static _fmtDeclared(bucket: string|undefined, range: string|undefined): string {
        if (!range) {
            return '—';
        }
        return bucket ? `${range}  (${bucket})` : range;
    }

    private static _kindLabel(k: PrChangeKind): string {
        switch (k) {
            case 'added': return I18n.t('added');
            case 'removed': return I18n.t('removed');
            case 'updated': return I18n.t('updated');
            case 'bucket-changed': return I18n.t('bucket');
            default: return '';
        }
    }

    /**
     * Header with the eight-way toggle. Mirrors the other per-project
     * views; the PR button is the active one here.
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
        unused.className = 'installed-toggle-btn';
        unused.textContent = I18n.t('Unused');
        unused.addEventListener('click', () => {
            if (this._projectUnid && this._onShowUnused) {
                this._onShowUnused(this._projectUnid);
            }
        });
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
        pr.className = 'installed-toggle-btn installed-toggle-btn-active';
        pr.textContent = I18n.t('PR');
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

        header.appendChild(toggle);
        return header;
    }

}