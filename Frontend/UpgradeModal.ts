import {
    ApiLifecycleScript,
    ApiLifecycleScriptsResponse,
    ApiUpgradePreviewResponse,
    ApiUpgradeRequest
} from '../Api/ApiTypes.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';

/**
 * Inputs the orchestrator hands the modal when an outdated cell is
 * clicked. `cellRange` is the range string from the matrix cell —
 * used for the modal heading and as the "from" sanity-check; the
 * backend re-reads the on-disk truth before mutating.
 */
export type UpgradeRequestSeed = {
    projectUnid: string;
    projectName: string;
    workspace?: string;
    name: string;
    depType: 'dependency'|'dev'|'peer'|'optional';
    fromRange: string;
    /**
     * Pre-filled target range. Typically the registry latest with a
     * `^` prefix — the user can adjust in the input before applying.
     */
    toRange: string;
};

/**
 * The Upgrade modal — opened on outdated-cell click. Implements the
 * three-section flow: preflight (security heads-up), diff (planned
 * package.json change), action (edit-only vs edit+install). After a
 * successful install it also loads the lifecycle-scripts list so
 * the user can re-run individual hooks via `npm rebuild <pkg>`.
 *
 * One instance is mounted per Nppm session and reused across cell
 * clicks; `open()` resets state and `close()` clears DOM listeners.
 */
