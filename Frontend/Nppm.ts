import {ApiProject} from '../Api/ApiTypes.js';
import {Api} from './Api.js';
import {DepTreeView} from './DepTreeView.js';
import {GlobalScanView} from './GlobalScanView.js';
import {HistoryView} from './HistoryView.js';
import {InstalledView} from './InstalledView.js';
import {Matrix} from './Matrix.js';
import {PackageDetailPanel} from './PackageDetailPanel.js';
import {PackageList} from './PackageList.js';
import {ProjectMatrixView} from './ProjectMatrixView.js';
import {Resizer} from './Resizer.js';
import {Treeview} from './Treeview.js';
import {UnusedView} from './UnusedView.js';

/**
 * Active right-pane view. `packages` and `installed` are two flavours
 * of the same project drill-down — the user toggles between declared
 * (PackageList) and installed (InstalledView) from each component's
 * header. `global` is the cross-project CVE scan, triggered from the
 * topbar.
 */
enum View {
    matrix = 'matrix',
    packages = 'packages',
    installed = 'installed',
    history = 'history',
    projectMatrix = 'projectMatrix',
    depTree = 'depTree',
    unused = 'unused',
    global = 'global'
}

/**
 * Top-level frontend controller — wires the treeview (left), the
 * matrix/package-detail right pane, and the splitter.
 */
export class Nppm {

    private readonly _treeview: Treeview;
    private readonly _matrix: Matrix;
    private readonly _packageList: PackageList;
    private readonly _installedView: InstalledView;
    private readonly _historyView: HistoryView;
    private readonly _projectMatrixView: ProjectMatrixView;
    private readonly _depTreeView: DepTreeView;
    private readonly _unusedView: UnusedView;
    private readonly _globalScanView: GlobalScanView;
    private readonly _detailPanel: PackageDetailPanel;
    private readonly _listRoot: HTMLElement;
    private _matrixHost: HTMLElement|null = null;
    private _packageHost: HTMLElement|null = null;
    private _installedHost: HTMLElement|null = null;
    private _historyHost: HTMLElement|null = null;
    private _projectMatrixHost: HTMLElement|null = null;
    private _depTreeHost: HTMLElement|null = null;
    private _unusedHost: HTMLElement|null = null;
    private _globalHost: HTMLElement|null = null;
    private _view: View = View.matrix;
    private _projects: ApiProject[] = [];

