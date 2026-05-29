import {
    ApiBulkUpgradeApplyRequest,
    ApiBulkUpgradePick,
    ApiBulkUpgradePreviewResponse,
    ApiBulkUpgradePreviewResult,
    ApiUpgradePreviewResponse
} from '../Api/ApiTypes.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';

/**
 * Cross-project Bulk-Upgrade Wizard modal. Opens from the global
 * Matrix's "Update selected" footer with the list of ticked picks.
 *
 * Flow: load combined preview (one round-trip), render a grouped
 * summary (per project, per pick: from→to + security heads-up), then
 * — gated by `actions.allowInstall` — let the user apply edits only
 * or edits + `npm install --ignore-scripts` per project. The SSE log
 * is appended live so the user can watch progress across all touched
 * projects.
 */
export class BulkUpgradeModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _logEl: HTMLElement|null = null;
    private _picks: ApiBulkUpgradePick[] = [];
    private _activeAbort: AbortController|null = null;

    public async open(picks: ApiBulkUpgradePick[]): Promise<void> {
        this._picks = picks;
        this._mount();
        this._renderLoading();
        try {
            const preview = await Api.matrixUpgradePreview(picks);
            this._render(preview);
        } catch (e) {
            this._renderError((e as Error).message);
        }
    }

    public close(): void {
        this._activeAbort?.abort();
        this._activeAbort = null;
        this._backdrop?.remove();
        this._backdrop = null;
        this._panel = null;
        this._logEl = null;
        this._picks = [];
    }

    private _mount(): void {
        if (this._backdrop) {
            return;
        }
        const backdrop = document.createElement('div');
        backdrop.className = 'bumd-backdrop';
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) {
                this.close();
            }
        });
        document.body.appendChild(backdrop);
        this._backdrop = backdrop;

        const panel = document.createElement('div');
        panel.className = 'bumd-panel';
        backdrop.appendChild(panel);
        this._panel = panel;

        document.addEventListener('keydown', this._onKeyDown);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    private _renderLoading(): void {
        if (!this._panel) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());
        const hint = document.createElement('div');
        hint.className = 'bumd-loading';
        hint.textContent = I18n.t('Planning bulk upgrade for {n} packages …', {n: this._picks.length});
        this._panel.appendChild(hint);
    }

    private _renderError(msg: string): void {
        if (!this._panel) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());
        const err = document.createElement('div');
        err.className = 'bumd-error';
        err.textContent = msg;
        this._panel.appendChild(err);
        this._panel.appendChild(this._renderClose());
    }

    private _render(preview: ApiBulkUpgradePreviewResponse): void {
        if (!this._panel) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());

        const actionable = preview.results.filter(BulkUpgradeModal._isActionable);
        const skipped = preview.results.filter((r) => !BulkUpgradeModal._isActionable(r));

        // Group actionable picks by project so the user sees the
        // per-project blast radius before clicking apply.
        const groups = new Map<string, {name: string; entries: ApiBulkUpgradePreviewResult[]}>();
        for (const r of actionable) {
            const unid = r.pick.projectUnid;
            const projName = 'preview' in r ? r.preview.project.name : unid;
            let g = groups.get(unid);
            if (!g) {
                g = {name: projName, entries: []};
                groups.set(unid, g);
            }
            g.entries.push(r);
        }

        const summary = document.createElement('div');
        summary.className = 'bumd-summary';
        summary.textContent = I18n.t(
            '{actionable} planned, {skipped} skipped — across {projects} project(s)',
            {actionable: actionable.length, skipped: skipped.length, projects: groups.size}
        );
        this._panel.appendChild(summary);

        if (groups.size === 0) {
            const empty = document.createElement('div');
            empty.className = 'bumd-empty';
            empty.textContent = I18n.t('Nothing to apply — every pick was skipped (see list below).');
            this._panel.appendChild(empty);
        } else {
            const list = document.createElement('div');
            list.className = 'bumd-groups';
            for (const [unid, g] of groups.entries()) {
                list.appendChild(this._renderGroup(unid, g.name, g.entries));
            }
            this._panel.appendChild(list);
        }

        if (skipped.length > 0) {
            this._panel.appendChild(this._renderSkipped(skipped));
        }

        this._panel.appendChild(this._renderActions(preview, actionable));
    }

    private _renderHeader(): HTMLElement {
        const head = document.createElement('div');
        head.className = 'bumd-head';
        const title = document.createElement('div');
        title.className = 'bumd-title';
        title.textContent = I18n.t('Bulk Update — {n} selected', {n: this._picks.length});
        head.appendChild(title);
        const close = document.createElement('button');
        close.className = 'bumd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    private _renderClose(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'bumd-actions';
        const btn = document.createElement('button');
        btn.className = 'bumd-btn';
        btn.textContent = I18n.t('Close');
        btn.addEventListener('click', () => this.close());
        wrap.appendChild(btn);
        return wrap;
    }

    private _renderGroup(unid: string, name: string, entries: ApiBulkUpgradePreviewResult[]): HTMLElement {
        const box = document.createElement('div');
        box.className = 'bumd-group';
        box.dataset.unid = unid;
        const head = document.createElement('div');
        head.className = 'bumd-section-head';
        head.textContent = `${name} (${entries.length})`;
        box.appendChild(head);

        for (const entry of entries) {
            if (!('preview' in entry)) {
                continue;
            }
            box.appendChild(this._renderPickRow(entry));
        }

        return box;
    }

    private _renderPickRow(entry: {pick: ApiBulkUpgradePick; preview: ApiUpgradePreviewResponse}): HTMLElement {
        const row = document.createElement('div');
        row.className = 'bumd-pick';

        const main = document.createElement('div');
        main.className = 'bumd-pick-main';
        const nm = document.createElement('span');
        nm.className = 'bumd-pick-name';
        nm.textContent = entry.pick.name;
        main.appendChild(nm);
        const arrow = document.createElement('span');
        arrow.className = 'bumd-pick-arrow';
        arrow.textContent = `${entry.pick.fromRange}  →  ${entry.pick.toRange}`;
        main.appendChild(arrow);
        row.appendChild(main);

        const heads = entry.preview.securityHeadsUp;
        if (heads) {
            const facts: string[] = [];
            if (heads.vulns && heads.vulns.length > 0) {
                facts.push(`CVEs: ${heads.vulns.length}`);
            }
            if (heads.scriptFindings.length > 0) {
                facts.push(`install-scripts: ${heads.scriptFindings.length}`);
            }
            if (heads.maintainer && heads.maintainer.severity !== 'info') {
                facts.push(`maintainer: ${heads.maintainer.severity}`);
            }
            if (heads.churn && heads.churn.severity !== 'info') {
                facts.push(`churn: ${heads.churn.severity}`);
            }
            if (
                heads.license.severity !== 'permissive'
                && heads.license.severity !== 'unknown'
            ) {
                facts.push(`license: ${heads.license.severity}`);
            }
            if (facts.length > 0) {
                const badge = document.createElement('span');
                badge.className = 'bumd-pick-heads';
                badge.textContent = facts.join(' · ');
                row.appendChild(badge);
            }
        }

        return row;
    }

    private _renderSkipped(skipped: ApiBulkUpgradePreviewResult[]): HTMLElement {
        const box = document.createElement('div');
        box.className = 'bumd-skipped';
        const head = document.createElement('div');
        head.className = 'bumd-section-head';
        head.textContent = I18n.t('Skipped ({n})', {n: skipped.length});
        box.appendChild(head);
        for (const r of skipped) {
            if ('preview' in r) {
                continue;
            }
            const line = document.createElement('div');
            line.className = 'bumd-skipped-row';
            line.textContent = `${r.pick.name} · ${r.skipped}${r.msg ? ' — ' + r.msg : ''}`;
            box.appendChild(line);
        }
        return box;
    }

    private _renderActions(
        preview: ApiBulkUpgradePreviewResponse,
        actionable: ApiBulkUpgradePreviewResult[]
    ): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'bumd-actions';

        const disabled = actionable.length === 0;

        const editOnly = document.createElement('button');
        editOnly.className = 'bumd-btn bumd-btn-primary';
        editOnly.textContent = I18n.t('Apply edits only');
        editOnly.disabled = disabled;
        editOnly.addEventListener('click', () => void this._apply('edit'));
        wrap.appendChild(editOnly);

        if (preview.allowInstall) {
            const install = document.createElement('button');
            install.className = 'bumd-btn bumd-btn-risky';
            install.textContent = I18n.t('Apply edits + install per project (--ignore-scripts)');
            install.disabled = disabled;
            install.addEventListener('click', () => void this._apply('install'));
            wrap.appendChild(install);
        } else {
            const note = document.createElement('div');
            note.className = 'bumd-note';
            note.textContent = I18n.t('Install path is disabled — set actions.allowInstall=true in nppm.json to unlock.');
            wrap.appendChild(note);
        }

        const cancel = document.createElement('button');
        cancel.className = 'bumd-btn';
        cancel.textContent = I18n.t('Cancel');
        cancel.addEventListener('click', () => this.close());
        wrap.appendChild(cancel);

        return wrap;
    }

    private async _apply(mode: 'edit'|'install'): Promise<void> {
        if (!this._panel) {
            return;
        }
        const log = document.createElement('div');
        log.className = 'bumd-log';
        const head = document.createElement('div');
        head.className = 'bumd-section-head';
        head.textContent = I18n.t('Live log');
        log.appendChild(head);
        const pre = document.createElement('pre');
        pre.className = 'bumd-log-body';
        log.appendChild(pre);
        this._panel.appendChild(log);
        this._logEl = pre;

        for (const btn of Array.from(this._panel.querySelectorAll('.bumd-btn'))) {
            (btn as HTMLButtonElement).disabled = true;
        }

        const body: ApiBulkUpgradeApplyRequest = {picks: this._picks, mode};
        const abort = new AbortController();
        this._activeAbort = abort;
        try {
            const res = await fetch(Api.matrixUpgradeApplyUrl(), {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body),
                signal: abort.signal
            });
            if (!res.ok || !res.body) {
                this._appendLog(`HTTP ${res.status} ${res.statusText}\n`);
                return;
            }
            await this._consumeSse(res.body, {
                'project-start': (d: {unid: string; name: string; picks: number}) => {
                    this._appendLog(`\n── ${d.name} (${d.picks} pick${d.picks === 1 ? '' : 's'}) ──\n`);
                },
                'project-skip': (d: {unid: string; reason: string}) => {
                    this._appendLog(`  ⤳ ${I18n.t('Project skipped: {reason}', {reason: d.reason})}\n`);
                },
                backup: (d: {unid: string; dir: string; files: string[]}) => {
                    this._appendLog(`  ✓ ${I18n.t('Backup saved to {dir}', {dir: d.dir})}\n`);
                    for (const f of d.files) {
                        this._appendLog(`    · ${f}\n`);
                    }
                },
                'pick-result': (d: {unid: string; name: string; rel: string; changed: boolean}) => {
                    this._appendLog(
                        d.changed
                            ? `  ✓ ${d.name} → ${d.rel}\n`
                            : `  ⤳ ${d.name} ${I18n.t('(no change)')}\n`
                    );
                },
                start: (d: {unid: string; command: string; cwd: string}) => {
                    this._appendLog(`\n  $ ${d.command}\n    (cwd: ${d.cwd})\n\n`);
                },
                stdout: (d: {unid: string; chunk: string}) => this._appendLog(d.chunk),
                stderr: (d: {unid: string; chunk: string}) => this._appendLog(d.chunk),
                end: (d: {unid: string; exitCode: number|null}) => {
                    this._appendLog(
                        `\n  ${I18n.t('Install finished (exit {code})', {code: d.exitCode ?? 'null'})}\n`
                    );
                },
                error: (d: {unid?: string; msg: string}) => {
                    const scope = d.unid ? ` [${d.unid}]` : '';
                    this._appendLog(`\n  ${I18n.t('Error{scope}: {msg}', {scope, msg: d.msg})}\n`);
                },
                done: (d: {totalProjects: number}) => {
                    this._appendLog(
                        `\n${I18n.t('Bulk update finished — {n} project(s) processed', {n: d.totalProjects})}\n`
                    );
                }
            });
        } catch (e) {
            this._appendLog(`\n${(e as Error).message}\n`);
        } finally {
            this._activeAbort = null;
        }
    }

    /**
     * Minimal SSE consumer for `fetch`-style streams. Mirrors the
     * implementation in `UpgradeModal` so the two stay in sync —
     * sharing would require pulling it out into its own module which
     * we'll do once a third consumer shows up.
     */
    private async _consumeSse(
        body: ReadableStream<Uint8Array>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handlers: Record<string, (data: any) => void>
    ): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const {value, done} = await reader.read();
            if (done) {
                break;
            }
            buf += decoder.decode(value, {stream: true});
            let sep = buf.indexOf('\n\n');
            while (sep >= 0) {
                const event = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                sep = buf.indexOf('\n\n');
                BulkUpgradeModal._dispatchEvent(event, handlers);
            }
        }
        if (buf.length > 0) {
            BulkUpgradeModal._dispatchEvent(buf, handlers);
        }
    }

    private static _dispatchEvent(
        raw: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handlers: Record<string, (data: any) => void>
    ): void {
        let name = 'message';
        const dataLines: string[] = [];
        for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) {
                name = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
            }
        }
        if (dataLines.length === 0) {
            return;
        }
        const handler = handlers[name];
        if (!handler) {
            return;
        }
        try {
            handler(JSON.parse(dataLines.join('\n')));
        } catch {
            // Ignore malformed events.
        }
    }

    private _appendLog(text: string): void {
        if (!this._logEl) {
            return;
        }
        this._logEl.textContent += text;
        this._logEl.scrollTop = this._logEl.scrollHeight;
    }

    private static _isActionable(r: ApiBulkUpgradePreviewResult): boolean {
        return 'preview' in r;
    }
}