export class UpgradeModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _logEl: HTMLElement|null = null;
    private _seed: UpgradeRequestSeed|null = null;
    private _activeAbort: AbortController|null = null;
    private _onAfterApply: (() => void)|null = null;

    /**
     * Register a callback that fires after a successful apply.
     * Triggered once per `open()` cycle — either after `edit-done`
     * (mode = edit, no install follows) or after the install `end`
     * event (mode = install). Nppm uses this to reload the
     * per-project matrix so the user sees the bumped range without
     * having to re-navigate.
     */
    public onAfterApply(handler: () => void): void {
        this._onAfterApply = handler;
    }

    public async open(seed: UpgradeRequestSeed): Promise<void> {
        this._seed = seed;
        this._mount();
        this._renderLoading();
        try {
            const preview = await Api.upgradePreview(seed.projectUnid, this._buildRequest());
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
        this._seed = null;
    }

    private _buildRequest(): ApiUpgradeRequest {
        const s = this._seed!;
        return {
            workspace: s.workspace,
            name: s.name,
            depType: s.depType,
            fromRange: s.fromRange,
            toRange: s.toRange
        };
    }

    private _mount(): void {
        if (this._backdrop) {
            return;
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

    private _renderLoading(): void {
        if (!this._panel || !this._seed) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());
        const hint = document.createElement('div');
        hint.className = 'umd-loading';
        hint.textContent = I18n.t('Loading upgrade preview …');
        this._panel.appendChild(hint);
    }

    private _renderError(msg: string): void {
        if (!this._panel) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());
        const err = document.createElement('div');
        err.className = 'umd-error';
        err.textContent = msg;
        this._panel.appendChild(err);
        this._panel.appendChild(this._renderClose());
    }

    private _render(preview: ApiUpgradePreviewResponse): void {
        if (!this._panel) {
            return;
        }
        this._panel.innerHTML = '';
        this._panel.appendChild(this._renderHeader());

        // Plan summary.
        const plan = document.createElement('div');
        plan.className = 'umd-plan';
        plan.textContent = I18n.t('Plan: {rel}', {rel: preview.packageJsonRel || 'package.json'});
        this._panel.appendChild(plan);

        // No-op short-circuit — the input was already on the target
        // range. Display a friendly message + close.
        if (preview.before === preview.after) {
            const noop = document.createElement('div');
            noop.className = 'umd-noop';
            noop.textContent = I18n.t('No change — already at {range}', {range: preview.request.toRange});
            this._panel.appendChild(noop);
            this._panel.appendChild(this._renderClose());
            return;
        }

        if (preview.latestResolvedVersion) {
            const tv = document.createElement('div');
            tv.className = 'umd-target';
            tv.textContent = `${I18n.t('Target version')}: ${preview.request.name}@${preview.latestResolvedVersion}`;
            this._panel.appendChild(tv);
        }

        if (preview.securityHeadsUp) {
            this._panel.appendChild(this._renderHeadsUp(preview.securityHeadsUp));
        }

        this._panel.appendChild(this._renderDiff(preview));
        this._panel.appendChild(this._renderActions(preview));
    }

    private _renderHeader(): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = I18n.t('Upgrade {name}', {name: this._seed?.name ?? ''});
        head.appendChild(title);
        const close = document.createElement('button');
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    private _renderClose(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'umd-actions';
        const btn = document.createElement('button');
        btn.className = 'umd-btn';
        btn.textContent = I18n.t('Close');
        btn.addEventListener('click', () => this.close());
        wrap.appendChild(btn);
        return wrap;
    }

    /**
     * Three-line summary derived from the SecurityReport: vuln IDs,
     * lifecycle script count, maintainer change. Kept short on
     * purpose — the user can drill into the full report from the
     * existing detail panel; this is just enough to inform the
     * apply-button choice.
     */
    private _renderHeadsUp(report: NonNullable<ApiUpgradePreviewResponse['securityHeadsUp']>): HTMLElement {
        const box = document.createElement('div');
        box.className = 'umd-heads';
        const head = document.createElement('div');
        head.className = 'umd-section-head';
        head.textContent = I18n.t('Security heads-up on the target');
        box.appendChild(head);

        const facts: string[] = [];
        if (report.vulns && report.vulns.length > 0) {
            facts.push(`CVEs: ${report.vulns.length}`);
        }
        if (report.scriptFindings.length > 0) {
            facts.push(`install-scripts: ${report.scriptFindings.length}`);
        }
        if (report.maintainer && report.maintainer.severity !== 'info') {
            facts.push(`maintainer: ${report.maintainer.severity}`);
        }
        if (report.churn && report.churn.severity !== 'info') {
            facts.push(`churn: ${report.churn.severity}`);
        }
        if (report.license.severity !== 'permissive' && report.license.severity !== 'unknown') {
            facts.push(`license: ${report.license.severity}`);
        }

        const body = document.createElement('div');
        body.className = 'umd-heads-body';
        body.textContent = facts.length > 0 ? facts.join(' · ') : '✓';
        box.appendChild(body);
        return box;
    }

    private _renderDiff(preview: ApiUpgradePreviewResponse): HTMLElement {
        const box = document.createElement('div');
        box.className = 'umd-diff';
        const head = document.createElement('div');
        head.className = 'umd-section-head';
        head.textContent = I18n.t('Diff (package.json)');
        box.appendChild(head);

        const beforeLines = preview.before.split('\n');
        const afterLines = preview.after.split('\n');
        const pre = document.createElement('pre');
        pre.className = 'umd-diff-body';
        // Show only the changed lines + 2 of context on each side.
        const n = Math.max(beforeLines.length, afterLines.length);
        const changedIdx: number[] = [];
        for (let i = 0; i < n; i++) {
            if (beforeLines[i] !== afterLines[i]) {
                changedIdx.push(i);
            }
        }
        const ctx = new Set<number>();
        for (const i of changedIdx) {
            for (let k = -2; k <= 2; k++) {
                ctx.add(i + k);
            }
        }
        const lines: string[] = [];
        const sorted = [...ctx].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
        let last = -2;
        for (const i of sorted) {
            if (i - last > 1) {
                lines.push('@@');
            }
            last = i;
            const b = beforeLines[i] ?? '';
            const a = afterLines[i] ?? '';
            if (b === a) {
                lines.push(`  ${b}`);
            } else {
                if (b) lines.push(`- ${b}`);
                if (a) lines.push(`+ ${a}`);
            }
        }
        pre.textContent = lines.join('\n');
        box.appendChild(pre);
        return box;
    }

    private _renderActions(preview: ApiUpgradePreviewResponse): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'umd-actions';

        const editOnly = document.createElement('button');
        editOnly.className = 'umd-btn umd-btn-primary';
        editOnly.textContent = I18n.t('Apply edit only');
        editOnly.addEventListener('click', () => void this._apply('edit', preview));
        wrap.appendChild(editOnly);

        if (preview.allowInstall) {
            const install = document.createElement('button');
            install.className = 'umd-btn umd-btn-risky';
            install.textContent = I18n.t('Apply edit + install (--ignore-scripts)');
            install.addEventListener('click', () => void this._apply('install', preview));
            wrap.appendChild(install);
        } else {
            const note = document.createElement('div');
            note.className = 'umd-note';
            note.textContent = I18n.t('Install path is disabled — set actions.allowInstall=true in nppm.json to unlock.');
            wrap.appendChild(note);
        }

        const cancel = document.createElement('button');
        cancel.className = 'umd-btn';
        cancel.textContent = I18n.t('Cancel');
        cancel.addEventListener('click', () => this.close());
        wrap.appendChild(cancel);

        return wrap;
    }

    private async _apply(mode: 'edit'|'install', preview: ApiUpgradePreviewResponse): Promise<void> {
        if (!this._seed || !this._panel) {
            return;
        }
        // Replace the action area with a streaming log view. The
        // header stays so the user can still close the modal.
        const log = document.createElement('div');
        log.className = 'umd-log';
        const head = document.createElement('div');
        head.className = 'umd-section-head';
        head.textContent = I18n.t('Live log');
        log.appendChild(head);
        const pre = document.createElement('pre');
        pre.className = 'umd-log-body';
        log.appendChild(pre);
        this._panel.appendChild(log);
        this._logEl = pre;

        // Disable the action buttons now that we're committing.
        for (const btn of Array.from(this._panel.querySelectorAll('.umd-btn'))) {
            (btn as HTMLButtonElement).disabled = true;
        }

        const body: ApiUpgradeRequest & {mode: 'edit'|'install'} = {
            ...this._buildRequest(),
            mode
        };
        const abort = new AbortController();
        this._activeAbort = abort;
        try {
            const res = await fetch(Api.upgradeApplyUrl(this._seed.projectUnid), {
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
                'edit-done': (data: {rel: string; backupDir: string; backupFiles: string[]}) => {
                    this._appendLog(`✓ ${I18n.t('Backup saved to {dir}', {dir: data.backupDir})}\n`);
                    this._appendLog(`✓ Edited ${data.rel}\n`);
                    if (mode === 'edit') {
                        this._appendLog(`\n${I18n.t('Run `{cmd}` once you\'re ready to install.', {cmd: 'npm install'})}\n`);
                        // Edit-only path completes here — no install
                        // follows, so this is the right moment to
                        // notify the orchestrator. The install path
                        // fires on `end` below instead.
                        this._onAfterApply?.();
                    }
                },
                start: (data: {command: string; cwd: string}) => {
                    this._appendLog(`\n$ ${data.command}\n  (cwd: ${data.cwd})\n\n`);
                },
                stdout: (data: {chunk: string}) => this._appendLog(data.chunk),
                stderr: (data: {chunk: string}) => this._appendLog(data.chunk),
                end: (data: {exitCode: number|null}) => {
                    this._appendLog(`\n${I18n.t('Install finished (exit {code})', {code: data.exitCode ?? 'null'})}\n`);
                    if (mode === 'install') {
                        void this._loadLifecycleScripts(preview);
                        this._onAfterApply?.();
                    }
                },
                error: (data: {msg: string}) => {
                    this._appendLog(`\n${I18n.t('Install failed: {msg}', {msg: data.msg})}\n`);
                }
            });
        } catch (e) {
            this._appendLog(`\n${(e as Error).message}\n`);
        } finally {
            this._activeAbort = null;
        }
    }

    private async _loadLifecycleScripts(preview: ApiUpgradePreviewResponse): Promise<void> {
        if (!this._panel || !this._seed) {
            return;
        }
        try {
            const data = await Api.lifecycleScripts(this._seed.projectUnid);
            this._panel.appendChild(this._renderLifecycle(data, preview));
        } catch (e) {
            this._appendLog(`\nlifecycle: ${(e as Error).message}\n`);
        }
    }

    private _renderLifecycle(data: ApiLifecycleScriptsResponse, preview: ApiUpgradePreviewResponse): HTMLElement {
        const box = document.createElement('div');
        box.className = 'umd-lifecycle';
        const head = document.createElement('div');
        head.className = 'umd-section-head';
        head.textContent = I18n.t('Lifecycle scripts skipped by --ignore-scripts');
        box.appendChild(head);

        if (data.scripts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'umd-note';
            empty.textContent = I18n.t('No lifecycle hooks found in node_modules — nothing to run.');
            box.appendChild(empty);
            return box;
        }

        for (const s of data.scripts) {
            box.appendChild(this._renderLifecycleRow(s, data.allowInstall, preview));
        }
        return box;
    }

    private _renderLifecycleRow(
        s: ApiLifecycleScript,
        allowInstall: boolean,
        preview: ApiUpgradePreviewResponse
    ): HTMLElement {
        const row = document.createElement('div');
        row.className = 'umd-lifecycle-row';
        const head = document.createElement('div');
        head.className = 'umd-lifecycle-head';
        head.textContent = `${s.name}@${s.version} · ${s.hook}`;
        row.appendChild(head);

        const body = document.createElement('pre');
        body.className = 'umd-lifecycle-body';
        body.textContent = s.script;
        row.appendChild(body);

        const cmd = `npm rebuild ${s.name}`;
        const manual = document.createElement('div');
        manual.className = 'umd-note';
        manual.textContent = I18n.t('Manual: {cmd}', {cmd});
        row.appendChild(manual);

        if (allowInstall) {
            const run = document.createElement('button');
            run.className = 'umd-btn umd-btn-risky';
            run.textContent = I18n.t('Run');
            run.addEventListener('click', () => void this._runScript(s, preview));
            row.appendChild(run);
        }
        return row;
    }

    private async _runScript(s: ApiLifecycleScript, preview: ApiUpgradePreviewResponse): Promise<void> {
        if (!this._seed) {
            return;
        }
        this._appendLog(`\n${I18n.t('Running {hook} for {name} …', {hook: s.hook, name: s.name})}\n`);
        const abort = new AbortController();
        this._activeAbort = abort;
        try {
            const res = await fetch(Api.lifecycleRunUrl(this._seed.projectUnid), {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: s.name}),
                signal: abort.signal
            });
            if (!res.ok || !res.body) {
                this._appendLog(`HTTP ${res.status} ${res.statusText}\n`);
                return;
            }
            await this._consumeSse(res.body, {
                start: (data: {command: string; cwd: string}) => {
                    this._appendLog(`\n$ ${data.command}\n  (cwd: ${data.cwd})\n\n`);
                },
                stdout: (data: {chunk: string}) => this._appendLog(data.chunk),
                stderr: (data: {chunk: string}) => this._appendLog(data.chunk),
                end: (data: {exitCode: number|null}) => {
                    this._appendLog(`\n${I18n.t('Script finished (exit {code})', {code: data.exitCode ?? 'null'})}\n`);
                },
                error: (data: {msg: string}) => this._appendLog(`\n${data.msg}\n`)
            });
        } catch (e) {
            this._appendLog(`\n${(e as Error).message}\n`);
        } finally {
            this._activeAbort = null;
        }
        // Re-render the lifecycle section so the row's "Run" button
        // re-enables; we intentionally keep the list around so the
        // user can hit several hooks in sequence.
        void this._loadLifecycleScripts(preview);
    }

    /**
     * Minimal SSE consumer for `fetch`-style streams. Splits on
     * `\n\n` events, looks at the `event:` and `data:` lines, and
     * dispatches to `handlers[event]`. Tolerant of partial chunks at
     * the buffer boundary — incomplete events stay in the buffer
     * until the next read fills them in.
     */
    private async _consumeSse(
        body: ReadableStream<Uint8Array>,
        // SSE payloads come from our own backend; trust the shape at the
// edge of the dispatcher so each callback can declare its narrow type.
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
                UpgradeModal._dispatchEvent(event, handlers);
            }
        }
        if (buf.length > 0) {
            UpgradeModal._dispatchEvent(buf, handlers);
        }
    }

    private static _dispatchEvent(raw: string, // SSE payloads come from our own backend; trust the shape at the
// edge of the dispatcher so each callback can declare its narrow type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
handlers: Record<string, (data: any) => void>): void {
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
            // Ignore malformed events — log silently rather than tear
            // down the modal mid-stream.
        }
    }

    private _appendLog(text: string): void {
        if (!this._logEl) {
            return;
        }
        this._logEl.textContent += text;
        this._logEl.scrollTop = this._logEl.scrollHeight;
    }
}