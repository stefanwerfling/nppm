import {I18n} from '../Util/I18n.js';

/**
 * One key per per-project sub-view. The orchestrator (Nppm) wires a
 * handler per key; each sub-view passes its own key as `active` so
 * the matching button renders highlighted and its click is a no-op.
 */
export type ProjectNavKey =
    'declared' | 'installed' | 'history' | 'matrix' | 'tree'
    | 'unused' | 'vulns' | 'pr' | 'template' | 'source';

type Tab = {key: ProjectNavKey; label: string;};

/**
 * Tab order = visual order in the header strip. Adding a new
 * per-project view is now a one-line edit here plus a wire-up in
 * Nppm — no more touching every sub-view to extend the toggle.
 */
const TABS: readonly Tab[] = [
    {key: 'declared', label: 'Declared'},
    {key: 'installed', label: 'Installed'},
    {key: 'history', label: 'History'},
    {key: 'matrix', label: 'Matrix'},
    {key: 'tree', label: 'Tree'},
    {key: 'unused', label: 'Unused'},
    {key: 'vulns', label: 'Vulns'},
    {key: 'pr', label: 'PR'},
    {key: 'template', label: 'Template'},
    {key: 'source', label: 'Code-Map'}
];

/**
 * Header-toggle dispatcher shared by every per-project sub-view.
 *
 * Each sub-view used to carry its own list of nine optional
 * `_onShowX` fields, nine `onShowX()` setters, and a copy-pasted
 * button-strip render — roughly a hundred lines of boilerplate per
 * view, ten views in the codebase. This widget consolidates the
 * lot: the orchestrator registers ten handlers once, every view
 * gets the same toggle by calling `renderToggle(unid, activeKey)`,
 * and adding a new tab is a one-line edit to `TABS`.
 *
 * The `unid|null` argument is the currently-shown project id so
 * the handler can fire `(unid) => void`. Sub-views call
 * `renderToggle(null, …)` while loading; the buttons stay clickable
 * but the click is a no-op until the unid arrives, mirroring the
 * old behaviour.
 */
export class ProjectNav {

    private readonly _handlers: Map<ProjectNavKey, (unid: string) => void> = new Map();

    public on(key: ProjectNavKey, handler: (unid: string) => void): this {
        this._handlers.set(key, handler);
        return this;
    }

    public renderToggle(unid: string|null, active: ProjectNavKey): HTMLElement {
        const toggle = document.createElement('div');
        toggle.className = 'installed-toggle';

        for (const tab of TABS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'installed-toggle-btn';
            if (tab.key === active) {
                btn.classList.add('installed-toggle-btn-active');
            }
            btn.textContent = I18n.t(tab.label);
            if (tab.key !== active) {
                btn.addEventListener('click', () => {
                    const handler = this._handlers.get(tab.key);
                    if (unid && handler) {
                        handler(unid);
                    }
                });
            }
            toggle.appendChild(btn);
        }
        return toggle;
    }

}