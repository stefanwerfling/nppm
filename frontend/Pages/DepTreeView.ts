import {hierarchy, tree, HierarchyPointNode} from 'd3-hierarchy';
import {DepGraphNode, DepGraphResponse, DepGraphStatus} from '../../backend/DepGraph/DepGraphBuilder.js';
import {Api} from '../Util/Api.js';
import {I18n} from '../Util/I18n.js';

/**
 * Hierarchy datum the d3-tree layout walks. Each instance is one
 * visual node in the rendered tree — *not* one logical package. The
 * same `name@version` package can appear multiple times in the tree
 * if the dep graph reaches it through different parents (the
 * lockfile's diamond pattern).
 *
 * `pkg` is `null` for the synthetic root (the project itself), for
 * cycle-leaf nodes, and for unresolved dep placeholders.
 *
 * State machine across `children` / `_children` / `_pendingDeps`:
 *  - `children` populated → expanded, rendered
 *  - `_children` populated → previously expanded, now collapsed
 *  - `_pendingDeps` populated → never expanded; on first toggle we
 *    build the immediate children from this raw list (which lets the
 *    initial tree build stop after a fixed depth instead of walking
 *    the whole graph)
 * Any of these may be populated independently; the `_toggle` method
 * is the single place that swaps them around.
 */
type TreeDatum = {
    /** Unique per node in this view (path-based, not pkg-based). */
    key: string;
    label: string;
    pkg: DepGraphNode|null;
    cycle?: boolean;
    children?: TreeDatum[];
    _children?: TreeDatum[];
    _pendingDeps?: {name: string; version: string;}[];
};

const INITIAL_EAGER_DEPTH = 1;

const STATUS_COLOUR: Record<DepGraphStatus, string> = {
    aligned: '#4caf50',
    outdated: '#f0b400',
    cve: '#e85a5a',
    unknown: '#8a8a8a'
};

const NODE_RADIUS = 6;
const ROW_HEIGHT = 22;
const COLUMN_WIDTH = 240;

/**
 * Collapsible D3 tree of the resolved dep-graph. Lives in the 5th
 * project sub-view tab "Tree". Clicking a node expands/collapses its
 * children; the data is fully loaded up-front and walked lazily, so
 * even 1000+-package projects render snappily because we only build
 * the visible subtree at any one time.
 */