    constructor() {
        const treeRoot = document.getElementById('treeview');
        const listRoot = document.getElementById('list');
        const resizer = document.getElementById('resizer');
        const controls = document.getElementById('controls');

        if (!treeRoot || !listRoot || !resizer || !controls) {
            throw new Error('nppm: required DOM nodes missing in index.html');
        }

        this._listRoot = listRoot;
        this._buildRightPane();

        this._treeview = new Treeview(treeRoot);
        this._matrix = new Matrix(this._matrixHost!);
        this._packageList = new PackageList(this._packageHost!);
        this._installedView = new InstalledView(this._installedHost!);
        this._historyView = new HistoryView(this._historyHost!);
        this._projectMatrixView = new ProjectMatrixView(this._projectMatrixHost!);
        this._depTreeView = new DepTreeView(this._depTreeHost!);
        this._unusedView = new UnusedView(this._unusedHost!);

        // Topbar wiring for the global scan. These elements live in
        // index.html so non-pane components can drive them.
        const globalBtn = document.getElementById('global-scan-btn') as HTMLButtonElement|null;
        const globalProgress = document.getElementById('global-scan-progress');
        const globalProgressFill = document.getElementById('global-scan-progress-fill');
        const globalProgressText = document.getElementById('global-scan-progress-text');

        if (!globalBtn || !globalProgress || !globalProgressFill || !globalProgressText) {
            throw new Error('nppm: global-scan DOM nodes missing in index.html');
        }

        this._globalScanView = new GlobalScanView(
            this._globalHost!,
            globalBtn,
            globalProgress,
            globalProgressFill,
            globalProgressText
        );
        this._globalScanView.onAnalysisStart(() => this._switchTo(View.global));

        this._detailPanel = new PackageDetailPanel();

        new Resizer(resizer, controls);

        // Cross-toggle wiring: each project sub-view exposes callbacks
        // for the three other sub-views in its header. They all route
        // through Nppm so view-switching state stays centralised here.
        const findProject = (unid: string): ApiProject|undefined =>
            this._projects.find((p) => p.unid === unid);

        const wireDeclared = (unid: string): void => {
            const p = findProject(unid);
            if (p) {
                void this._loadProject(p);
            }
        };
        const wireInstalled = (unid: string): void => {
            const p = findProject(unid);
            if (p) {
                void this._loadProjectInstalled(p);
            }
        };
        const wireHistory = (unid: string): void => {
            const p = findProject(unid);
            if (p) {
                void this._loadProjectHistory(p);
            }
        };
        const wireMatrix = (unid: string): void => {
            const p = findProject(unid);
            if (p) {
                void this._loadProjectMatrix(p);
            }
        };
        const wireTree = (unid: string): void => {
            const p = findProject(unid);
            if (p) {
                void this._loadProjectTree(p);
            }
        };
        const wireUnused = (unid: string): void => {
            const p = findProject(unid);
            if (p) {
                void this._loadProjectUnused(p);
            }
        };

        this._packageList.onShowInstalled(wireInstalled);
        this._packageList.onShowHistory(wireHistory);
        this._packageList.onShowMatrix(wireMatrix);
        this._packageList.onShowTree(wireTree);
        this._packageList.onShowUnused(wireUnused);

        this._installedView.onShowDeclared(wireDeclared);
        this._installedView.onShowHistory(wireHistory);
        this._installedView.onShowMatrix(wireMatrix);
        this._installedView.onShowTree(wireTree);
        this._installedView.onShowUnused(wireUnused);

        this._historyView.onShowDeclared(wireDeclared);
        this._historyView.onShowInstalled(wireInstalled);
        this._historyView.onShowMatrix(wireMatrix);
        this._historyView.onShowTree(wireTree);
        this._historyView.onShowUnused(wireUnused);

        this._projectMatrixView.onShowDeclared(wireDeclared);
        this._projectMatrixView.onShowInstalled(wireInstalled);
        this._projectMatrixView.onShowHistory(wireHistory);
        this._projectMatrixView.onShowTree(wireTree);
        this._projectMatrixView.onShowUnused(wireUnused);
        this._projectMatrixView.onCellClick((pkg, version, latest) => {
            void this._detailPanel.open(pkg, version, latest);
        });

        this._depTreeView.onShowDeclared(wireDeclared);
        this._depTreeView.onShowInstalled(wireInstalled);
        this._depTreeView.onShowHistory(wireHistory);
        this._depTreeView.onShowMatrix(wireMatrix);
        this._depTreeView.onShowUnused(wireUnused);

        this._unusedView.onShowDeclared(wireDeclared);
        this._unusedView.onShowInstalled(wireInstalled);
        this._unusedView.onShowHistory(wireHistory);
        this._unusedView.onShowMatrix(wireMatrix);
        this._unusedView.onShowTree(wireTree);

        this._treeview.onSelect((project) => {
            if (project.unid === '__matrix__') {
                this._switchTo(View.matrix);
            } else {
                void this._loadProject(project);
            }
        });

        this._matrix.onProjectClick((unid) => {
            const project = this._projects.find((p) => p.unid === unid);
            if (project) {
                this._treeview.setSelected(unid);
                void this._loadProject(project);
            }
        });

        this._matrix.onCellClick((pkg, version, latest) => {
            void this._detailPanel.open(pkg, version, latest);
        });

        this._matrix.onSecurityClick((pkg, version) => {
            void this._detailPanel.openOnSecurity(pkg, version, version);
        });
    }

    public async start(): Promise<void> {
        this._switchTo(View.matrix);
        this._matrix.renderLoading();

        try {
            const response = await Api.listProjects();
            this._projects = response.projects;
            this._treeview.render(response.projects);
            await this._loadMatrix();
        } catch (e) {
            this._matrix.renderError((e as Error).message);
        }
    }

