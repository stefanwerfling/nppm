import {ApiSelfCodeResponse, ApiSourceGraphResponse} from '../../shared/Api/ApiTypes.js';
import {PatternFinding, PatternSeverity} from '../../backend/Security/PatternScanner.js';
import {SelfCodeFileScore} from '../../backend/SelfCode/SelfCode.js';
import {SourceFile} from '../../backend/SourceGraph/SourceGraph.js';
import {Api} from '../Util/Api.js';
import {EditorUrl} from '../Util/EditorUrl.js';
import {I18n} from '../Util/I18n.js';

/**
 * Severity → ring colour. Same green/amber/red ladder as the
 * dashboard rings so the visual vocabulary stays consistent across
 * views.
 */
const SEVERITY_RING: Record<PatternSeverity, string> = {
    info: '#f0b400',
    warn: '#ff8a65',
    risk: '#e85a5a'
};
const CLEAN_RING = '#4caf50';

/**
 * Categorical palette for the colour-by-folder mode. Twelve hues
 * picked to stay distinguishable side-by-side on both light and dark
 * backgrounds. Folders are assigned by file-count rank; once the
 * palette is exhausted, remaining folders cycle back to the start —
 * the legend still tells the user which folder owns which colour, so
 * cycle-collisions are visually clear rather than misleading.
 */
const FOLDER_PALETTE: readonly string[] = [
    '#3574f0', '#4caf50', '#f0b400', '#a59bd6', '#e85a5a',
    '#26a69a', '#ff8a65', '#7e57c2', '#9ccc65', '#5c6bc0',
    '#ec407a', '#8d6e63'
];
/** Fallback grey for files at the project root (no top-level folder). */
const ROOT_COLOUR = '#7a8aa1';

const CANVAS_WIDTH = 1100;
const CANVAS_HEIGHT = 700;
const NODE_MIN_RADIUS = 3;
const NODE_MAX_RADIUS = 12;
const HULL_PADDING = 30;
/**
 * Hard cap on rendered files. The force simulation is O(N²) per
 * frame (hand-rolled, no Barnes-Hut); above this size browser
 * interactivity tanks. When a project exceeds the cap we keep the
 * highest-degree nodes (the structurally most-connected files) and
 * tell the user how many we dropped.
 */
const MAX_NODES = 350;
/** Threshold above which the simulation switches to "fast cool" tuning. */
const LARGE_GRAPH_NODES = 200;

type SimNode = {
    file: SourceFile;
    folder: string;
    radius: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Pinned coordinates (drag handle); when set, the tick clamps `x,y` to these. */
    fx: number|null;
    fy: number|null;
};

type SimEdge = {
    from: SimNode;
    to: SimNode;
};

/**
 * Live simulation state. Replaces the single-shot `_simulate` model
 * so the layout breathes (the codeflow "force-graph" look) and the
 * user can drag nodes around. Held on the view so `show()` for a
 * different project can cancel the previous RAF loop before starting
 * the next one.
 */
type ActiveSim = {
    nodes: SimNode[];
    edges: SimEdge[];
    folderAnchors: Map<string, {x: number; y: number;}>;
    folderColours: Map<string, string>;
    edgesByNode: Map<SimNode, SimEdge[]>;
    nodeGroups: Map<SimNode, SVGGElement>;
    edgePaths: Map<SimEdge, SVGPathElement>;
    hullLayer: SVGGElement;
    svgNs: string;
    alpha: number;
    tickCount: number;
    rafHandle: number|null;
    cancelled: boolean;
    /**
     * Per-file self-code score, indexed by `SourceFile.id`. Populated
     * after the async self-code scan resolves; until then nodes
     * render in folder colour only (no ring). Driving the score and
     * findings off the same map keeps the click panel + the visual
     * ring strictly in sync.
     */
    selfCode: Map<string, SelfCodeFileScore>;
};

/**
 * Source-file import graph view. Hand-rolled force-directed layout
 * with the codeflow "folder-cluster" look: nodes are pulled toward
 * their top-level folder's grid anchor, then repulsion + link springs
 * settle them into clusters. A live `requestAnimationFrame` loop
 * keeps the simulation breathing so the user can drag individual
 * nodes and watch the rest of the graph reflow.
 *
 * No D3-force dependency: every force (charge, link spring, folder
 * attraction, collision) is hand-rolled. Bezier-curved edges and
 * per-folder convex hull overlays complete the visual match with
 * codeflow's "Color by Folder + Graph" view.
 */
export class SourceGraphView {

    private readonly _root: HTMLElement;
    private _projectUnid: string|null = null;
    private _projectName: string|null = null;
    private _projectRoot: string|undefined;
    private _editor: string|undefined;
    private _panelEl: HTMLElement|null = null;
    private _onShowDeclared: ((unid: string) => void)|null = null;
    private _onShowInstalled: ((unid: string) => void)|null = null;
    private _onShowHistory: ((unid: string) => void)|null = null;
    private _onShowMatrix: ((unid: string) => void)|null = null;
    private _onShowTree: ((unid: string) => void)|null = null;
    private _onShowUnused: ((unid: string) => void)|null = null;
    private _onShowVulns: ((unid: string) => void)|null = null;
    private _onShowPr: ((unid: string) => void)|null = null;
    private _onShowTemplate: ((unid: string) => void)|null = null;
    private _sim: ActiveSim|null = null;

    public constructor(root: HTMLElement) {
        this._root = root;
    }