export class DepTreeView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _data: DepGraphResponse|null = null;
    private _treeRoot: TreeDatum|null = null;
    private _svg: SVGSVGElement|null = null;
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowInstalled: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowUnused: ((unid: string) => void)|null = null;
    private _onShowVulns: ((unid: string) => void)|null = null;
    private _onShowPr: ((unid: string) => void)|null = null;
    private _onShowTemplate: ((unid: string) => void)|null = null;

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    public onShowDeclared(h: (unid: string) => void): void {
        this._onShowDeclared = h;
    }
    public onShowInstalled(h: (unid: string) => void): void {
        this._onShowInstalled = h;
    }
    public onShowHistory(h: (unid: string) => void): void {
        this._onShowHistory = h;
    }
    public onShowMatrix(h: (unid: string) => void): void {
        this._onShowMatrix = h;
    }
    public onShowUnused(h: (unid: string) => void): void {
        this._onShowUnused = h;
    }
    public onShowVulns(h: (unid: string) => void): void {
        this._onShowVulns = h;
    }
    public onShowPr(h: (unid: string) => void): void {
        this._onShowPr = h;
    }

    public onShowTemplate(h: (unid: string) => void): void {
        this._onShowTemplate = h;
    }

    public async show(unid: string, name: string): Promise<void> {
        this._projectUnid = unid;
        this._projectName = name;
        this._renderLoading();

        try {
            const data = await Api.depGraph(unid);
            if (this._projectUnid !== unid) {
                return;
            }
            this._data = data;
            this._treeRoot = this._buildInitialTree(data);
            this._render();
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
        hint.textContent = I18n.t('Loading dep graph …');
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

    /**
     * Build the initial tree: synthetic root with the project's
     * `rootDeps` as eagerly-built first level. Each first-level node
     * has its grandchildren stashed in `_pendingDeps`, so the upfront
     * cost is bounded by `rootDeps.length + Σ(rootDep.deps.length)`,
     * not the full transitive closure.
     */
    private _buildInitialTree(data: DepGraphResponse): TreeDatum {
        const root: TreeDatum = {
            key: '__root__',
            label: this._projectName ?? '(Projekt)',
            pkg: null,
            children: []
        };

        for (const dep of data.rootDeps) {
            root.children!.push(this._buildNode('__root__', dep, data, INITIAL_EAGER_DEPTH));
        }

        return root;
    }

    /**
     * Build a single tree node. `eagerDepth` controls how far down to
     * recurse *now*: `eagerDepth = 1` builds this node and its direct
     * children, `0` builds only this node and marks `_pendingDeps`,
     * negative is treated as `0`.
     *
     * Cycle detection: if the same `name@version` already appears in
     * the parent's key path (the unique-per-DOM-node identifier we
     * build from `parentKey` + the package coordinate), we emit a
     * leaf marked `cycle: true`. Without this, a self-referential
     * lockfile (rare, but it happens — peer-deps loops, broken
     * vendoring) would recurse forever.
     */
    private _buildNode(
        parentKey: string,
        ref: {name: string; version: string;},
        data: DepGraphResponse,
        eagerDepth: number
    ): TreeDatum {
        const pkgKey = `${ref.name}@${ref.version}`;
        const key = `${parentKey}/${pkgKey}`;

        if (parentKey.split('/').includes(pkgKey)) {
            return {
                key: key,
                label: `${pkgKey} ↻`,
                pkg: null,
                cycle: true
            };
        }

        const pkg = data.packages[pkgKey] ?? null;
        const node: TreeDatum = {
            key: key,
            label: ref.version ? pkgKey : `${ref.name} (?)`,
            pkg: pkg
        };

        if (!pkg || pkg.deps.length === 0) {
            return node;
        }

        if (eagerDepth <= 0) {
            node._pendingDeps = pkg.deps;
            return node;
        }

        node.children = pkg.deps.map((dep) =>
            this._buildNode(key, dep, data, eagerDepth - 1));
        return node;
    }

    private _render(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());

        if (!this._data || !this._treeRoot) {
            return;
        }

        const meta = document.createElement('div');
        meta.className = 'installed-meta';
        meta.textContent = I18n.t(
            '{n} resolved packages, {m} top-level deps. Click a node to expand/collapse its subtree.',
            {n: Object.keys(this._data.packages).length, m: this._data.rootDeps.length}
        );
        this._root.appendChild(meta);

        if (this._data.fromManifestOnly) {
            const note = document.createElement('div');
            note.className = 'installed-meta installed-meta-readonly';
            note.textContent = I18n.t(
                'No lockfile available — showing declared top-level deps only (no transitive resolution).'
            );
            this._root.appendChild(note);
        }

        this._root.appendChild(this._renderLegend());

        const svgHost = document.createElement('div');
        svgHost.className = 'deptree-host';
        this._root.appendChild(svgHost);

        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'deptree-svg');
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'deptree-zoom');
        g.setAttribute('transform', 'translate(40, 20)');
        svg.appendChild(g);
        svgHost.appendChild(svg);

        this._svg = svg;
        this._redraw();
    }

    private _renderLegend(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'deptree-legend';
        const items: {status: DepGraphStatus; label: string;}[] = [
            {status: 'aligned', label: I18n.t('aligned (= latest)')},
            {status: 'outdated', label: I18n.t('outdated')},
            {status: 'cve', label: I18n.t('CVEs known')},
            {status: 'unknown', label: I18n.t('unknown')}
        ];
        for (const item of items) {
            const span = document.createElement('span');
            span.className = 'deptree-legend-item';
            const dot = document.createElement('span');
            dot.className = 'deptree-legend-dot';
            dot.style.background = STATUS_COLOUR[item.status];
            span.appendChild(dot);
            span.appendChild(document.createTextNode(item.label));
            wrap.appendChild(span);
        }
        return wrap;
    }

    /**
     * Re-layout the currently-expanded subtree and paint. Called after
     * every expand/collapse. d3-hierarchy gives us depth-keyed x/y;
     * we render edges + nodes manually into the SVG (no d3-selection
     * lifecycle, since we throw the SVG away each redraw — cheap for
     * the sizes we deal with).
     */
    private _redraw(): void {
        if (!this._svg || !this._treeRoot) {
            return;
        }

        const root = hierarchy<TreeDatum>(this._treeRoot, (d) => d.children);
        const layout = tree<TreeDatum>().nodeSize([ROW_HEIGHT, COLUMN_WIDTH]);
        layout(root);

        const nodes = root.descendants() as HierarchyPointNode<TreeDatum>[];
        const links = root.links() as {
            source: HierarchyPointNode<TreeDatum>;
            target: HierarchyPointNode<TreeDatum>;
        }[];

        let minX = Infinity;
        let maxX = -Infinity;
        let maxY = 0;
        for (const n of nodes) {
            if (n.x < minX) {minX = n.x;}
            if (n.x > maxX) {maxX = n.x;}
            if (n.y > maxY) {maxY = n.y;}
        }
        const height = maxX - minX + 60;
        const width = maxY + COLUMN_WIDTH;

        this._svg.setAttribute('width', String(width));
        this._svg.setAttribute('height', String(height));

        const g = this._svg.querySelector('.deptree-zoom') as SVGGElement;
        g.setAttribute('transform', `translate(40, ${-minX + 30})`);
        while (g.firstChild) {
            g.removeChild(g.firstChild);
        }

        const ns = 'http://www.w3.org/2000/svg';
        // Links first so they go behind the nodes.
        for (const link of links) {
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('class', 'deptree-link');
            // Smooth horizontal connector.
            const sx = link.source.y;
            const sy = link.source.x;
            const tx = link.target.y;
            const ty = link.target.x;
            const mx = (sx + tx) / 2;
            path.setAttribute('d', `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`);
            g.appendChild(path);
        }

        for (const n of nodes) {
            const node = document.createElementNS(ns, 'g');
            node.setAttribute('class', 'deptree-node');
            node.setAttribute('transform', `translate(${n.y}, ${n.x})`);

            const datum = n.data;
            let colour: string;
            if (datum.cycle) {
                colour = '#999';
            } else if (datum.pkg) {
                colour = STATUS_COLOUR[datum.pkg.status];
            } else {
                colour = datum.label.endsWith('(?)') ? STATUS_COLOUR.unknown : '#3574f0';
            }
            const hasCollapsed = (datum._children?.length ?? 0) > 0
                || (datum._pendingDeps?.length ?? 0) > 0;
            const hasExpanded = (datum.children?.length ?? 0) > 0;

            const circle = document.createElementNS(ns, 'circle');
            circle.setAttribute('r', String(NODE_RADIUS));
            circle.setAttribute('fill', colour);
            // Ring outline indicates that the node has hidden children.
            circle.setAttribute('stroke', hasCollapsed ? '#dcdcdc' : 'transparent');
            circle.setAttribute('stroke-width', '2');
            node.appendChild(circle);

            const text = document.createElementNS(ns, 'text');
            text.setAttribute('dy', '0.32em');
            text.setAttribute('x', String(NODE_RADIUS + 6));
            text.textContent = datum.label;
            if (datum.pkg && datum.pkg.status === 'cve') {
                text.setAttribute('class', 'deptree-text deptree-text-cve');
            } else {
                text.setAttribute('class', 'deptree-text');
            }
            node.appendChild(text);

            // Tooltip lives on the group via <title>.
            if (datum.pkg) {
                const title = document.createElementNS(ns, 'title');
                const lines = [
                    `${datum.pkg.name}@${datum.pkg.version}`,
                    `Status: ${datum.pkg.status}`
                ];
                if (datum.pkg.latestVersion) {
                    lines.push(`Latest: ${datum.pkg.latestVersion}`);
                }
                if (datum.pkg.vulnCount > 0) {
                    lines.push(`CVEs: ${datum.pkg.vulnCount}`);
                }
                title.textContent = lines.join('\n');
                node.appendChild(title);
            }

            if (hasCollapsed || hasExpanded) {
                node.classList.add('deptree-node-clickable');
                node.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._toggle(datum);
                });
            }

            g.appendChild(node);
        }
    }

    /**
     * Toggle a node's expanded/collapsed state. Three transitions:
     *  1. Expanded → Collapsed: move `children` to `_children`.
     *  2. Re-expand (was collapsed): move `_children` back to `children`.
     *  3. First-time expand from `_pendingDeps`: build children now
     *     (one level eager so the grandchildren show as ring-marked).
     */
    private _toggle(datum: TreeDatum): void {
        // (1) collapsing
        if (datum.children && datum.children.length > 0) {
            datum._children = datum.children;
            datum.children = undefined;
            this._redraw();
            return;
        }

        // (2) re-expanding
        if (datum._children && datum._children.length > 0) {
            datum.children = datum._children;
            datum._children = undefined;
            this._redraw();
            return;
        }

        // (3) first-time expand
        if (datum._pendingDeps && datum._pendingDeps.length > 0 && this._data) {
            datum.children = datum._pendingDeps.map((dep) =>
                this._buildNode(datum.key, dep, this._data!, 0));
            datum._pendingDeps = undefined;
            this._redraw();
        }
    }

    /**
     * Five-button toggle in the project-detail header. Tree is the
     * active one here; the four others are routed back through Nppm.
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

        const treeBtn = document.createElement('button');
        treeBtn.className = 'installed-toggle-btn installed-toggle-btn-active';
        treeBtn.textContent = I18n.t('Tree');
        toggle.appendChild(treeBtn);

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

        header.appendChild(toggle);
        return header;
    }

}