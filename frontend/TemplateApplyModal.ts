import {ApiComplianceApplyEndEvent, ApiComplianceApplyProgressEvent, ApiComplianceFinding} from '../shared/Api/ApiTypes.js';
import {I18n} from './I18n.js';

type Step = 'review'|'log';

/**
 * Modal overlay for applying a subset of compliance findings to disk.
 * Two-step flow:
 *   1. Review: checkboxes per finding, grouped by severity. The user
 *      ticks the ones to apply; risk-level findings are pre-selected,
 *      `report-only` file drifts are disabled (the apply doesn't write
 *      them anyway).
 *   2. Log: SSE stream from `POST /api/projects/:id/compliance/apply`,
 *      live counter of applied / skipped / errored, backup-dir hint.
 *
 * Re-uses the `umd-*` modal shell; `tam-*` is the apply-specific
 * namespace.
 */
export class TemplateApplyModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _findings: ApiComplianceFinding[] = [];
    private _selected: Set<string> = new Set();
    private _step: Step = 'review';
    private _onApplied: (() => void)|null = null;

    public onApplied(handler: () => void): void {
        this._onApplied = handler;
    }

    public open(unid: string, name: string, findings: ApiComplianceFinding[]): void {
        this._projectUnid = unid;
        this._projectName = name;
        this._findings = findings;
        this._selected = new Set(
            findings
            .filter((f) => f.severity === 'risk' || f.severity === 'warn')
            .map((f) => f.target)
        );
        this._step = 'review';
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
        panel.className = 'umd-panel tam-panel';
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

        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = this._step === 'review'
            ? I18n.t('Apply template compliance — {name}', {name: this._projectName ?? ''})
            : I18n.t('Applying … — {name}', {name: this._projectName ?? ''});
        head.appendChild(title);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        this._panel.appendChild(head);

        if (this._step === 'review') {
            this._renderReview();
        } else {
            this._renderLog();
        }
    }

    private _renderReview(): void {
        if (!this._panel) {
            return;
        }
        if (this._findings.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'umd-note';
            empty.textContent = I18n.t('Project is fully compliant with its template chain.');
            this._panel.appendChild(empty);
            return;
        }

        const body = document.createElement('div');
        body.className = 'tam-body';

        const grouped: Record<'risk'|'warn'|'info', ApiComplianceFinding[]> = {risk: [], warn: [], info: []};
        for (const f of this._findings) {
            grouped[f.severity].push(f);
        }
        for (const sev of ['risk', 'warn', 'info'] as const) {
            const list = grouped[sev];
            if (list.length === 0) {
                continue;
            }
            body.appendChild(this._renderGroup(sev, list));
        }

        this._panel.appendChild(body);

        const hint = document.createElement('div');
        hint.className = 'umd-note';
        hint.textContent = I18n.t(
            'A timestamped snapshot of every touched file is written to .nppm/backups/ before any change.'
        );
        this._panel.appendChild(hint);

        const actions = document.createElement('div');
        actions.className = 'umd-actions';
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'umd-btn umd-btn-primary';
        apply.textContent = I18n.t('Apply selected ({n})', {n: this._selected.size});
        apply.disabled = this._selected.size === 0;
        apply.addEventListener('click', () => void this._submit());
        actions.appendChild(apply);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Cancel');
        cancel.addEventListener('click', () => this.close());
        actions.appendChild(cancel);
        this._panel.appendChild(actions);
    }

    private _renderGroup(sev: 'risk'|'warn'|'info', findings: ApiComplianceFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = `tam-group tam-group-${sev}`;
        const head = document.createElement('div');
        head.className = 'tam-group-head';
        head.textContent = `${TemplateApplyModal._severityLabel(sev)} (${findings.length})`;
        wrap.appendChild(head);
        for (const f of findings) {
            wrap.appendChild(this._renderRow(f));
        }
        return wrap;
    }

    private _renderRow(f: ApiComplianceFinding): HTMLElement {
        const row = document.createElement('label');
        row.className = 'tam-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this._selected.has(f.target);
        // workspace-missing can't be auto-applied; disable the row.
        const disabled = f.kind === 'workspace-missing';
        cb.disabled = disabled;
        cb.addEventListener('change', () => {
            if (cb.checked) {
                this._selected.add(f.target);
            } else {
                this._selected.delete(f.target);
            }
            this._refreshApplyCounter();
        });
        row.appendChild(cb);
        const info = document.createElement('div');
        info.className = 'tam-info';
        const kindSpan = document.createElement('span');
        kindSpan.className = 'tam-kind';
        kindSpan.textContent = TemplateApplyModal._kindLabel(f.kind);
        info.appendChild(kindSpan);
        const code = document.createElement('code');
        code.className = 'tam-target';
        code.textContent = f.target;
        info.appendChild(code);
        if (f.expected || f.actual) {
            const diff = document.createElement('span');
            diff.className = 'tam-diff';
            diff.textContent = `${f.expected ?? '–'}  ←  ${f.actual ?? '–'}`;
            info.appendChild(diff);
        }
        if (disabled) {
            const why = document.createElement('span');
            why.className = 'tam-why';
            why.textContent = I18n.t('create the workspace dir manually first');
            info.appendChild(why);
        }
        row.appendChild(info);
        return row;
    }

    private _refreshApplyCounter(): void {
        const btn = this._panel?.querySelector('.umd-btn-primary');
        if (btn) {
            btn.textContent = I18n.t('Apply selected ({n})', {n: this._selected.size});
            (btn as HTMLButtonElement).disabled = this._selected.size === 0;
        }
    }

    private _renderLog(): void {
        if (!this._panel) {
            return;
        }
        const note = document.createElement('div');
        note.className = 'umd-note';
        note.textContent = I18n.t('Applying {n} change(s) …', {n: this._selected.size});
        this._panel.appendChild(note);

        const body = document.createElement('div');
        body.className = 'tam-log umd-log-body';
        this._panel.appendChild(body);

        const counter = document.createElement('div');
        counter.className = 'tam-counter';
        counter.textContent = I18n.t('Applied 0, skipped 0, error 0');
        this._panel.appendChild(counter);

        const actions = document.createElement('div');
        actions.className = 'umd-actions';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'umd-btn';
        close.textContent = I18n.t('Close');
        close.disabled = true;
        close.addEventListener('click', () => {
            this.close();
            this._onApplied?.();
        });
        actions.appendChild(close);
        this._panel.appendChild(actions);

        this._streamApply(body, counter, close);
    }

    private async _submit(): Promise<void> {
        this._step = 'log';
        this._render();
    }

    private async _streamApply(
        body: HTMLElement,
        counter: HTMLElement,
        closeBtn: HTMLButtonElement
    ): Promise<void> {
        if (!this._projectUnid) {
            return;
        }
        let applied = 0;
        let skipped = 0;
        let errored = 0;
        try {
            const res = await fetch(`/api/projects/${encodeURIComponent(this._projectUnid)}/compliance/apply`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({targets: [...this._selected]})
            });
            if (!res.ok || !res.body) {
                const txt = await res.text().catch(() => '');
                this._appendLine(body, `HTTP ${res.status} — ${txt}`);
                closeBtn.disabled = false;
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
                const {value, done} = await reader.read();
                if (done) {
                    break;
                }
                buf += decoder.decode(value, {stream: true});
                let nl: number;
                while ((nl = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, nl);
                    buf = buf.slice(nl + 2);
                    const evMatch = /^event: (\S+)\s*\ndata: (.*)$/su.exec(block);
                    if (!evMatch) {
                        continue;
                    }
                    const eventName = evMatch[1];
                    const data = JSON.parse(evMatch[2]);
                    if (eventName === 'progress') {
                        const p = data as ApiComplianceApplyProgressEvent;
                        if (p.status === 'applied') {
                            applied++;
                        } else if (p.status === 'skipped') {
                            skipped++;
                        } else {
                            errored++;
                        }
                        this._appendLine(body, `[${p.current}/${p.total}] ${p.status.toUpperCase()} ${p.target}${p.msg ? ` — ${p.msg}` : ''}`);
                        counter.textContent = I18n.t('Applied {a}, skipped {s}, error {e}', {a: applied, s: skipped, e: errored});
                    } else if (eventName === 'backup') {
                        const b = data as {backupDir: string|null;};
                        if (b.backupDir) {
                            this._appendLine(body, `📦 ${I18n.t('Backup written to {dir}', {dir: b.backupDir})}`);
                        }
                    } else if (eventName === 'end') {
                        const e = data as ApiComplianceApplyEndEvent;
                        this._appendLine(body, '');
                        this._appendLine(body, I18n.t('Done. {a} applied, {s} skipped, {e} errored.', {a: e.applied, s: e.skipped, e: e.errored}));
                    } else if (eventName === 'error') {
                        this._appendLine(body, `✗ ${(data as {msg: string;}).msg}`);
                    }
                }
            }
        } catch (e) {
            this._appendLine(body, `✗ ${(e as Error).message}`);
        } finally {
            closeBtn.disabled = false;
        }
    }

    private _appendLine(body: HTMLElement, line: string): void {
        const div = document.createElement('div');
        div.textContent = line;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
    }

    private static _severityLabel(s: 'risk'|'warn'|'info'): string {
        switch (s) {
            case 'risk': return I18n.t('Risk');
            case 'warn': return I18n.t('Warning');
            case 'info': return I18n.t('Info');
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
        }
    }

}