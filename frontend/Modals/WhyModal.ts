import {ApiDepGraphResponse} from '../../shared/Api/ApiTypes.js';
import {Api} from '../Api.js';
import {I18n} from '../I18n.js';

/**
 * `npm why`-style reverse-lookup modal. Opened from `InstalledView` on
 * a (`name`, `version`) row — fetches the project's flat dep-graph
 * once, inverts the edges, then walks from the target back to every
 * root dependency, rendering each chain `root → … → target`.
 *
 * Both the depgraph response and the computed reverse map are cached
 * per project on the instance so opening the modal for several rows
 * in a row only triggers one network round-trip.
 */
export class WhyModal {

    private _backdrop: HTMLElement|null = null;
    private _panel: HTMLElement|null = null;
    private _cache: Map<string, ApiDepGraphResponse> = new Map();

    public async open(projectUnid: string, name: string, version: string): Promise<void> {
        this._mount(name, version);
        this._renderLoading();
        try {
            const graph = await this._loadGraph(projectUnid);
            this._render(graph, name, version);
        } catch (e) {
            this._renderError((e as Error).message);
        }
    }

    public close(): void {
        this._backdrop?.remove();
        this._backdrop = null;
        this._panel = null;
        document.removeEventListener('keydown', this._onKeyDown);
    }

    private async _loadGraph(unid: string): Promise<ApiDepGraphResponse> {
        const cached = this._cache.get(unid);
        if (cached) {
            return cached;
        }
        const fresh = await Api.depGraph(unid);
        this._cache.set(unid, fresh);
        return fresh;
    }

    private _mount(name: string, version: string): void {
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
        panel.className = 'umd-panel';
        backdrop.appendChild(panel);
        this._panel = panel;

        this._panel.appendChild(this._renderHeader(name, version));
        document.addEventListener('keydown', this._onKeyDown);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    private _renderHeader(name: string, version: string): HTMLElement {
        const head = document.createElement('div');
        head.className = 'umd-head';
        const title = document.createElement('div');
        title.className = 'umd-title';
        title.textContent = I18n.t('Why {pkg}?', {pkg: `${name}@${version}`});
        head.appendChild(title);
        const close = document.createElement('button');
        close.className = 'umd-close';
        close.textContent = '×';
        close.title = I18n.t('Close');
        close.addEventListener('click', () => this.close());
        head.appendChild(close);
        return head;
    }

    private _renderLoading(): void {
        if (!this._panel) {
            return;
        }
        const hint = document.createElement('div');
        hint.className = 'umd-loading';
        hint.textContent = I18n.t('Loading dep graph …');
        this._panel.appendChild(hint);
    }

    private _renderError(msg: string): void {
        if (!this._panel) {
            return;
        }
        const err = document.createElement('div');
        err.className = 'umd-error';
        err.textContent = msg;
        this._panel.appendChild(err);
    }

    private _render(graph: ApiDepGraphResponse, name: string, version: string): void {
        if (!this._panel) {
            return;
        }
        // Drop the loading hint while keeping the header in place.
        for (const node of Array.from(this._panel.querySelectorAll('.umd-loading'))) {
            node.remove();
        }

        const targetKey = `${name}@${version}`;
        const rootKeys = new Set<string>();
        for (const r of graph.rootDeps) {
            if (r.version) {
                rootKeys.add(`${r.name}@${r.version}`);
            }
        }

        const isRoot = rootKeys.has(targetKey);
        const present = Boolean(graph.packages[targetKey]);

        const meta = document.createElement('div');
        meta.className = 'wmd-meta';
        if (!present) {
            meta.textContent = I18n.t('Package not found in the dep graph — was the analyser run on a different lockfile?');
            this._panel.appendChild(meta);
            return;
        }
        meta.textContent = isRoot
            ? I18n.t('This is a direct (top-level) dependency of the project.')
            : I18n.t('This package is pulled in transitively. Chains:');
        this._panel.appendChild(meta);

        if (isRoot) {
            return;
        }

        const reverse = WhyModal.buildReverseMap(graph);
        const paths = WhyModal.collectPaths(targetKey, reverse, rootKeys);

        if (paths.length === 0) {
            const note = document.createElement('div');
            note.className = 'umd-note';
            note.textContent = I18n.t('No parent could be resolved — the lockfile may be inconsistent.');
            this._panel.appendChild(note);
            return;
        }

        const list = document.createElement('div');
        list.className = 'wmd-paths';
        for (const path of paths) {
            const row = document.createElement('pre');
            row.className = 'wmd-path';
            row.textContent = path.join('  →  ');
            list.appendChild(row);
        }
        this._panel.appendChild(list);
    }

    /**
     * Build the dependent-map: for every edge `parent → child` in the
     * forward graph, record `child → parent`. Both keys and values are
     * `name@version` strings so the BFS just walks lookups. Public for
     * test access; consumers should use `open()`.
     */
    public static buildReverseMap(graph: ApiDepGraphResponse): Map<string, string[]> {
        const reverse = new Map<string, string[]>();
        for (const [parentKey, node] of Object.entries(graph.packages)) {
            for (const dep of node.deps) {
                if (!dep.version) {
                    continue;
                }
                const childKey = `${dep.name}@${dep.version}`;
                let list = reverse.get(childKey);
                if (!list) {
                    list = [];
                    reverse.set(childKey, list);
                }
                list.push(parentKey);
            }
        }
        return reverse;
    }

    /**
     * BFS upward from `target` through the reverse edges. Each frontier
     * entry carries the running chain (root-first); when a node is in
     * `rootKeys` (or has no further parents) the chain is emitted. A
     * `seen` set per chain prevents infinite walks on cyclic graphs
     * (rare but possible with peer-dep loops).
     *
     * Caps both the number of chains and the per-chain depth to keep
     * the modal readable for very-deeply-nested deps.
     */
    public static collectPaths(
        target: string,
        reverse: Map<string, string[]>,
        rootKeys: Set<string>
    ): string[][] {
        const MAX_PATHS = 30;
        const MAX_DEPTH = 12;

        const queue: {chain: string[]; seen: Set<string>;}[] = [
            {chain: [target], seen: new Set([target])}
        ];
        const out: string[][] = [];

        while (queue.length > 0 && out.length < MAX_PATHS) {
            const {chain, seen} = queue.shift()!;
            const head = chain[0];
            const parents = reverse.get(head) ?? [];

            if (rootKeys.has(head) || parents.length === 0) {
                if (head !== target) {
                    out.push(chain);
                }
                continue;
            }
            if (chain.length >= MAX_DEPTH) {
                out.push(['…', ...chain]);
                continue;
            }

            for (const parent of parents) {
                if (seen.has(parent)) {
                    continue;
                }
                const nextSeen = new Set(seen);
                nextSeen.add(parent);
                queue.push({chain: [parent, ...chain], seen: nextSeen});
            }
        }
        return out;
    }

}