    public onShowDeclared(h: (unid: string) => void): void {this._onShowDeclared = h;}
    public onShowInstalled(h: (unid: string) => void): void {this._onShowInstalled = h;}
    public onShowHistory(h: (unid: string) => void): void {this._onShowHistory = h;}
    public onShowMatrix(h: (unid: string) => void): void {this._onShowMatrix = h;}
    public onShowTree(h: (unid: string) => void): void {this._onShowTree = h;}
    public onShowUnused(h: (unid: string) => void): void {this._onShowUnused = h;}
    public onShowVulns(h: (unid: string) => void): void {this._onShowVulns = h;}
    public onShowPr(h: (unid: string) => void): void {this._onShowPr = h;}
    public onShowTemplate(h: (unid: string) => void): void {this._onShowTemplate = h;}

    /**
     * Set the editor key (`vscode` / `cursor` / `phpstorm` / …) so
     * the click-info panel can offer an "Open in IDE" link. Called
     * once at startup by the orchestrator; `undefined` hides the
     * button.
     */
    public setEditor(editor: string|undefined): void {
        this._editor = editor;
    }

    public async show(unid: string, name: string, projectRoot?: string): Promise<void> {
        this._stopSim();
        this._projectUnid = unid;
        this._projectName = name;
        this._projectRoot = projectRoot;
        this._panelEl = null;
        this._renderLoading();

        try {
            const data = await Api.sourceGraph(unid);
            if (this._projectUnid !== unid) {
                return;
            }
            this._render(data);
            /*
             * Self-code scan runs in the background — the graph is
             * already interactive at this point, the rings just light
             * up afterwards. Errors here only disable the rings; we
             * never tear the rendered graph down for a self-code
             * failure.
             */
            if (data.supported) {
                Api.selfCode(unid).then((sc) => {
                    if (this._projectUnid !== unid || !this._sim) {
                        return;
                    }
                    SourceGraphView._applySelfCode(this._sim, sc);
                }).catch(() => {
                    /* ignore — graph stays usable, just no rings */
                });
            }
        } catch (e) {
            if (this._projectUnid === unid) {
                this._renderError((e as Error).message);
            }
        }
    }

    /**
     * Wire the self-code data into the active simulation. Stores the
     * per-file map on the sim object so the click panel can read
     * findings later, and paints a coloured stroke ring on each node
     * whose worst severity is non-null. Clean files get a green ring;
     * info/warn/risk escalate through the standard palette.
     */
    private static _applySelfCode(sim: ActiveSim, sc: ApiSelfCodeResponse): void {
        if (!sc.supported) {
            return;
        }
        sim.selfCode = new Map();
        for (const f of sc.files) {
            sim.selfCode.set(f.id, f);
        }
        for (const [node, group] of sim.nodeGroups) {
            const circle = group.querySelector<SVGCircleElement>('circle');
            if (!circle) {
                continue;
            }
            const entry = sim.selfCode.get(node.file.id);
            /*
             * Only ring the files that actually have findings —
             * painting a clean-green halo around every other file
             * drowns the risky ones in noise. Use inline `style` so
             * the colour wins against the base `.sourcegraph-node
             * circle` rule (SVG presentation attributes lose to CSS).
             */
            if (!entry || !entry.severity) {
                continue;
            }
            circle.style.stroke = SEVERITY_RING[entry.severity];
            circle.style.strokeWidth = '3';
            group.classList.add('sourcegraph-node-flagged');
            group.classList.add(`sourcegraph-node-${entry.severity}`);
        }
    }

    private _stopSim(): void {
        if (!this._sim) {
            return;
        }
        this._sim.cancelled = true;
        if (this._sim.rafHandle !== null) {
            cancelAnimationFrame(this._sim.rafHandle);
        }
        this._sim = null;
    }

