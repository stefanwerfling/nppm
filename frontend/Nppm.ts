import {ApiProject} from '../shared/Api/ApiTypes.js';
import {Api} from './Util/Api.js';
import {BadgeFilterModal} from './Modals/BadgeFilterModal.js';
import {BulkUpgradeModal} from './Modals/BulkUpgradeModal.js';
import {DashboardView} from './Pages/DashboardView.js';
import {DepTreeView} from './Pages/DepTreeView.js';
import {FindingsModal} from './Modals/FindingsModal.js';
import {GlobalScanView} from './Pages/GlobalScanView.js';
import {HistoryView} from './Pages/HistoryView.js';
import {InstalledView} from './Pages/InstalledView.js';
import {Matrix} from './Pages/Matrix.js';
import {PackageDetailPanel} from './Modals/PackageDetailPanel.js';
import {PackageList} from './Pages/PackageList.js';
import {ProjectMatrixView} from './Pages/ProjectMatrixView.js';
import {ProjectNav} from './Widgets/ProjectNav.js';
import {Resizer} from './Widgets/Resizer.js';
import {SourceGraphView} from './Pages/SourceGraphView.js';
import {TemplatesView} from './Pages/TemplatesView.js';
import {TemplateView} from './Pages/TemplateView.js';
import {Treeview} from './Widgets/Treeview.js';
import {UnusedView} from './Pages/UnusedView.js';
import {UpgradeModal} from './Modals/UpgradeModal.js';
import {PrReviewView} from './Pages/PrReviewView.js';
import {VulnerabilityTimelineView} from './Pages/VulnerabilityTimelineView.js';
import {ProjectFormModal} from './Modals/ProjectFormModal.js';
import {WhyModal} from './Modals/WhyModal.js';
import {WorkspaceDriftModal} from './Modals/WorkspaceDriftModal.js';

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
    vulns = 'vulns',
    pr = 'pr',
    templates = 'templates',
    template = 'template',
    sourceGraph = 'sourceGraph',
    dashboard = 'dashboard',
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
    private readonly _vulnerabilityTimelineView: VulnerabilityTimelineView;
    private readonly _prReviewView: PrReviewView;
    private readonly _templatesView: TemplatesView;
    private readonly _templateView: TemplateView;
    private readonly _sourceGraphView: SourceGraphView;
    private readonly _dashboardView: DashboardView;
    private readonly _findingsModal: FindingsModal;
    private readonly _globalScanView: GlobalScanView;
    private readonly _detailPanel: PackageDetailPanel;
    private readonly _upgradeModal: UpgradeModal;
    private readonly _bulkUpgradeModal: BulkUpgradeModal;
    private readonly _whyModal: WhyModal;
    private readonly _workspaceDriftModal: WorkspaceDriftModal;
    private readonly _projectFormModal: ProjectFormModal;
    private readonly _badgeFilterModal: BadgeFilterModal;
    private readonly _listRoot: HTMLElement;
    private _matrixHost: HTMLElement|null = null;
    private _packageHost: HTMLElement|null = null;
    private _installedHost: HTMLElement|null = null;
    private _historyHost: HTMLElement|null = null;
    private _projectMatrixHost: HTMLElement|null = null;
    private _depTreeHost: HTMLElement|null = null;
    private _unusedHost: HTMLElement|null = null;
    private _vulnsHost: HTMLElement|null = null;
    private _prHost: HTMLElement|null = null;
    private _templatesHost: HTMLElement|null = null;
    private _templateHost: HTMLElement|null = null;
    private _sourceGraphHost: HTMLElement|null = null;
    private _dashboardHost: HTMLElement|null = null;
    private _globalHost: HTMLElement|null = null;
    private _view: View = View.matrix;
    private _projects: ApiProject[] = [];
    /**
     * unid of the most recently loaded per-project view (`packages`,
     * `installed`, `history`, `projectMatrix`, `depTree`, `unused`).
     * The Upgrade modal needs it on click to address the right
     * project, since the originating view doesn't carry it back to
     * Nppm in its callbacks.
     */
    private _currentProjectUnid: string|null = null;
    /**
     * Latest Dashboard-derived per-project score map (average of all
     * scanner cells). This is now the *only* source for the treeview
     * health rings — the Matrix-derived fallback was retired so the
     * left-pane number always reflects the same value the Dashboard
     * Score-Tab shows. When the map has no entry for a project, the
     * Treeview paints the empty hourglass state.
     */
    private _dashboardScores: Map<string, number> = new Map();

    public constructor() {
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
        this._vulnerabilityTimelineView = new VulnerabilityTimelineView(this._vulnsHost!);
        this._prReviewView = new PrReviewView(this._prHost!);
        this._templatesView = new TemplatesView(this._templatesHost!);
        this._templateView = new TemplateView(this._templateHost!);
        this._sourceGraphView = new SourceGraphView(this._sourceGraphHost!);
        this._dashboardView = new DashboardView(this._dashboardHost!);
        this._findingsModal = new FindingsModal();

        this._globalScanView = new GlobalScanView(this._globalHost!);

        /*
         * Topbar "Scan all" — single entry point for the Dashboard
         * sweep. Switches to the Dashboard pane, highlights its
         * sentinel row, and kicks off `/api/dashboard/scan`. The
         * in-Dashboard "Re-scan" button was removed so this is the
         * only place to trigger a fresh scan.
         */
        const globalBtn = document.getElementById('global-scan-btn') as HTMLButtonElement|null;
        if (!globalBtn) {
            throw new Error('nppm: global-scan-btn missing in index.html');
        }
        globalBtn.addEventListener('click', () => {
            this._switchTo(View.dashboard);
            this._treeview.setSelected('__dashboard__');
            this._dashboardView.startScan();
        });

        this._detailPanel = new PackageDetailPanel();
        this._upgradeModal = new UpgradeModal();
        this._bulkUpgradeModal = new BulkUpgradeModal();
        this._whyModal = new WhyModal();
        this._workspaceDriftModal = new WorkspaceDriftModal();
        this._projectFormModal = new ProjectFormModal();
        this._badgeFilterModal = new BadgeFilterModal();
        this._badgeFilterModal.onApply((hidden) => {
            /*
             * Single source of truth — the matrix owns the filter
             * state and persists it. The modal just hands it back.
             */
            this._matrix.setHiddenBadges(hidden);
        });
        this._projectFormModal.onSaved(() => {
            /*
             * Re-fetch and re-render the project list so the new /
             * edited entry shows up; if the matrix is currently the
             * active view, also refresh it.
             */
            void this._refreshProjects();
        });

        // eslint-disable-next-line no-new
        new Resizer(resizer, controls);

        /*
         * Cross-toggle wiring: each project sub-view exposes callbacks
         * for the three other sub-views in its header. They all route
         * through Nppm so view-switching state stays centralised here.
         */
        const findProject = (unid: string): ApiProject|undefined =>
            this._projects.find((p) => p.unid === unid);

        /*
         * One nav shared by every per-project sub-view. Each handler
         * resolves the project from the active list and routes to
         * the matching `_loadProject*` method. Adding a new tab is
         * now a one-line edit in `ProjectNav.TABS` + one `.on(...)`
         * line here — instead of touching every Page class.
         */
        const wireTo = (loader: (p: ApiProject) => void): ((unid: string) => void) => (unid) => {
            const p = findProject(unid);
            if (p) {
                loader(p);
            }
        };
        const nav = new ProjectNav()
        .on('declared', wireTo((p) => { void this._loadProject(p); }))
        .on('installed', wireTo((p) => { void this._loadProjectInstalled(p); }))
        .on('history', wireTo((p) => { void this._loadProjectHistory(p); }))
        .on('matrix', wireTo((p) => { void this._loadProjectMatrix(p); }))
        .on('tree', wireTo((p) => { void this._loadProjectTree(p); }))
        .on('unused', wireTo((p) => { void this._loadProjectUnused(p); }))
        .on('vulns', wireTo((p) => { void this._loadProjectVulns(p); }))
        .on('pr', wireTo((p) => { void this._loadProjectPr(p); }))
        .on('template', wireTo((p) => { void this._loadProjectTemplate(p); }))
        .on('source', wireTo((p) => { void this._loadProjectSource(p); }));

        for (const v of [
            this._packageList, this._installedView, this._historyView,
            this._projectMatrixView, this._depTreeView, this._unusedView,
            this._vulnerabilityTimelineView, this._prReviewView,
            this._templateView, this._sourceGraphView
        ]) {
            v.setNav(nav);
        }

        this._installedView.onWhy((unid, name, version) => {
            void this._whyModal.open(unid, name, version);
        });
        this._projectMatrixView.onCellClick((pkg, version, latest) => {
            void this._detailPanel.open(pkg, version, latest);
        });
        this._projectMatrixView.onUpgradeClick((seed) => {
            const unid = this._currentProjectUnid;
            const proj = unid ? findProject(unid) : undefined;
            if (!unid || !proj) {
                return;
            }
            void this._upgradeModal.open({
                projectUnid: unid,
                projectName: proj.name,
                workspace: seed.workspace,
                name: seed.name,
                depType: seed.depType,
                fromRange: seed.fromRange,
                toRange: seed.toRange
            });
        });
        this._vulnerabilityTimelineView.onExposureClick((pkg, version) => {
            void this._detailPanel.openOnSecurity(pkg, version, version);
        });
        this._prReviewView.onDepClick((pkg, version) => {
            void this._detailPanel.openOnSecurity(pkg, version, version);
        });

        this._treeview.onSelect((project) => {
            if (project.unid === '__dashboard__') {
                this._loadDashboard();
            } else if (project.unid === '__matrix__') {
                /*
                 * Always re-fetch so the matrix is populated even
                 * when the session started on the Dashboard (no
                 * initial _loadMatrix from start()) and so a stale
                 * view picks up freshly added projects.
                 */
                this._switchTo(View.matrix);
                this._matrix.renderLoading();
                void this._loadMatrix();
            } else if (project.unid === '__templates__') {
                void this._loadTemplates();
            } else if (project.unid === '__cvescan__') {
                this._loadGlobalScan();
            } else {
                void this._loadProject(project);
            }
        });

        /*
         * Dashboard click routing — the cell modal opens for every
         * scanner; its "Open in <view>" drill-down only fires for
         * the four scanners with a dedicated view.
         */
        this._dashboardView.onProjectClick((unid) => {
            const p = findProject(unid);
            if (p) {
                this._treeview.setSelected(unid);
                void this._loadProject(p);
            }
        });
        this._dashboardView.onCellClick((unid, projectName, scanner, scannerLabel, cell) => {
            this._findingsModal.open(scanner, scannerLabel, unid, projectName, cell);
        });
        this._findingsModal.onRowClick((pkg, version) => {
            /*
             * Same hook the Matrix uses for its security badges — opens
             * the PackageDetailPanel on the Security tab so the user
             * lands directly on the External-sources card and the rest
             * of the per-package signals.
             */
            void this._detailPanel.openOnSecurity(pkg, version, version);
        });
        this._findingsModal.onDrill((unid, scanner) => {
            const p = findProject(unid);
            if (!p) {
                return;
            }
            this._treeview.setSelected(unid);
            switch (scanner) {
                case 'cve':
                case 'integrity':
                    /*
                     * Both scanners reason over the lockfile; the
                     * InstalledView already surfaces per-package
                     * security findings.
                     */
                    void this._loadProjectInstalled(p);
                    break;
                case 'unused':
                    void this._loadProjectUnused(p);
                    break;
                case 'template':
                    void this._loadProjectTemplate(p);
                    break;
                default:
                    void this._loadProject(p);
            }
        });

        this._templatesView.onCellClick((unid) => {
            const proj = findProject(unid);
            if (proj) {
                this._treeview.setSelected(unid);
                void this._loadProjectTemplate(proj);
            }
        });

        this._treeview.onAddProject(() => {
            this._projectFormModal.open({kind: 'add'});
        });

        this._treeview.onEditProject(async(project) => {
            try {
                const extras = await Api.getProjectConfig(project.unid);
                this._projectFormModal.open({kind: 'edit', project: project, extras: extras});
            } catch (e) {
                console.error('Loading project config failed', e);
            }
        });

        this._treeview.onVisibilityToggle(async(project, hidden) => {
            try {
                await Api.setProjectVisibility(project.unid, hidden);
                /*
                 * Re-fetch the project list so the eye icon flips
                 * everywhere; the matrix refresh below reads the
                 * new flag.
                 */
                const response = await Api.listProjects();
                this._projects = response.projects;
                this._treeview.render(response.projects);
                /*
                 * If the matrix is currently displayed, refresh it
                 * so the just-hidden project disappears (or the
                 * just-shown one appears).
                 */
                if (this._view === View.matrix) {
                    void this._loadMatrix();
                }
            } catch (e) {
                console.error('Visibility toggle failed', e);
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

        this._matrix.onBulkUpgradeClick((picks) => {
            void this._bulkUpgradeModal.open(picks);
        });

        this._matrix.onBadgeFilterClick(() => {
            this._badgeFilterModal.open(this._matrix.getHiddenBadges());
        });

        this._matrix.onWorkspaceDriftClick((unid, projectName, pkg) => {
            void this._workspaceDriftModal.open(unid, projectName, pkg);
        });

        /*
         * Single score source for the treeview rings: the Dashboard.
         * Until the Dashboard has produced a score for a project the
         * ring stays in its hourglass-0% empty state (see
         * `Treeview._renderScoreRing`). Matrix used to feed a fallback
         * here but that double-source caused per-view drift — the
         * Dashboard is the canonical measurement now.
         */
        this._dashboardView.onScoresChanged((scores) => {
            this._dashboardScores = scores;
            this._pushScoresToTreeview();
        });
        this._dashboardView.onMatrixClick(() => {
            this._switchTo(View.matrix);
            this._matrix.renderLoading();
            void this._loadMatrix();
            this._treeview.setSelected('__matrix__');
        });

        this._workspaceDriftModal.onOpenProjectMatrix((unid) => {
            const proj = this._projects.find((p) => p.unid === unid);
            if (proj) {
                this._treeview.setSelected(unid);
                void this._loadProjectMatrix(proj);
            }
        });

        this._bulkUpgradeModal.onAfterApply(() => {
            void this._loadMatrix();
        });

        this._upgradeModal.onAfterApply(() => {
            /*
             * Single-project upgrade was triggered from the
             * per-project matrix; reload it so the just-bumped range
             * shows up without the user having to navigate away and
             * back.
             */
            const unid = this._currentProjectUnid;
            const proj = unid ? this._projects.find((p) => p.unid === unid) : undefined;
            if (proj) {
                void this._projectMatrixView.show(proj.unid, proj.name);
            }
        });
    }

    public async start(): Promise<void> {
        /*
         * Read the user's start-view preference up-front so the very
         * first paint already lands on the chosen surface. Failure to
         * reach /api/config is non-fatal — we just fall back to the
         * historical matrix landing.
         */
        const startView = await Nppm._fetchStartView();
        this._switchTo(startView === 'dashboard' ? View.dashboard : View.matrix);
        if (startView !== 'dashboard') {
            this._matrix.renderLoading();
        }

        try {
            const response = await Api.listProjects();
            this._projects = response.projects;
            this._installedView.setEditor(response.editor);
            this._sourceGraphView.setEditor(response.editor);
            this._treeview.render(response.projects);

            /*
             * Highlight the corresponding sentinel row so the first
             * paint already reflects where the user is. Without this
             * the treeview shows no selection until the user clicks
             * something, which makes the initial landing look like a
             * half-loaded state.
             */
            this._treeview.setSelected(startView === 'dashboard' ? '__dashboard__' : '__matrix__');
            if (startView === 'dashboard') {
                this._dashboardView.show();
            } else {
                await this._loadMatrix();
            }
        } catch (e) {
            this._matrix.renderError((e as Error).message);
        }
    }

    private static async _fetchStartView(): Promise<'matrix'|'dashboard'> {
        try {
            const res = await fetch('/api/config');
            if (!res.ok) {
                return 'matrix';
            }
            const cfg = await res.json() as {ui?: {startView?: string;};};
            return cfg.ui?.startView === 'dashboard' ? 'dashboard' : 'matrix';
        } catch {
            return 'matrix';
        }
    }

    /**
     * Re-fetch the project list (e.g. after add / edit) and refresh
     * the treeview + matrix when the matrix is the current view.
     */
    private async _refreshProjects(): Promise<void> {
        try {
            const response = await Api.listProjects();
            this._projects = response.projects;
            this._installedView.setEditor(response.editor);
            this._sourceGraphView.setEditor(response.editor);
            this._treeview.render(response.projects);
            if (this._view === View.matrix) {
                void this._loadMatrix();
            }
        } catch (e) {
            console.error('Refreshing project list failed', e);
        }
    }

    /**
     * Push the Dashboard score map to the treeview. Called whenever
     * the Dashboard emits a fresh batch (snapshot load, scan column
     * complete, scan finish). Projects not in the map paint the empty
     * hourglass state.
     */
    private _pushScoresToTreeview(): void {
        this._treeview.setProjectScores(this._dashboardScores);
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
        await this._installedView.show(project.unid, project.name, project.root);
    }

    private async _loadProjectHistory(project: ApiProject): Promise<void> {
        this._switchTo(View.history);
        await this._historyView.show(project.unid, project.name);
    }

    private async _loadProjectMatrix(project: ApiProject): Promise<void> {
        this._switchTo(View.projectMatrix);
        this._currentProjectUnid = project.unid;
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

    private async _loadProjectVulns(project: ApiProject): Promise<void> {
        this._switchTo(View.vulns);
        await this._vulnerabilityTimelineView.show(project.unid, project.name);
    }

    private async _loadProjectPr(project: ApiProject): Promise<void> {
        this._switchTo(View.pr);
        await this._prReviewView.show(project.unid, project.name, project.type);
    }

    private async _loadTemplates(): Promise<void> {
        this._switchTo(View.templates);
        await this._templatesView.show();
    }

    private _loadDashboard(): void {
        this._switchTo(View.dashboard);
        this._dashboardView.show();
    }

    private _loadGlobalScan(): void {
        this._switchTo(View.global);
        this._globalScanView.show();
    }

    private async _loadProjectTemplate(project: ApiProject): Promise<void> {
        this._switchTo(View.template);
        this._currentProjectUnid = project.unid;
        await this._templateView.show(project.unid, project.name, project.type);
    }

    private async _loadProjectSource(project: ApiProject): Promise<void> {
        this._switchTo(View.sourceGraph);
        this._currentProjectUnid = project.unid;
        await this._sourceGraphView.show(project.unid, project.name, project.root);
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

        this._vulnsHost = document.createElement('div');
        this._vulnsHost.className = 'pane pane-vulns';
        this._listRoot.appendChild(this._vulnsHost);

        this._prHost = document.createElement('div');
        this._prHost.className = 'pane pane-pr';
        this._listRoot.appendChild(this._prHost);

        this._templatesHost = document.createElement('div');
        this._templatesHost.className = 'pane pane-templates';
        this._listRoot.appendChild(this._templatesHost);

        this._templateHost = document.createElement('div');
        this._templateHost.className = 'pane pane-template';
        this._listRoot.appendChild(this._templateHost);

        this._sourceGraphHost = document.createElement('div');
        this._sourceGraphHost.className = 'pane pane-source-graph';
        this._listRoot.appendChild(this._sourceGraphHost);

        this._dashboardHost = document.createElement('div');
        this._dashboardHost.className = 'pane pane-dashboard';
        this._listRoot.appendChild(this._dashboardHost);

        this._globalHost = document.createElement('div');
        this._globalHost.className = 'pane pane-global';
        this._listRoot.appendChild(this._globalHost);
    }

    private _switchTo(view: View): void {
        this._view = view;

        if (!this._matrixHost || !this._packageHost || !this._installedHost
            || !this._historyHost || !this._projectMatrixHost
            || !this._depTreeHost || !this._unusedHost || !this._vulnsHost
            || !this._prHost || !this._templatesHost || !this._templateHost
            || !this._sourceGraphHost
            || !this._dashboardHost || !this._globalHost) {
            return;
        }

        this._matrixHost.style.display = view === View.matrix ? '' : 'none';
        this._packageHost.style.display = view === View.packages ? '' : 'none';
        this._installedHost.style.display = view === View.installed ? '' : 'none';
        this._historyHost.style.display = view === View.history ? '' : 'none';
        this._projectMatrixHost.style.display = view === View.projectMatrix ? '' : 'none';
        this._depTreeHost.style.display = view === View.depTree ? '' : 'none';
        this._unusedHost.style.display = view === View.unused ? '' : 'none';
        this._vulnsHost.style.display = view === View.vulns ? '' : 'none';
        this._prHost.style.display = view === View.pr ? '' : 'none';
        this._templatesHost.style.display = view === View.templates ? '' : 'none';
        this._templateHost.style.display = view === View.template ? '' : 'none';
        this._sourceGraphHost.style.display = view === View.sourceGraph ? '' : 'none';
        this._dashboardHost.style.display = view === View.dashboard ? '' : 'none';
        this._globalHost.style.display = view === View.global ? '' : 'none';

        /*
         * Intentionally do NOT stop the dashboard SSE when leaving —
         * a long-running scan should keep ticking so the user can
         * jump to Templates / a project drill-down and find live
         * progress (and detailed sub-phases) waiting when they come
         * back. The stream closes itself on the `end` event; tab
         * unload tears it down via the browser's EventSource cleanup.
         */
    }

}