    private async _loadMatrix(): Promise<void> {
        try {
            const matrix = await Api.matrix();
            this._matrix.setData(matrix);
        } catch (e) {
            this._matrix.renderError((e as Error).message);
        }
    }

    private async _loadProject(project: ApiProject): Promise<void> {
        this._switchTo(View.packages);

        if (project.error) {
            this._packageList.renderError(`${project.name}: ${project.error}`);
            return;
        }

        try {
            const data = await Api.listPackages(project.unid);
            this._packageList.render(data);
        } catch (e) {
            this._packageList.renderError((e as Error).message);
        }
    }

    private async _loadProjectInstalled(project: ApiProject): Promise<void> {
        this._switchTo(View.installed);
        await this._installedView.show(project.unid, project.name);
    }

    private async _loadProjectHistory(project: ApiProject): Promise<void> {
        this._switchTo(View.history);
        await this._historyView.show(project.unid, project.name);
    }

    private async _loadProjectMatrix(project: ApiProject): Promise<void> {
        this._switchTo(View.projectMatrix);
        await this._projectMatrixView.show(project.unid, project.name);
    }

    private async _loadProjectTree(project: ApiProject): Promise<void> {
        this._switchTo(View.depTree);
        await this._depTreeView.show(project.unid, project.name);
    }

    private async _loadProjectUnused(project: ApiProject): Promise<void> {
        this._switchTo(View.unused);
        await this._unusedView.show(project.unid, project.name);
    }

    /**
     * Carve the existing #list element into four stacked panes — matrix,
     * declared package list, installed (lockfile) view, and the global
     * cross-project scan. Only the active pane is `display:block`; the
     * others keep their state and toggle invisibly.
     */
    private _buildRightPane(): void {
        this._listRoot.innerHTML = '';

        this._matrixHost = document.createElement('div');
        this._matrixHost.className = 'pane pane-matrix';
        this._listRoot.appendChild(this._matrixHost);

        this._packageHost = document.createElement('div');
        this._packageHost.className = 'pane pane-packages';
        this._listRoot.appendChild(this._packageHost);

        this._installedHost = document.createElement('div');
        this._installedHost.className = 'pane pane-installed';
        this._listRoot.appendChild(this._installedHost);

        this._historyHost = document.createElement('div');
        this._historyHost.className = 'pane pane-history';
        this._listRoot.appendChild(this._historyHost);

        this._projectMatrixHost = document.createElement('div');
        this._projectMatrixHost.className = 'pane pane-project-matrix';
        this._listRoot.appendChild(this._projectMatrixHost);

        this._depTreeHost = document.createElement('div');
        this._depTreeHost.className = 'pane pane-dep-tree';
        this._listRoot.appendChild(this._depTreeHost);

        this._unusedHost = document.createElement('div');
        this._unusedHost.className = 'pane pane-unused';
        this._listRoot.appendChild(this._unusedHost);

        this._globalHost = document.createElement('div');
        this._globalHost.className = 'pane pane-global';
        this._listRoot.appendChild(this._globalHost);
    }

    private _switchTo(view: View): void {
        this._view = view;

        if (!this._matrixHost || !this._packageHost || !this._installedHost
            || !this._historyHost || !this._projectMatrixHost
            || !this._depTreeHost || !this._unusedHost || !this._globalHost) {
            return;
        }

        this._matrixHost.style.display = view === View.matrix ? '' : 'none';
        this._packageHost.style.display = view === View.packages ? '' : 'none';
        this._installedHost.style.display = view === View.installed ? '' : 'none';
        this._historyHost.style.display = view === View.history ? '' : 'none';
        this._projectMatrixHost.style.display = view === View.projectMatrix ? '' : 'none';
        this._depTreeHost.style.display = view === View.depTree ? '' : 'none';
        this._unusedHost.style.display = view === View.unused ? '' : 'none';
        this._globalHost.style.display = view === View.global ? '' : 'none';
    }
}