    private _renderLoading(): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());
        const hint = document.createElement('div');
        hint.className = 'list-placeholder';
        hint.textContent = I18n.t('Building source graph …');
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

    private _render(data: ApiSourceGraphResponse): void {
        this._root.innerHTML = '';
        this._root.appendChild(this._renderHeader());

        if (!data.supported) {
            const banner = document.createElement('div');
            banner.className = 'list-placeholder';
            banner.textContent = data.unsupportedReason
                ?? I18n.t('Source graph is not supported for this project type in v1.');
            this._root.appendChild(banner);
            return;
        }

        const meta = document.createElement('div');
        meta.className = 'installed-meta';
        meta.textContent = I18n.t(
            '{files} files, {edges} import edges. Drag a node to nudge the layout.',
            {files: data.filesScanned, edges: data.edges.length}
        );
        this._root.appendChild(meta);

        if (data.unresolved > 0) {
            const note = document.createElement('div');
            note.className = 'installed-meta installed-meta-readonly';
            note.textContent = I18n.t(
                '{n} import specifiers could not be resolved (dynamic specs or missing targets).',
                {n: data.unresolved}
            );
            this._root.appendChild(note);
        }

        if (data.files.length > MAX_NODES) {
            const note = document.createElement('div');
            note.className = 'installed-meta installed-meta-readonly';
            note.textContent = I18n.t(
                'Graph too large — showing the {kept} most-connected files (of {total}).',
                {kept: MAX_NODES, total: data.files.length}
            );
            this._root.appendChild(note);
        }

        const folderColours = SourceGraphView._assignFolderColours(data.files);
        this._root.appendChild(this._renderLegend(folderColours));

        if (data.files.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'list-placeholder';
            empty.textContent = I18n.t('No source files found.');
            this._root.appendChild(empty);
            return;
        }

        const host = document.createElement('div');
        host.className = 'sourcegraph-host';
        this._root.appendChild(host);
        this._renderGraph(host, data, folderColours);
    }

    /**
     * Build the folder→colour map. Folders are sorted by file count
     * (descending) so the biggest, most architecturally significant
     * folders land on the most distinct palette slots; ties broken
     * alphabetically for stable colour assignment across reloads.
     * Files at the project root collapse to a single `""` bucket
     * that renders in the muted grey.
     */
    private static _assignFolderColours(files: readonly SourceFile[]): Map<string, string> {
        const counts = new Map<string, number>();
        for (const f of files) {
            const folder = SourceGraphView._topFolder(f.id);
            counts.set(folder, (counts.get(folder) ?? 0) + 1);
        }
        const ordered = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const out = new Map<string, string>();
        let palettePos = 0;
        for (const [folder] of ordered) {
            if (folder === '') {
                out.set(folder, ROOT_COLOUR);
                continue;
            }
            out.set(folder, FOLDER_PALETTE[palettePos % FOLDER_PALETTE.length]);
            palettePos++;
        }
        return out;
    }

    private static _topFolder(id: string): string {
        const slash = id.indexOf('/');
        return slash < 0 ? '' : id.slice(0, slash);
    }

    private _renderLegend(folderColours: Map<string, string>): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'deptree-legend';
        for (const [folder, colour] of folderColours) {
            const span = document.createElement('span');
            span.className = 'deptree-legend-item';
            const dot = document.createElement('span');
            dot.className = 'deptree-legend-dot';
            dot.style.background = colour;
            span.appendChild(dot);
            span.appendChild(document.createTextNode(folder === '' ? I18n.t('(root)') : folder));
            wrap.appendChild(span);
        }
        return wrap;
    }

    /**
     * Build sim nodes, mount the SVG, kick off the live RAF loop.
     * The simulation breathes for ~5 seconds after first paint, then
     * cools (alpha < 0.001); drag events restart it.
     */
    private _renderGraph(
        host: HTMLElement,
        data: ApiSourceGraphResponse,
        folderColours: Map<string, string>
    ): void {
        const visible = SourceGraphView._pickVisible(data);
        const visibleIds = new Set(visible.map((f) => f.id));

        let maxLoc = 1;
        for (const f of visible) {
            if (f.loc > maxLoc) {
                maxLoc = f.loc;
            }
        }

        /*
         * Folder anchors arranged on a square-ish grid. Nodes get a
         * soft force pulling them toward their folder's anchor; this
         * is what produces the folder clustering codeflow shows. The
         * folder order is stable (sorted by colour-assignment order)
         * so a re-render keeps clusters in roughly the same place.
         */
        const folders = [...folderColours.keys()];
        const folderAnchors = SourceGraphView._layoutFolderAnchors(folders);

        const nodes: SimNode[] = [];
        const byId = new Map<string, SimNode>();
        for (const f of visible) {
            const folder = SourceGraphView._topFolder(f.id);
            const anchor = folderAnchors.get(folder) ?? {x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2};
            /*
             * Tiny random scatter around the anchor as starting
             * position. Pure anchor coordinates would mean every
             * node in a folder starts at the same point and forces
             * would push them apart in a bursty, ugly way.
             */
            const node: SimNode = {
                file: f,
                folder: folder,
                radius: SourceGraphView._radiusFor(f.loc, maxLoc),
                x: anchor.x + ((Math.random() - 0.5) * 80),
                y: anchor.y + ((Math.random() - 0.5) * 80),
                vx: 0,
                vy: 0,
                fx: null,
                fy: null
            };
            nodes.push(node);
            byId.set(f.id, node);
        }

        const edges: SimEdge[] = [];
        for (const e of data.edges) {
            if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) {
                continue;
            }
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (from && to) {
                edges.push({from: from, to: to});
            }
        }

        const edgesByNode = new Map<SimNode, SimEdge[]>();
        for (const edge of edges) {
            let from = edgesByNode.get(edge.from);
            if (!from) {
                from = [];
                edgesByNode.set(edge.from, from);
            }
            from.push(edge);
            let to = edgesByNode.get(edge.to);
            if (!to) {
                to = [];
                edgesByNode.set(edge.to, to);
            }
            to.push(edge);
        }

        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'sourcegraph-svg');
        svg.setAttribute('viewBox', `0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(CANVAS_HEIGHT));
        host.appendChild(svg);
        SourceGraphView._attachPanZoom(svg);

        const hullLayer = document.createElementNS(ns, 'g');
        hullLayer.setAttribute('class', 'sourcegraph-hulls');
        svg.appendChild(hullLayer);

        const linkLayer = document.createElementNS(ns, 'g');
        linkLayer.setAttribute('class', 'sourcegraph-links');
        svg.appendChild(linkLayer);

        const nodeLayer = document.createElementNS(ns, 'g');
        nodeLayer.setAttribute('class', 'sourcegraph-nodes');
        svg.appendChild(nodeLayer);

        const edgePaths = new Map<SimEdge, SVGPathElement>();
        for (const edge of edges) {
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('class', 'sourcegraph-link');
            path.setAttribute('fill', 'none');
            linkLayer.appendChild(path);
            edgePaths.set(edge, path);
        }

        const sim: ActiveSim = {
            nodes: nodes,
            edges: edges,
            folderAnchors: folderAnchors,
            folderColours: folderColours,
            edgesByNode: edgesByNode,
            nodeGroups: new Map(),
            edgePaths: edgePaths,
            hullLayer: hullLayer,
            svgNs: ns,
            alpha: 1,
            tickCount: 0,
            rafHandle: null,
            cancelled: false,
            selfCode: new Map()
        };

        for (const node of nodes) {
            const group = document.createElementNS(ns, 'g');
            group.setAttribute('class', 'sourcegraph-node');

            const circle = document.createElementNS(ns, 'circle');
            circle.setAttribute('r', String(node.radius));
            circle.setAttribute('fill', folderColours.get(node.folder) ?? ROOT_COLOUR);
            group.appendChild(circle);

            const title = document.createElementNS(ns, 'title');
            title.textContent = `${node.file.id}\n${I18n.t('{n} lines', {n: node.file.loc})}`;
            group.appendChild(title);

            SourceGraphView._attachNodeInteractions(group, node, sim, svg, (n) => {
                this._showNodePanel(host, sim, n);
            });

            nodeLayer.appendChild(group);
            sim.nodeGroups.set(node, group);
        }

        this._sim = sim;
        this._startLoop();
    }

    /**
     * Render the per-node info side-panel. Lists the node's metadata
     * plus its direct neighbours (imports + importers) so the user
     * can navigate the graph as a directed call-tree. Clicking a
     * neighbour row replaces the panel content and pans the camera
     * to that node — so the panel doubles as a navigation tool over
     * the source graph.
     */
    private _showNodePanel(host: HTMLElement, sim: ActiveSim, node: SimNode): void {
        host.style.position = 'relative';
        if (this._panelEl) {
            this._panelEl.remove();
        }

        const panel = document.createElement('div');
        panel.className = 'sourcegraph-panel';
        /*
         * The panel floats over the SVG; without this guard, any
         * pointerdown inside the panel would bubble up to the SVG's
         * pan handler and yank the camera away from the user.
         */
        panel.addEventListener('pointerdown', (e) => e.stopPropagation());
        panel.addEventListener('wheel', (e) => e.stopPropagation());

        const header = document.createElement('div');
        header.className = 'sourcegraph-panel-header';
        const title = document.createElement('div');
        title.className = 'sourcegraph-panel-title';
        title.textContent = node.file.id;
        header.appendChild(title);
        const close = document.createElement('button');
        close.className = 'sourcegraph-panel-close';
        close.type = 'button';
        close.textContent = '✕';
        close.addEventListener('click', () => this._hideNodePanel());
        header.appendChild(close);
        panel.appendChild(header);

        const meta = document.createElement('div');
        meta.className = 'sourcegraph-panel-meta';
        const inEdges = sim.edges.filter((e) => e.to === node);
        const outEdges = sim.edges.filter((e) => e.from === node);
        meta.appendChild(SourceGraphView._metaRow(I18n.t('Lines'), String(node.file.loc)));
        meta.appendChild(SourceGraphView._metaRow(
            I18n.t('Folder'),
            node.folder === '' ? I18n.t('(root)') : node.folder
        ));
        meta.appendChild(SourceGraphView._metaRow(I18n.t('Imports'), String(outEdges.length)));
        meta.appendChild(SourceGraphView._metaRow(I18n.t('Imported by'), String(inEdges.length)));
        panel.appendChild(meta);

        if (this._projectRoot) {
            const rootNorm = this._projectRoot.endsWith('/')
                ? this._projectRoot.slice(0, -1)
                : this._projectRoot;
            const absPath = `${rootNorm}/${node.file.id}`;
            const actions = document.createElement('div');
            actions.className = 'sourcegraph-panel-actions';

            /*
             * "Open in IDE" relies on the browser dispatching the
             * custom URL scheme (`phpstorm://`, `vscode://`, …) to
             * the OS handler. Many browsers block unknown schemes by
             * default — the "Copy path" button below is the reliable
             * fallback, since the clipboard works regardless of
             * scheme-handler permissions.
             */
            if (this._editor) {
                const url = EditorUrl.build(this._editor, absPath);
                if (url) {
                    const open = document.createElement('a');
                    open.className = 'sourcegraph-panel-ide';
                    open.href = url;
                    open.textContent = I18n.t('Open in IDE');
                    open.addEventListener('click', (e) => e.stopPropagation());
                    actions.appendChild(open);
                }
            }

            const copy = document.createElement('button');
            copy.className = 'sourcegraph-panel-copy';
            copy.type = 'button';
            copy.textContent = I18n.t('Copy path');
            copy.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(absPath).then(() => {
                    copy.textContent = I18n.t('Copied ✓');
                    setTimeout(() => {
                        copy.textContent = I18n.t('Copy path');
                    }, 1500);
                }).catch(() => {
                    copy.textContent = I18n.t('Copy failed');
                });
            });
            actions.appendChild(copy);

            panel.appendChild(actions);
        }

        const scoreEntry = sim.selfCode.get(node.file.id);
        if (scoreEntry) {
            panel.appendChild(SourceGraphView._renderSelfCodeSection(scoreEntry));
        }

        const focusNode = (target: SimNode): void => {
            this._showNodePanel(host, sim, target);
            SourceGraphView._panTo(host, target);
        };
        panel.appendChild(SourceGraphView._neighbourList(
            I18n.t('Imports ({n})', {n: outEdges.length}),
            outEdges.map((e) => e.to),
            focusNode
        ));
        panel.appendChild(SourceGraphView._neighbourList(
            I18n.t('Imported by ({n})', {n: inEdges.length}),
            inEdges.map((e) => e.from),
            focusNode
        ));

        host.appendChild(panel);
        this._panelEl = panel;
    }

    private _hideNodePanel(): void {
        if (this._panelEl) {
            this._panelEl.remove();
            this._panelEl = null;
        }
    }

    private static _metaRow(label: string, value: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'sourcegraph-panel-meta-row';
        const k = document.createElement('span');
        k.className = 'sourcegraph-panel-meta-key';
        k.textContent = label;
        const v = document.createElement('span');
        v.className = 'sourcegraph-panel-meta-val';
        v.textContent = value;
        row.appendChild(k);
        row.appendChild(v);
        return row;
    }

    /**
     * Build the "Self-code findings" panel section. Header carries
     * the 0-100 score in a colour-coded pill (green / amber / red),
     * followed by one card per finding showing pattern name, line
     * number, and the matched snippet so the user can decide whether
     * to drill into the file.
     */
    private static _renderSelfCodeSection(entry: SelfCodeFileScore): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'sourcegraph-panel-section';
        const head = document.createElement('div');
        head.className = 'sourcegraph-panel-section-head sourcegraph-panel-selfcode-head';
        const label = document.createElement('span');
        label.textContent = I18n.t('Self-code');
        head.appendChild(label);
        const pill = document.createElement('span');
        pill.className = 'sourcegraph-panel-score-pill';
        pill.style.background = entry.severity ? SEVERITY_RING[entry.severity] : CLEAN_RING;
        pill.textContent = String(entry.score);
        head.appendChild(pill);
        wrap.appendChild(head);

        if (entry.findings.length === 0) {
            const ok = document.createElement('div');
            ok.className = 'sourcegraph-panel-empty';
            ok.textContent = I18n.t('No findings — file is clean.');
            wrap.appendChild(ok);
            return wrap;
        }

        const list = document.createElement('div');
        list.className = 'sourcegraph-panel-findings';
        const sorted = [...entry.findings].sort((a, b) => a.line - b.line);
        for (const f of sorted) {
            list.appendChild(SourceGraphView._renderFinding(f));
        }
        wrap.appendChild(list);
        return wrap;
    }

    private static _renderFinding(f: PatternFinding): HTMLElement {
        const card = document.createElement('div');
        card.className = 'sourcegraph-panel-finding';

        const head = document.createElement('div');
        head.className = 'sourcegraph-panel-finding-head';
        const sev = document.createElement('span');
        sev.className = `sourcegraph-panel-sev sourcegraph-panel-sev-${f.severity}`;
        sev.textContent = f.severity;
        head.appendChild(sev);
        const name = document.createElement('span');
        name.className = 'sourcegraph-panel-finding-name';
        name.textContent = f.pattern;
        head.appendChild(name);
        const line = document.createElement('span');
        line.className = 'sourcegraph-panel-finding-line';
        line.textContent = `:${f.line}`;
        head.appendChild(line);
        card.appendChild(head);

        const snip = document.createElement('div');
        snip.className = 'sourcegraph-panel-finding-snippet';
        snip.textContent = f.snippet;
        card.appendChild(snip);

        return card;
    }

    private static _neighbourList(
        title: string,
        nodes: SimNode[],
        onClick: (n: SimNode) => void
    ): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'sourcegraph-panel-section';
        const head = document.createElement('div');
        head.className = 'sourcegraph-panel-section-head';
        head.textContent = title;
        wrap.appendChild(head);
        if (nodes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sourcegraph-panel-empty';
            empty.textContent = I18n.t('(none)');
            wrap.appendChild(empty);
            return wrap;
        }
        const list = document.createElement('div');
        list.className = 'sourcegraph-panel-list';
        const sorted = [...nodes].sort((a, b) => a.file.id.localeCompare(b.file.id));
        for (const n of sorted) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'sourcegraph-panel-list-row';
            row.textContent = n.file.id;
            row.addEventListener('click', () => onClick(n));
            list.appendChild(row);
        }
        wrap.appendChild(list);
        return wrap;
    }

    /**
     * Centre the SVG viewBox on the target node so the user can
     * actually see who they just clicked through to. Zoom level is
     * preserved so the global structure remains the visual anchor.
     */
    private static _panTo(host: HTMLElement, node: SimNode): void {
        const svg = host.querySelector<SVGSVGElement>('svg.sourcegraph-svg');
        if (!svg) {
            return;
        }
        const vb = svg.viewBox.baseVal;
        vb.x = node.x - (vb.width / 2);
        vb.y = node.y - (vb.height / 2);
        svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
    }

    /**
     * Lay out folder anchors on a near-square grid covering the
     * canvas. Anchors are inset by ~80px so node clouds have room
     * to bloom without immediately hitting the canvas edge. The
     * implicit folder order (caller-supplied) becomes the grid
     * left-to-right, top-to-bottom — so the largest folder lands
     * in the top-left and the smallest in the bottom-right.
     */
    private static _layoutFolderAnchors(folders: string[]): Map<string, {x: number; y: number;}> {
        const out = new Map<string, {x: number; y: number;}>();
        if (folders.length === 0) {
            return out;
        }
        const cols = Math.max(1, Math.ceil(Math.sqrt(folders.length)));
        const rows = Math.max(1, Math.ceil(folders.length / cols));
        const cellW = CANVAS_WIDTH / (cols + 1);
        const cellH = CANVAS_HEIGHT / (rows + 1);
        folders.forEach((f, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            out.set(f, {x: (col + 1) * cellW, y: (row + 1) * cellH});
        });
        return out;
    }

    /**
     * Drag + hover + click plumbing for one node. Drag pins the node
     * by setting `fx/fy`; pointermove updates them; pointerup releases
     * them so the simulation can settle around the new position.
     * Drag-start re-heats the simulation (`alpha = 0.6`) so the rest
     * of the graph reflows instead of staying frozen.
     *
     * Click vs. drag is disambiguated by total travel distance: less
     * than `CLICK_RADIUS` SVG units between pointerdown and pointerup
     * counts as a click and opens the info panel instead of leaving
     * the node pinned mid-air.
     */
    private static _attachNodeInteractions(
        group: SVGGElement,
        node: SimNode,
        sim: ActiveSim,
        svg: SVGSVGElement,
        onClick: (n: SimNode) => void
    ): void {
        const CLICK_RADIUS = 6;
        const hoverEnter = (): void => {
            const lit = new Set(sim.edgesByNode.get(node) ?? []);
            for (const [edge, path] of sim.edgePaths) {
                if (lit.has(edge)) {
                    path.classList.add('sourcegraph-link-active');
                } else {
                    path.classList.add('sourcegraph-link-dim');
                }
            }
        };
        const hoverLeave = (): void => {
            for (const path of sim.edgePaths.values()) {
                path.classList.remove('sourcegraph-link-active');
                path.classList.remove('sourcegraph-link-dim');
            }
        };
        group.addEventListener('pointerenter', hoverEnter);
        group.addEventListener('pointerleave', hoverLeave);

        let dragging = false;
        let downScreen: {x: number; y: number;}|null = null;
        let moved = false;
        const screenToSvg = (clientX: number, clientY: number): {x: number; y: number;} => {
            const rect = svg.getBoundingClientRect();
            const vb = svg.viewBox.baseVal;
            const x = (((clientX - rect.left) / rect.width) * vb.width) + vb.x;
            const y = (((clientY - rect.top) / rect.height) * vb.height) + vb.y;
            return {x: x, y: y};
        };
        group.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            dragging = true;
            moved = false;
            group.setPointerCapture(e.pointerId);
            downScreen = {x: e.clientX, y: e.clientY};
            sim.alpha = Math.max(sim.alpha, 0.4);
            group.classList.add('sourcegraph-node-dragging');
        });
        group.addEventListener('pointermove', (e) => {
            if (!dragging || !downScreen) {
                return;
            }
            const dist = Math.hypot(e.clientX - downScreen.x, e.clientY - downScreen.y);
            /*
             * Only start pinning the node once the pointer has
             * travelled past the click threshold. This keeps a quick
             * click from briefly nailing the node to its current
             * position — and lets the click-vs-drag decision land
             * cleanly on pointerup.
             */
            if (!moved && dist < CLICK_RADIUS) {
                return;
            }
            moved = true;
            const p = screenToSvg(e.clientX, e.clientY);
            node.fx = p.x;
            node.fy = p.y;
            sim.alpha = Math.max(sim.alpha, 0.6);
        });
        const endDrag = (e: PointerEvent): void => {
            if (!dragging) {
                return;
            }
            dragging = false;
            group.releasePointerCapture(e.pointerId);
            const wasClick = !moved;
            downScreen = null;
            node.fx = null;
            node.fy = null;
            group.classList.remove('sourcegraph-node-dragging');
            if (wasClick) {
                onClick(node);
            }
        };
        group.addEventListener('pointerup', endDrag);
        group.addEventListener('pointercancel', endDrag);
    }

    /**
     * Kick off the simulation loop. Each frame runs one tick + a DOM
     * sync; the loop exits when `alpha` decays below the cool-down
     * threshold or the sim is cancelled (a new project loaded).
     */
    private _startLoop(): void {
        if (!this._sim) {
            return;
        }
        const sim = this._sim;
        const step = (): void => {
            if (sim.cancelled) {
                return;
            }
            SourceGraphView._tick(sim);
            SourceGraphView._paint(sim);
            /*
             * Large graphs converge faster: each frame burns more
             * cycles, so we want fewer frames. Codeflow uses the
             * same isLargeGraph trick for its D3 sim.
             */
            const decay = sim.nodes.length > LARGE_GRAPH_NODES ? 0.97 : 0.992;
            sim.alpha *= decay;
            if (sim.alpha < 0.005) {
                sim.rafHandle = null;
                return;
            }
            sim.rafHandle = requestAnimationFrame(step);
        };
        sim.rafHandle = requestAnimationFrame(step);
    }

    /**
     * One simulation tick. Four forces run in order:
     *  - **folder attraction** (soft pull toward folder anchor) —
     *    this is the codeflow trick: groups self-organise.
     *  - **charge** (Coulomb repulsion, capped to a finite radius so
     *    the loop stays roughly linear in well-clustered graphs).
     *  - **link spring** (Hooke pull along edges toward a target
     *    distance).
     *  - **collision** (post-correction: any two nodes whose circles
     *    overlap get pushed apart along their centre line).
     * Velocities are damped per tick so the system actually settles.
     */
    private static _tick(sim: ActiveSim): void {
        const alpha = sim.alpha;
        /*
         * For large graphs we crank damping up so the system bleeds
         * energy faster — fewer wiggle frames before settling. The
         * forces themselves scale with alpha, so the tuning naturally
         * follows the cooldown curve.
         */
        const damping = sim.nodes.length > LARGE_GRAPH_NODES ? 0.5 : 0.6;
        const charge = -120 * alpha;
        const springLen = 60;
        const springK = 0.04 * alpha;
        const anchorK = 0.08 * alpha;

        const nodes = sim.nodes;

        for (const a of nodes) {
            a.vx *= damping;
            a.vy *= damping;
        }

        // Folder anchor attraction.
        for (const a of nodes) {
            const anchor = sim.folderAnchors.get(a.folder);
            if (!anchor) {
                continue;
            }
            a.vx += (anchor.x - a.x) * anchorK;
            a.vy += (anchor.y - a.y) * anchorK;
        }

        // Charge repulsion (capped distance).
        const chargeMaxSq = 250 * 250;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist2 = (dx * dx) + (dy * dy) + 1;
                if (dist2 > chargeMaxSq) {
                    continue;
                }
                const dist = Math.sqrt(dist2);
                const force = charge / dist2;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx -= fx;
                a.vy -= fy;
                b.vx += fx;
                b.vy += fy;
            }
        }

        // Link springs.
        for (const e of sim.edges) {
            const dx = e.to.x - e.from.x;
            const dy = e.to.y - e.from.y;
            const dist = Math.sqrt((dx * dx) + (dy * dy)) + 0.01;
            const delta = dist - springLen;
            const fx = ((dx / dist) * delta) * springK;
            const fy = ((dy / dist) * delta) * springK;
            e.from.vx += fx;
            e.from.vy += fy;
            e.to.vx -= fx;
            e.to.vy -= fy;
        }

        // Integrate position; pinned nodes snap to their fx/fy.
        for (const a of nodes) {
            if (a.fx !== null && a.fy !== null) {
                a.x = a.fx;
                a.y = a.fy;
                a.vx = 0;
                a.vy = 0;
                continue;
            }
            a.x += a.vx;
            a.y += a.vy;
        }

        // Collision: post-step circle separation.
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const minDist = a.radius + b.radius + 4;
                const distSq = (dx * dx) + (dy * dy);
                if (distSq >= minDist * minDist || distSq < 0.01) {
                    continue;
                }
                const dist = Math.sqrt(distSq);
                const overlap = (minDist - dist) / 2;
                const ox = (dx / dist) * overlap;
                const oy = (dy / dist) * overlap;
                if (!(a.fx !== null && a.fy !== null)) {
                    a.x -= ox;
                    a.y -= oy;
                }
                if (!(b.fx !== null && b.fy !== null)) {
                    b.x += ox;
                    b.y += oy;
                }
            }
        }

        sim.tickCount++;
    }

    /**
     * Sync simulation state into the DOM. Edges are drawn as cubic
     * Bezier curves with a control-point offset perpendicular to the
     * segment — this gives the rounded "codeflow" link look without
     * overlap chaos when many edges share endpoints. Hulls are
     * recomputed every few frames (expensive convex-hull builds
     * don't need to be per-frame).
     */
    private static _paint(sim: ActiveSim): void {
        for (const [edge, path] of sim.edgePaths) {
            const dx = edge.to.x - edge.from.x;
            const dy = edge.to.y - edge.from.y;
            const dr = Math.sqrt((dx * dx) + (dy * dy)) || 1;
            /*
             * Quadratic Bezier with a control point perpendicular to
             * the chord, offset by ~12% of the chord length. Reads as
             * a soft arc — same idiom codeflow uses for "curved
             * links".
             */
            const offset = dr * 0.12;
            const mx = (edge.from.x + edge.to.x) / 2;
            const my = (edge.from.y + edge.to.y) / 2;
            const px = mx + ((-dy / dr) * offset);
            const py = my + ((dx / dr) * offset);
            path.setAttribute('d',
                `M${edge.from.x},${edge.from.y} Q${px},${py} ${edge.to.x},${edge.to.y}`);
        }

        for (const [node, group] of sim.nodeGroups) {
            group.setAttribute('transform', `translate(${node.x},${node.y})`);
        }

        /*
         * Hull repaint is the most expensive paint step (convex hull
         * + DOM element churn). Throttle harder for large graphs so
         * the frame budget stays interactive.
         */
        const hullEvery = sim.nodes.length > LARGE_GRAPH_NODES ? 10 : 4;
        if (sim.tickCount % hullEvery === 0) {
            SourceGraphView._repaintHulls(sim);
        }
    }

    /**
     * Repaint the per-folder convex-hull overlay + label. The hull
     * is computed with Andrew's monotone-chain algorithm (O(n log n),
     * fine even for the 600-node cap). Each folder gets a padded
     * polygon filled at low opacity in its colour, plus the folder
     * name in the same colour above the cloud.
     */
    private static _repaintHulls(sim: ActiveSim): void {
        const layer = sim.hullLayer;
        while (layer.firstChild) {
            layer.removeChild(layer.firstChild);
        }

        const byFolder = new Map<string, SimNode[]>();
        for (const node of sim.nodes) {
            let arr = byFolder.get(node.folder);
            if (!arr) {
                arr = [];
                byFolder.set(node.folder, arr);
            }
            arr.push(node);
        }

        for (const [folder, members] of byFolder) {
            if (members.length < 2) {
                continue;
            }
            /*
             * Expand each node into its bounding-box corners so the
             * resulting hull naturally hugs the cloud with padding,
             * instead of clinging to centre points and clipping the
             * outer circles.
             */
            const points: [number, number][] = [];
            for (const m of members) {
                points.push([m.x - HULL_PADDING, m.y - HULL_PADDING]);
                points.push([m.x + HULL_PADDING, m.y - HULL_PADDING]);
                points.push([m.x - HULL_PADDING, m.y + HULL_PADDING]);
                points.push([m.x + HULL_PADDING, m.y + HULL_PADDING]);
            }
            const hull = SourceGraphView._convexHull(points);
            if (hull.length < 3) {
                continue;
            }
            const colour = sim.folderColours.get(folder) ?? ROOT_COLOUR;
            const path = document.createElementNS(sim.svgNs, 'path');
            path.setAttribute('d', `M${hull.map((p) => `${p[0]},${p[1]}`).join(' L')} Z`);
            path.setAttribute('fill', colour);
            path.setAttribute('fill-opacity', '0.06');
            path.setAttribute('stroke', colour);
            path.setAttribute('stroke-opacity', '0.3');
            path.setAttribute('stroke-width', '2');
            layer.appendChild(path);

            const meanX = members.reduce((s, m) => s + m.x, 0) / members.length;
            const topY = Math.min(...members.map((m) => m.y)) - HULL_PADDING - 6;
            const label = document.createElementNS(sim.svgNs, 'text');
            label.setAttribute('x', String(meanX));
            label.setAttribute('y', String(topY));
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('fill', colour);
            label.setAttribute('font-size', '11');
            label.setAttribute('font-weight', '600');
            label.setAttribute('opacity', '0.75');
            label.setAttribute('class', 'sourcegraph-hull-label');
            label.textContent = folder === '' ? I18n.t('(root)') : folder;
            layer.appendChild(label);
        }
    }

    /**
     * Andrew's monotone-chain convex hull. Sorts the input points
     * lexicographically, then builds the lower hull and upper hull
     * by sweeping. Returns the hull in counter-clockwise order with
     * no duplicate endpoint.
     */
    private static _convexHull(points: [number, number][]): [number, number][] {
        if (points.length < 3) {
            return points.slice();
        }
        const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cross = (
            o: [number, number],
            a: [number, number],
            b: [number, number]
        ): number => ((a[0] - o[0]) * (b[1] - o[1])) - ((a[1] - o[1]) * (b[0] - o[0]));

        const lower: [number, number][] = [];
        for (const p of sorted) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
                lower.pop();
            }
            lower.push(p);
        }
        const upper: [number, number][] = [];
        for (let i = sorted.length - 1; i >= 0; i--) {
            const p = sorted[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
                upper.pop();
            }
            upper.push(p);
        }
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    /**
     * Hook pan + zoom onto the rendered SVG via viewBox manipulation.
     * No D3-zoom dependency: a mouse-drag pans (delta translates the
     * viewBox origin in SVG user units), wheel zooms toward the
     * cursor (the zoom point stays fixed under the pointer, which is
     * the well-known "scroll to point" idiom). Bounded scale range so
     * the user can't accidentally zoom into oblivion.
     */
    private static _attachPanZoom(svg: SVGSVGElement): void {
        const vb = {x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT};
        const apply = (): void => {
            svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
        };

        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        svg.addEventListener('pointerdown', (e) => {
            if (e.target !== svg && (e.target as Element).closest('.sourcegraph-node')) {
                return;
            }
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            svg.setPointerCapture(e.pointerId);
            svg.classList.add('sourcegraph-svg-dragging');
        });
        svg.addEventListener('pointermove', (e) => {
            if (!dragging) {
                return;
            }
            const rect = svg.getBoundingClientRect();
            const scaleX = vb.w / rect.width;
            const scaleY = vb.h / rect.height;
            vb.x -= (e.clientX - lastX) * scaleX;
            vb.y -= (e.clientY - lastY) * scaleY;
            lastX = e.clientX;
            lastY = e.clientY;
            apply();
        });
        const endDrag = (e: PointerEvent): void => {
            if (!dragging) {
                return;
            }
            dragging = false;
            svg.releasePointerCapture(e.pointerId);
            svg.classList.remove('sourcegraph-svg-dragging');
        };
        svg.addEventListener('pointerup', endDrag);
        svg.addEventListener('pointercancel', endDrag);

        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = svg.getBoundingClientRect();
            const px = (((e.clientX - rect.left) / rect.width) * vb.w) + vb.x;
            const py = (((e.clientY - rect.top) / rect.height) * vb.h) + vb.y;
            const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
            const newW = vb.w * factor;
            const newH = vb.h * factor;
            const minW = CANVAS_WIDTH / 8;
            const maxW = CANVAS_WIDTH * 5;
            if (newW < minW || newW > maxW) {
                return;
            }
            vb.x = px - ((px - vb.x) * (newW / vb.w));
            vb.y = py - ((py - vb.y) * (newH / vb.h));
            vb.w = newW;
            vb.h = newH;
            apply();
        }, {passive: false});
    }

    /**
     * Pick the subset of files we'll actually render. When the graph
     * fits under `MAX_NODES`, returns everything; otherwise keeps the
     * highest-degree (most-connected) files because they carry the
     * most architectural signal.
     */
    private static _pickVisible(data: ApiSourceGraphResponse): typeof data.files {
        if (data.files.length <= MAX_NODES) {
            return data.files;
        }
        const degree = new Map<string, number>();
        for (const e of data.edges) {
            degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
            degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
        }
        return [...data.files]
        .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
        .slice(0, MAX_NODES);
    }

    /**
     * Map a file's LOC onto the radius range. Square-root scaling so
     * a 5000-line file isn't 100× the area of a 50-line file —
     * legibility wins over strict area-proportionality.
     */
    private static _radiusFor(loc: number, maxLoc: number): number {
        const scale = Math.sqrt(loc) / Math.sqrt(maxLoc || 1);
        return NODE_MIN_RADIUS + (scale * (NODE_MAX_RADIUS - NODE_MIN_RADIUS));
    }

    /**
     * Header with the per-project toggle. Mirrors the other sub-views;
     * the Graph button is the active one here.
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
        source.className = 'installed-toggle-btn installed-toggle-btn-active';
        source.textContent = I18n.t('Graph');
        toggle.appendChild(source);

        header.appendChild(toggle);
        return header;
    }

}