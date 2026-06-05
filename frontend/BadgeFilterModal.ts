import {I18n} from './I18n.js';
import {MATRIX_BADGES, MatrixBadgeId, MatrixBadgeMeta} from './Matrix.js';

/**
 * Handler fired when the user clicks "Apply" — the modal hands the
 * Matrix the new hidden-badges set in one shot so persistence and
 * re-render stay coupled in the caller.
 */
export type BadgeFilterApplyHandler = (hidden: Set<MatrixBadgeId>) => void;

/**
 * Modal dialog that lets the user toggle individual matrix badges on
 * and off. Each row renders a checkbox, a *real* styled sample of the
 * badge (CSS classes pulled from `MATRIX_BADGES` so the colours match
 * exactly what shows up in the matrix), and a one-line description.
 * Defaults to every badge visible — `_drafts` is initialised from the
 * caller's current hidden set on each `open()`.
 */
export class BadgeFilterModal {

    private _backdrop: HTMLElement|null = null;
    private _drafts: Set<MatrixBadgeId> = new Set();
    private _onApply: BadgeFilterApplyHandler|null = null;

    public onApply(handler: BadgeFilterApplyHandler): void {
        this._onApply = handler;
    }

    public open(currentHidden: Set<MatrixBadgeId>): void {
        this._drafts = new Set(currentHidden);
        this._mount();
    }

    public close(): void {
        this._backdrop?.remove();
        this._backdrop = null;
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
        panel.className = 'umd-panel bfm-panel';
        backdrop.appendChild(panel);

        panel.appendChild(this._renderHeader());
        panel.appendChild(this._renderQuickActions());
        panel.appendChild(this._renderList());
        panel.appendChild(this._renderFooter());

        document.addEventListener('keydown', this._onKeyDown);
    }

    private _renderHeader(): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = I18n.t('Badges');
        head.appendChild(title);
        const close = document.createElement('button');
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    /**
     * "Show all" / "Hide all" shortcuts — handy for users who want to
     * start from one extreme and toggle a couple of badges back on.
     */
    private _renderQuickActions(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'bfm-quick';

        const showAll = document.createElement('button');
        showAll.className = 'umd-btn';
        showAll.textContent = I18n.t('Show all');
        showAll.addEventListener('click', () => {
            this._drafts.clear();
            this._refreshChecks();
        });
        bar.appendChild(showAll);

        const hideAll = document.createElement('button');
        hideAll.className = 'umd-btn';
        hideAll.textContent = I18n.t('Hide all');
        hideAll.addEventListener('click', () => {
            this._drafts = new Set(MATRIX_BADGES.map((b) => b.id));
            this._refreshChecks();
        });
        bar.appendChild(hideAll);

        return bar;
    }

    private _renderList(): HTMLElement {
        const list = document.createElement('div');
        list.className = 'bfm-list';
        for (const meta of MATRIX_BADGES) {
            list.appendChild(this._renderRow(meta));
        }
        return list;
    }

    private _renderRow(meta: MatrixBadgeMeta): HTMLElement {
        const row = document.createElement('label');
        row.className = 'bfm-row';
        row.htmlFor = `bfm-${meta.id}`;

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'bfm-check';
        check.id = `bfm-${meta.id}`;
        check.dataset.badgeId = meta.id;
        check.checked = !this._drafts.has(meta.id);
        check.addEventListener('change', () => {
            if (check.checked) {
                this._drafts.delete(meta.id);
            } else {
                this._drafts.add(meta.id);
            }
        });
        row.appendChild(check);

        // Wrapper around the sample so the badge keeps its inline
        // styling — class list comes verbatim from the catalogue so
        // colours match the matrix exactly.
        const sample = document.createElement('span');
        sample.className = meta.sampleClasses;
        sample.textContent = meta.sampleText;
        // The sample is purely visual inside the modal — strip the
        // cursor: pointer the matrix uses on its real badges.
        sample.style.cursor = 'default';
        sample.style.marginLeft = '0';
        row.appendChild(sample);

        const label = document.createElement('span');
        label.className = 'bfm-label';
        label.textContent = I18n.t(meta.label);
        row.appendChild(label);

        const desc = document.createElement('span');
        desc.className = 'bfm-desc';
        desc.textContent = I18n.t(meta.description);
        row.appendChild(desc);

        return row;
    }

    private _renderFooter(): HTMLElement {
        const foot = document.createElement('div');
        foot.className = 'bfm-foot';

        const cancel = document.createElement('button');
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Cancel');
        cancel.addEventListener('click', () => this.close());
        foot.appendChild(cancel);

        const apply = document.createElement('button');
        apply.className = 'umd-btn umd-btn-primary';
        apply.textContent = I18n.t('Apply');
        apply.addEventListener('click', () => {
            this._onApply?.(new Set(this._drafts));
            this.close();
        });
        foot.appendChild(apply);

        return foot;
    }

    /**
     * Re-sync every checkbox to the current `_drafts` set. Used after
     * the "Show all" / "Hide all" shortcuts — the per-row change
     * handlers stay live so a subsequent click still flips a single
     * row.
     */
    private _refreshChecks(): void {
        if (!this._backdrop) {
            return;
        }
        const inputs = this._backdrop.querySelectorAll<HTMLInputElement>('input.bfm-check');
        inputs.forEach((inp) => {
            const id = inp.dataset.badgeId as MatrixBadgeId|undefined;
            if (id !== undefined) {
                inp.checked = !this._drafts.has(id);
            }
        });
    }
}