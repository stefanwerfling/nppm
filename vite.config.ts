import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {defineConfig, Plugin, ViteDevServer} from 'vite';
import {SchemaErrors} from 'vts';
import {
    ApiAddTemplateSourceRequest,
    ApiAddTemplateSourceResponse,
    ApiCacheClearResponse,
    ApiComplianceApplyEndEvent,
    ApiComplianceApplyProgressEvent,
    ApiComplianceApplyRequest,
    ApiComplianceApplyStartEvent,
    ApiComplianceResponse,
    ApiConfigMutationRequest,
    ApiTemplateDeleteResponse,
    ApiTemplateMutationRequest,
    ApiTemplateMutationResponse,
    ApiConfigMutationResponse,
    ApiConfigResponse,
    ApiFingerprintDiffResponse,
    ApiFsBrowseEntry,
    ApiFsBrowseResponse,
    ApiTemplateSummary,
    ApiTemplatesMatrixCell,
    ApiTemplatesMatrixResponse,
    ApiTemplatesMatrixRow,
    ApiTemplatesResponse,
    ApiFingerprintResponse,
    ApiDashboardGrowthResponse,
    ApiDashboardHistoryResponse,
    ApiPackageTrendsResponse,
    ApiDashboardResponse,
    ApiDashboardSnapshotResponse,
    ApiHistoryResponse,
    ApiImpactResponse,
    ApiIntegrityResponse,
    ApiManifest,
    ApiPackagesResponse,
    ApiProject,
    ApiProjectConfigResponse,
    ApiProjectMutationRequest,
    ApiProjectMutationResponse,
    ApiProjectsResponse,
    ApiReleasesResponse,
    ApiSecurityResponse,
    ApiUnusedResponse,
    ApiLifecycleScriptsResponse,
    ApiLifecycleRunRequest
} from './shared/Api/ApiTypes.js';
import {ConfigController} from './backend/Api/ConfigController.js';
import {FingerprintController} from './backend/Api/FingerprintController.js';
import {FsController} from './backend/Api/FsController.js';
import {HistoryController} from './backend/Api/HistoryController.js';
import {ImpactController} from './backend/Api/ImpactController.js';
import {IntegrityController} from './backend/Api/IntegrityController.js';
import {LockfileController} from './backend/Api/LockfileController.js';
import {MatrixController} from './backend/Api/MatrixController.js';
import {PackagesController} from './backend/Api/PackagesController.js';
import {PrReviewController} from './backend/Api/PrReviewController.js';
import {ProjectsController} from './backend/Api/ProjectsController.js';
import {ReleasesController} from './backend/Api/ReleasesController.js';
import {SbomController} from './backend/Api/SbomController.js';
import {SecurityController} from './backend/Api/SecurityController.js';
import {ServerContext} from './backend/Api/ServerContext.js';
import {TemplatesController} from './backend/Api/TemplatesController.js';
import {UnusedController} from './backend/Api/UnusedController.js';
import {UpgradeController} from './backend/Api/UpgradeController.js';
import {VulnerabilityController} from './backend/Api/VulnerabilityController.js';
import {JsonCache} from './backend/Cache/JsonCache.js';
import {ConfigProjectType, SchemaConfig} from './backend/Config/Config.js';
import {ConfigLoader} from './backend/Config/ConfigLoader.js';
import {NppmDirs} from './backend/Config/NppmDirs.js';
import {FingerprintBuilder} from './backend/Fingerprint/FingerprintBuilder.js';
import {FingerprintDiffer} from './backend/Fingerprint/FingerprintDiff.js';
import {GitResolver} from './backend/Fingerprint/GitResolver.js';
import {GitHistoryBackfill} from './backend/History/GitHistoryBackfill.js';
import {HistoryStore} from './backend/History/HistoryStore.js';
import {RemoteGitHistoryBackfill} from './backend/History/RemoteGitHistoryBackfill.js';
import {CellFinding, DashboardBuilder, DashboardCell, DashboardColumn, ScannerId, SCANNER_IDS} from './backend/Dashboard/DashboardBuilder.js';
import {DashboardHistoryStore} from './backend/Dashboard/DashboardHistoryStore.js';
import {DashboardGrowthBuilder, GrowthProjectInput} from './backend/Dashboard/DashboardGrowthBuilder.js';
import {InstalledSize} from './backend/Dashboard/InstalledSize.js';
import {DownloadsAggregator} from './backend/Dashboard/DownloadsAggregator.js';
import {NpmDownloadsFetcher} from './backend/Downloads/NpmDownloadsFetcher.js';
import {PackageTrendsBuilder} from './backend/Package/PackageTrendsBuilder.js';
import {ImpactAnalyzer, ImpactProjectReport} from './backend/Security/ImpactAnalyzer.js';
import {Project} from './backend/Project/Project.js';
import {GitCommitsFetcher} from './backend/Releases/GitCommitsFetcher.js';
import {GitHeadFetcher} from './backend/Releases/GitHeadFetcher.js';
import {ReleasesFetcher} from './backend/Releases/ReleasesFetcher.js';
import {CycloneDxBuilder} from './backend/Sbom/CycloneDxBuilder.js';
import {SbomCollector} from './backend/Sbom/SbomCollector.js';
import {SpdxBuilder} from './backend/Sbom/SpdxBuilder.js';
import {IntegrityScanner} from './backend/Security/IntegrityScanner.js';
import {MutableResolutionScanner} from './backend/Security/MutableResolutionScanner.js';
import {PrReviewBuilder} from './backend/PrReview/PrReviewBuilder.js';
import {ProjectGitea} from './backend/Project/ProjectGitea.js';
import {ProjectGithub} from './backend/Project/ProjectGithub.js';
import {ProjectLocal} from './backend/Project/ProjectLocal.js';
import {ProjectRemote} from './backend/Project/ProjectRemote.js';
import {SchemaTemplate, Template} from './backend/Templates/Template.js';
import {TemplateApplier} from './backend/Templates/TemplateApplier.js';
import {TemplateComplianceChecker} from './backend/Templates/TemplateComplianceChecker.js';
import {TemplateLoader} from './backend/Templates/TemplateLoader.js';
import {TemplateResolver} from './backend/Templates/TemplateResolver.js';
import {BackupStore} from './backend/Upgrade/BackupStore.js';
import {TimelineBuilder} from './backend/Vulnerability/TimelineBuilder.js';

/**
 * Backend wiring for the Vite dev server. Exposes one public method
 * (`plugin()`) that the Vite config registers — the entire Express
 * app, project loop, route handlers, and SSE streams are wired up
 * inside `configureServer`. Kept as a class so the previously-free
 * `expandEnv` helper has a real home as a private static.
 */
class Server {

    /**
     * Returns the Vite plugin object. The body matches the original
     * `expressMiddleware` factory; the only structural change is that
     * `expandEnv` is now a private static of this class.
     */
    public static plugin(): Plugin {
        return {
            name: 'vite-express-middleware',
            configureServer: function(server: ViteDevServer) {
                const app = express();
                app.use(express.json());

                const configFile = process.env.NPPM_CONFIG_FILE;
                const projectRoot = process.env.NPPM_PROJECT_ROOT ?? process.cwd();

                const envPath = path.resolve(projectRoot, '.env');

                if (fs.existsSync(envPath)) {
                    console.log('Read Env.');
                    dotenv.config({quiet: true, path: envPath});
                }

                /*
                 * Each configured project gets a fresh UUID per server start.
                 * The frontend only ever knows the UUID — restart = new IDs.
                 */
                const projects = new Map<string, Project>();

                /*
                 * Parse + validate the config first; on failure log and
                 * fall through to an empty environment so the rest of the
                 * plugin can still wire its middleware (the user gets an
                 * empty project list rather than a crashing server).
                 */
                let rawConfig: unknown = {projects: []};
                if (configFile && fs.existsSync(configFile)) {
                    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
                    const errors: SchemaErrors = [];
                    if (!SchemaConfig.validate(raw, errors)) {
                        console.log('nppm.json has an incorrect structure:');
                        console.log(errors);
                    } else {
                        rawConfig = raw;
                    }
                }

                const loaded = ConfigLoader.build(rawConfig, projectRoot, {
                    onProjectLoaded: (p) => {
                        const kind = p.getType();
                        if (kind === ConfigProjectType.local) {
                            console.log(`📦 ${p.getName()} (local)`);
                        } else {
                            console.log(`📦 ${p.getName()} (${kind})`);
                        }
                    },
                    onSkip: (msg) => console.warn(`nppm: ${msg}`)
                });

                const {
                    cacheDir,
                    cacheTtlMinutes,
                    registry,
                    fingerprintBuilder,
                    osvClient,
                    securityCache,
                    securityScanner,
                    unusedDetector
                } = loaded;

                for (const project of loaded.projects) {
                    projects.set(crypto.randomUUID(), project);
                }

                /*
                 * Releases cache pocket. GitHub rate-limits anonymous
                 * requests to 60/hour — without caching, a busy user
                 * browsing dep details would burn the budget on every
                 * panel open. TTL keeps it from going *too* stale.
                 */
                const releasesCache = new JsonCache(path.join(cacheDir, 'releases'), cacheTtlMinutes);
                const releasesFetcher = new ReleasesFetcher(registry, releasesCache, {
                    token: process.env.GH_TOKEN
                });

                /*
                 * Build the gitea host list + per-instance token map from
                 * the configured gitea projects. A git dep whose URL
                 * matches one of these hosts gets the same HEAD-info /
                 * commits-list treatment as github.com.
                 */
                const giteaHosts: string[] = [];
                const giteaTokens = new Map<string, string>();
                for (const project of loaded.projects) {
                    if (project instanceof ProjectGitea) {
                        const host = project.getHost();
                        if (host && !giteaHosts.includes(host)) {
                            giteaHosts.push(host);
                        }
                        const token = project.getToken();
                        if (host && token) {
                            giteaTokens.set(host, token);
                        }
                    }
                }
                const gitHeadFetcher = new GitHeadFetcher(releasesCache, {giteaHosts: giteaHosts});
                const gitCommitsFetcher = new GitCommitsFetcher(releasesCache, {
                    giteaHosts: giteaHosts,
                    githubToken: process.env.GH_TOKEN,
                    giteaTokens: giteaTokens
                });

                /**
                 * For coordinates whose content is mutable (a git URL
                 * pointing at HEAD or a branch/tag — i.e. anything other
                 * than a 40-char SHA ref), permanent caching is wrong: the
                 * registered tarball moves under our feet. This helper
                 * decides between the permanent `fingerprintBuilder` and a
                 * cache-less HEAD-aware builder.
                 */
                const headFingerprintBuilder = new FingerprintBuilder(null);
                const pickFingerprintBuilder = (version: string): typeof fingerprintBuilder => {
                    if (!GitResolver.isGitVersion(version)) {
                        return fingerprintBuilder;
                    }
                    const hash = version.indexOf('#');
                    if (hash < 0) {
                        return headFingerprintBuilder;
                    }
                    const ref = version.slice(hash + 1);
                    return /^[0-9a-f]{40}$/i.test(ref) ? fingerprintBuilder : headFingerprintBuilder;
                };

                /*
                 * History persists next to nppm.json (not in cache) — the
                 * user wants to keep / inspect / commit it independent of
                 * the cache directory. Lives under the shared `.nppm/`
                 * parent (alongside `cache/` and `backups/`).
                 */
                const historyDir = NppmDirs.history(projectRoot);
                const historyStore = new HistoryStore(historyDir);
                const gitBackfill = new GitHistoryBackfill();
                const remoteBackfill = new RemoteGitHistoryBackfill();
                const timelineBuilder = new TimelineBuilder(securityCache);
                const prReviewBuilder = new PrReviewBuilder(osvClient);
                const integrityScanner = new IntegrityScanner(registry);

                /*
                 * Dashboard snapshot path. Lives in the cache directory
                 * (a re-scan re-creates it; deleting it just forces the
                 * next view-open to start with the empty-state instead of
                 * the previous result). Not gated behind JsonCache because
                 * we never want TTL-eviction here — the user wants to see
                 * *the last* result regardless of age.
                 */
                const dashboardSnapshotPath = path.join(cacheDir, 'dashboard-snapshot.json');

                /*
                 * Per-day rolling history of dashboard averages — lives under
                 * `.nppm/history/` (not the cache) so the user can commit
                 * it for a long-term ecosystem-health record. Drives the
                 * Dashboard "Trend" tab and the macro-donut delta widget.
                 */
                const dashboardHistoryStore = new DashboardHistoryStore(
                    path.join(historyDir, 'dashboard')
                );

                /*
                 * npm public downloads API — drives the Dashboard Trend
                 * tab's "Downloads" metric. Cached in its own pocket
                 * (`downloads/`) with a 24h TTL since the API exposes
                 * last-week counts that shift daily; permanent caching
                 * would lock in stale numbers.
                 */
                const downloadsCache = new JsonCache(path.join(cacheDir, 'downloads'), 60 * 24);
                const downloadsFetcher = new NpmDownloadsFetcher(downloadsCache);

                /*
                 * Templates catalogue. Lives next to nppm.json in
                 * `nppm-templates/<id>/template.json` (one folder per
                 * template). CRUD routes refresh on every read so user
                 * edits are picked up live. Remote sources are fetched
                 * once at boot into `.nppm/cache/templates-remote/` and
                 * surfaced as read-only entries in the loader.
                 */
                const templatesDir = path.join(projectRoot, 'nppm-templates');
                const remoteTemplatesDir = path.join(cacheDir, 'templates-remote');
                const templateLoader = new TemplateLoader(templatesDir, remoteTemplatesDir);
                const templateSources = (rawConfig as {templateSources?: unknown;}).templateSources;
                if (Array.isArray(templateSources) && templateSources.length > 0) {
                    const urls = templateSources.filter((u): u is string => typeof u === 'string');
                    templateLoader.refreshRemote(urls).then(() => {
                        console.log(`📥 Remote templates refreshed (${urls.length} sources)`);
                    }).catch((e) => {
                        console.warn(`nppm: remote-template refresh failed: ${(e as Error).message}`);
                    });
                }
                let templates: Map<string, Template> = templateLoader.loadAll();
                const templateChecker = new TemplateComplianceChecker();

                /*
                 * Shared bag of state + helpers passed to every
                 * extracted Controller. Routes that still live inline
                 * inside this closure read the same local variables
                 * directly; the migration to controllers is incremental.
                 */
                const ctx = new ServerContext({
                    app: app,
                    projectRoot: projectRoot,
                    configFile: configFile,
                    loaded: loaded,
                    projects: projects,
                    templatesDir: templatesDir,
                    templateLoader: templateLoader,
                    templateChecker: templateChecker,
                    initialTemplates: templates,
                    historyStore: historyStore,
                    gitBackfill: gitBackfill,
                    remoteBackfill: remoteBackfill,
                    timelineBuilder: timelineBuilder,
                    prReviewBuilder: prReviewBuilder,
                    integrityScanner: integrityScanner,
                    headFingerprintBuilder: headFingerprintBuilder,
                    releasesFetcher: releasesFetcher,
                    gitHeadFetcher: gitHeadFetcher,
                    gitCommitsFetcher: gitCommitsFetcher
                });
                ConfigController.register(ctx);
                FsController.register(ctx);
                ProjectsController.register(ctx);
                TemplatesController.register(ctx);
                UpgradeController.register(ctx);
                ImpactController.register(ctx);
                PrReviewController.register(ctx);
                IntegrityController.register(ctx);
                UnusedController.register(ctx);
                SbomController.register(ctx);
                HistoryController.register(ctx);
                VulnerabilityController.register(ctx);
                PackagesController.register(ctx);
                ReleasesController.register(ctx);
                SecurityController.register(ctx);
                FingerprintController.register(ctx);
                LockfileController.register(ctx);
                MatrixController.register(ctx);


                /*
                 * -------------------------------------------------------------
                 * GET /api/dashboard/snapshot — last persisted scan result.
                 * Returned by the SSE `end` handler on every successful
                 * scan; the view uses it to render an immediate first-paint
                 * on open while leaving the user free to trigger a fresh
                 * scan via the Re-scan button.
                 * 
                 * Returns `{snapshot: null, timestamp: null}` when no scan
                 * has run yet (first-ever view-open or after Settings → Clear
                 * cache) — distinct from a 500, which is reserved for actual
                 * disk errors.
                 * -------------------------------------------------------------
                 */
                app.get('/api/dashboard/snapshot', (_req, res) => {
                    try {
                        if (!fs.existsSync(dashboardSnapshotPath)) {
                            const empty: ApiDashboardSnapshotResponse = {snapshot: null, timestamp: null};
                            res.status(200).json(empty);
                            return;
                        }
                        const raw = fs.readFileSync(dashboardSnapshotPath, 'utf-8');
                        const payload = JSON.parse(raw) as ApiDashboardSnapshotResponse;
                        res.status(200).json(payload);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/dashboard/history?days=N — compact rolling history
                 * of per-project + ecosystem averages, one record per UTC day.
                 * Drives the Dashboard "Trend" tab and the macro-donut delta.
                 * `days` clamps to [1, 3650]; defaults to 90.
                 * `previous` carries the entry preceding the most-recent one
                 * *regardless of `days`* so the macro-donut delta works on
                 * any range.
                 * -------------------------------------------------------------
                 */
                app.get('/api/dashboard/history', (req, res) => {
                    try {
                        const raw = typeof req.query.days === 'string'
                            ? Number.parseInt(req.query.days, 10) : 90;
                        const days = Math.min(3650, Math.max(1, Number.isFinite(raw) ? raw : 90));
                        const entries = dashboardHistoryStore.readRange(days);
                        let previous: ReturnType<typeof dashboardHistoryStore.readPrevious> = null;
                        if (entries.length > 0) {
                            previous = dashboardHistoryStore.readPrevious(entries[entries.length - 1].timestamp);
                        }
                        const payload: ApiDashboardHistoryResponse = {entries: entries, previous: previous};
                        res.status(200).json(payload);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/dashboard/growth?days=N — per-project installed-
                 * package count over time + carry-forward ecosystem total.
                 * Reconstructed from each project's `.nppm/history/...json`
                 * (HistoryStore) by replaying add/remove deltas backward from
                 * the latest snapshot. Drives the Dashboard Trend tab's
                 * "Packages" metric.
                 * -------------------------------------------------------------
                 * -------------------------------------------------------------
                 * GET /api/packages/:name/trends — per-package timeline.
                 * Versions + releases-per-month come from the packument
                 * cache (no extra HTTP on warm cache); downloads-per-day
                 * is the last-year range from the npm public downloads
                 * API. The downloads field is `null` if the npm API is
                 * unreachable so the rest of the response still renders.
                 * -------------------------------------------------------------
                 */
                app.get('/api/packages/:name/trends', async(req, res) => {
                    try {
                        const name = decodeURIComponent(req.params.name);
                        const pkg = await registry.fetchOne(name);
                        if (!pkg) {
                            res.status(404).json({success: false, msg: 'package not found'});
                            return;
                        }
                        const base = PackageTrendsBuilder.build(pkg);
                        const downloads = await downloadsFetcher.fetchRange(name, 'last-year');
                        const payload: ApiPackageTrendsResponse = {...base, downloads: downloads};
                        res.status(200).json(payload);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                app.get('/api/dashboard/growth', (req, res) => {
                    try {
                        const raw = typeof req.query.days === 'string'
                            ? Number.parseInt(req.query.days, 10) : 90;
                        const days = Math.min(3650, Math.max(1, Number.isFinite(raw) ? raw : 90));
                        const sinceMs = Date.now() - days * 86400_000;

                        const inputs: GrowthProjectInput[] = [];
                        for (const [unid, project] of projects) {
                            const name = project.getName();
                            const history = historyStore.read(unid, name);
                            inputs.push({unid: unid, name: name, history: history});
                        }
                        const payload: ApiDashboardGrowthResponse =
                        DashboardGrowthBuilder.build(inputs, sinceMs);
                        res.status(200).json(payload);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                // -------------------------------------------------------------
                // GET /api/dashboard/scan — SSE stream that walks every
                // project × every scanner and emits one `cell` event per
                // intersection plus `progress` events with the current
                // project + scanner label. Each project is its own column;
                // the final `end` event carries the full DashboardResponse
                // so a late-joining client (or one that just wants the
                // result) gets a single deterministic snapshot.
                //
                // Per-package scanners (cve / license / scripts / patterns
                // / binaries / maintainer / churn / cadence / freshness /
                // ignoreScripts / typosquat / provenance) share three
                // batched calls (OSV + scanHeuristicsBatch + scanChurnBatch)
                // that run in parallel. Per-project scanners (integrity /
                // unused / template) are then run sequentially. Cold-cache
                // first run takes the bulk of its time inside the three
                // batches; warm runs hit the permanent fingerprint cache
                // and complete in seconds.
                // -------------------------------------------------------------
                app.get('/api/dashboard/scan', async(req, res) => {
                    res.set({
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no'
                    });
                    res.flushHeaders();

                    const send = (event: string, data: object): void => {
                        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    };

                    let aborted = false;
                    req.on('close', () => {
                        aborted = true;
                    });

                    const projectEntries = Array.from(projects.entries());
                    const totalCells = projectEntries.length * SCANNER_IDS.length;
                    const columns: DashboardColumn[] = [];
                    let cellsDone = 0;
                    /*
                     * Per-project name set, collected as each column is
                     * built, so the downloads pass after the loop can do
                     * one big batched fetch.
                     */
                    const projectNames = new Map<string, string[]>();

                    send('start', {scanners: SCANNER_IDS, totalProjects: projectEntries.length});

                    try {
                        for (let projectIdx = 0; projectIdx < projectEntries.length; projectIdx++) {
                            if (aborted) {
                                return;
                            }
                            const [unid, project] = projectEntries[projectIdx];
                            const projectName = project.getName();

                            send('column-start', {
                                projectIndex: projectIdx,
                                projectUnid: unid,
                                projectName: projectName
                            });

                            const cells: Partial<Record<ScannerId, DashboardCell>> = {};
                            let columnError: string|undefined;

                            const emitCell = (scanner: ScannerId, cell: DashboardCell): void => {
                                cells[scanner] = cell;
                                send('cell', {projectUnid: unid, scanner: scanner, cell: cell});
                                cellsDone++;
                                send('progress', {
                                    current: cellsDone,
                                    total: totalCells,
                                    projectName: projectName,
                                    scanner: scanner
                                });
                            };

                            const skipColumnAsNa = (msg: string): void => {
                                columnError = msg;
                                for (const id of SCANNER_IDS) {
                                    emitCell(id, DashboardBuilder.naCell(msg));
                                }
                            };

                            let columnNote: string|undefined;
                            let columnSize: {totalBytes: number; coveredCount: number; totalCount: number;}|undefined;
                            try {
                                send('progress', {
                                    current: cellsDone,
                                    total: totalCells,
                                    projectName: projectName,
                                    scanner: null,
                                    detail: `Loading lockfile for ${projectName}`
                                });
                                const lockfile = await project.loadLockfile();
                                /*
                                 * Build the package list — either from the
                                 * lockfile (exact installed versions) or as a
                                 * best-effort fallback from the manifest's
                                 * declared deps resolved to the registry's
                                 * `latest`. The fallback is what lets remote
                                 * projects without a committed package-lock.json
                                 * still get scanned instead of every cell
                                 * turning N/A.
                                 */
                                const seen = new Set<string>();
                                const packages: {name: string; version: string; displayVersion: string;}[] = [];
                                if (lockfile) {
                                // Record the snapshot so the Dashboard
                                // Trend tab's "Packages" metric sees this
                                // observation. Without this hook the
                                // growth timeline would only fill in when
                                // the user happens to open the per-project
                                // Lockfile view — a Dashboard-only user
                                // would never get a Trend line. Same
                                // best-effort try/catch as the
                                // /api/projects/:id/lockfile handler.
                                    try {
                                        historyStore.recordSnapshot(
                                            project.getKey(),
                                            projectName,
                                            lockfile.source,
                                            lockfile.packages.map((p) => ({name: p.name, version: p.version}))
                                        );
                                    } catch (e) {
                                        console.warn(`nppm: dashboard history snapshot failed for ${projectName}: ${(e as Error).message}`);
                                    }

                                    /*
                                     * Git-sourced deps need the resolved URL as
                                     * the version coordinate, otherwise the
                                     * scanners see the inner semver
                                     * (`figtree@1.0.21`) and happily fetch the
                                     * unrelated public npm package of the same
                                     * name. The semver is kept around as
                                     * `displayVersion` purely for the user-facing
                                     * label.
                                     */
                                    for (const pkg of lockfile.packages) {
                                        const useGitUrl = pkg.resolved
                                        && GitResolver.isGitVersion(pkg.resolved);
                                        const scanVersion = useGitUrl ? pkg.resolved! : pkg.version;
                                        const key = `${pkg.name}@${scanVersion}`;
                                        if (seen.has(key)) {
                                            continue;
                                        }
                                        seen.add(key);
                                        packages.push({
                                            name: pkg.name,
                                            version: scanVersion,
                                            displayVersion: pkg.version
                                        });
                                    }
                                } else {
                                /*
                                 * Manifest fallback. Resolve each declared
                                 * dep to the registry's `latest` — that's
                                 * what `npm install` would pull today. Deps
                                 * with no registry entry (private packages,
                                 * git URLs) are skipped from the scan but
                                 * still counted in the displayed package
                                 * count via the `columnNote`.
                                 */
                                    send('progress', {
                                        current: cellsDone,
                                        total: totalCells,
                                        projectName: projectName,
                                        scanner: null,
                                        detail: `No lockfile — resolving declared deps for ${projectName}`
                                    });
                                    const manifests = await project.loadManifests();
                                    const rootManifest = manifests.find((m) => m.workspace === undefined);
                                    const declared = rootManifest?.dependencies ?? [];
                                    const resolved = await Promise.all(declared.map(async(d) => {
                                        if (GitResolver.isGitVersion(d.version)) {
                                            return {name: d.name, version: d.version, displayVersion: d.version};
                                        }
                                        const reg = await registry.fetchOne(d.name);
                                        const latest = reg?.latest ?? null;
                                        if (!latest) {
                                            return null;
                                        }
                                        return {name: d.name, version: latest, displayVersion: d.version};
                                    }));
                                    for (const entry of resolved) {
                                        if (!entry) {
                                            continue;
                                        }
                                        const key = `${entry.name}@${entry.version}`;
                                        if (seen.has(key)) {
                                            continue;
                                        }
                                        seen.add(key);
                                        packages.push(entry);
                                    }
                                    if (packages.length === 0) {
                                        skipColumnAsNa('no lockfile and no resolvable declared deps');
                                    } else {
                                        columnNote = 'no lockfile — scanned against registry latest';
                                    }
                                }

                                if (packages.length > 0) {
                                    const packageCount = packages.length;

                                    /*
                                     * Stash the distinct package names for
                                     * the post-loop downloads fetch — git
                                     * coordinates' `displayVersion` may be
                                     * a URL but the *name* is the registry
                                     * identifier the downloads API uses.
                                     */
                                    projectNames.set(unid, packages.map((p) => p.name));

                                    /*
                                     * Installed-size aggregate over the
                                     * *display* (registry-semver) versions so
                                     * the packument lookup hits — using
                                     * `pkg.resolved` for git deps here would
                                     * miss the cache entirely. Git deps fall
                                     * out of the sum and show up in
                                     * `coverage.covered / coverage.total`.
                                     */
                                    try {
                                        columnSize = await InstalledSize.compute(
                                            packages.map((p) => ({name: p.name, version: p.displayVersion})),
                                            registry
                                        );
                                    } catch {
                                    // best-effort; leave undefined
                                    }

                                    /*
                                     * Announce the slow phase first so the
                                     * progress bar already shows what's
                                     * happening while the parallel batches run.
                                     * We thread per-package onProgress callbacks
                                     * into the heuristics + churn batches so the
                                     * user sees "Fingerprinting lodash@4.17.21
                                     * (32/84)" instead of a frozen 0/84 — OSV is
                                     * one HTTP request so its only sub-phase is
                                     * "Querying OSV.dev for N packages".
                                     */
                                    send('progress', {
                                        current: cellsDone,
                                        total: totalCells,
                                        projectName: projectName,
                                        scanner: 'cve' as ScannerId,
                                        detail: `Querying OSV.dev for ${packages.length} package(s) — ${projectName}`
                                    });

                                    const emitPkgDetail = (phase: string) =>
                                        (pkgDone: number, pkgTotal: number, pkg: {name: string; version: string;}) => {
                                            send('progress', {
                                                current: cellsDone,
                                                total: totalCells,
                                                projectName: projectName,
                                                scanner: 'cve' as ScannerId,
                                                detail: `${phase} ${pkg.name}@${pkg.version} (${pkgDone}/${pkgTotal}) — ${projectName}`
                                            });
                                        };

                                    const [osvMap, heuristics, churns] = await Promise.all([
                                        osvClient.queryBatch(packages),
                                        securityScanner.scanHeuristicsBatch(packages, 10, emitPkgDetail('Fingerprinting')),
                                        securityScanner.scanChurnBatch(packages, 10, emitPkgDetail('Churn for'))
                                    ]);

                                    if (aborted) {
                                        return;
                                    }

                                    /*
                                     * Per-package scanner buckets — null entries are
                                     * packages where the scanner found nothing.
                                     * Findings collected in parallel so the cell payload
                                     * surfaces concrete labels in the FindingsModal.
                                     */
                                    const perScanner: Record<string, (ReturnType<typeof DashboardBuilder.cveSeverity>)[]> = {
                                        cve: [], license: [], scripts: [], patterns: [],
                                        binaries: [], obfuscation: [], manifestRedFlags: [], capability: [],
                                        maintainer: [], churn: [], cadence: [],
                                        freshness: [], ignoreScripts: [], typosquat: [], provenance: [],
                                        external: [], deprecation: []
                                    };
                                    const perFindings: Record<string, CellFinding[]> = {
                                        cve: [], license: [], scripts: [], patterns: [],
                                        binaries: [], obfuscation: [], manifestRedFlags: [], capability: [],
                                        maintainer: [], churn: [], cadence: [],
                                        freshness: [], ignoreScripts: [], typosquat: [], provenance: [],
                                        external: [], deprecation: []
                                    };

                                    const pushFinding = (scanner: ScannerId, label: string,
                                        sev: ReturnType<typeof DashboardBuilder.cveSeverity>, detail?: string): void => {
                                        if (sev === null) {
                                            return;
                                        }
                                        perFindings[scanner].push({label: label, severity: sev, detail: detail});
                                    };

                                    for (let i = 0; i < packages.length; i++) {
                                        const h = heuristics[i];
                                        /*
                                         * Label uses the human-readable semver (e.g.
                                         * `figtree@1.0.21`); the OSV map is keyed by the
                                         * exact coordinate that was queried, which for
                                         * git deps is the resolved git URL.
                                         */
                                        const label = `${packages[i].name}@${packages[i].displayVersion}`;
                                        const pkgKey = `${packages[i].name}@${packages[i].version}`;
                                        const osvIds = osvMap.get(pkgKey) ?? null;

                                        const cve = DashboardBuilder.cveSeverity(osvIds);
                                        perScanner.cve.push(cve);
                                        pushFinding('cve', label, cve, osvIds && osvIds.length > 0
                                            ? osvIds.slice(0, 3).join(', ') : undefined);

                                        const lic = DashboardBuilder.licenseSeverity(h.license);
                                        perScanner.license.push(lic);
                                        pushFinding('license', label, lic, h.license.spdx ?? undefined);

                                        const sc = DashboardBuilder.scriptsSeverity(h.scripts);
                                        perScanner.scripts.push(sc);
                                        pushFinding('scripts', label, sc, `${h.scripts.count} hook(s)`);

                                        const pat = DashboardBuilder.patternsSeverity(h.patterns);
                                        perScanner.patterns.push(pat);
                                        pushFinding('patterns', label, pat, `${h.patterns.count} match(es)`);

                                        const bin = DashboardBuilder.binariesSeverity(h.binaries);
                                        perScanner.binaries.push(bin);
                                        pushFinding('binaries', label, bin, `${h.binaries.totalCount} file(s)`);

                                        const obf = DashboardBuilder.obfuscationSeverity(h.obfuscation);
                                        perScanner.obfuscation.push(obf);
                                        pushFinding('obfuscation', label, obf,
                                            h.obfuscation.count > 0 ? `${h.obfuscation.count} file(s)` : undefined);

                                        const mrf = DashboardBuilder.manifestRedFlagsSeverity(h.manifestRedFlags);
                                        perScanner.manifestRedFlags.push(mrf);
                                        pushFinding('manifestRedFlags', label, mrf,
                                            h.manifestRedFlags.count > 0 ? `${h.manifestRedFlags.count} flag(s)` : undefined);

                                        const cap = DashboardBuilder.capabilitySeverity(h.capability);
                                        perScanner.capability.push(cap);
                                        pushFinding('capability', label, cap,
                                            h.capability.count > 0 ? `${h.capability.count} capability(ies)` : undefined);

                                        const main = DashboardBuilder.maintainerSeverity(h.maintainer);
                                        perScanner.maintainer.push(main);
                                        pushFinding('maintainer', label, main, h.maintainer.publisher ?? undefined);

                                        const ch = DashboardBuilder.churnSeverity(churns[i]);
                                        perScanner.churn.push(ch);
                                        if (ch !== null && churns[i]) {
                                            const f = churns[i]!;
                                            pushFinding('churn', label, ch, `${f.bumpType} bump · ${f.added + f.removed + f.modified} files`);
                                        }

                                        const cad = DashboardBuilder.cadenceSeverity(h.cadence);
                                        perScanner.cadence.push(cad);
                                        pushFinding('cadence', label, cad,
                                            h.cadence.daysSinceLastRelease !== null
                                                ? `${h.cadence.daysSinceLastRelease}d since last release`
                                                : undefined);

                                        const fr = DashboardBuilder.freshnessSeverity(h.freshness);
                                        perScanner.freshness.push(fr);
                                        pushFinding('freshness', label, fr,
                                            h.freshness.packageAgeDays !== null
                                                ? `${h.freshness.packageAgeDays}d package age`
                                                : undefined);

                                        /*
                                         * ignoreScripts is derived heuristically from the
                                         * batched scripts.maxSeverity since the batch entry
                                         * doesn't carry the IgnoreScriptsFinding directly.
                                         */
                                        const sMax = h.scripts.maxSeverity;
                                        const ign: ReturnType<typeof DashboardBuilder.cveSeverity> =
                                        sMax === 'risk' ? 'risk'
                                            : sMax === 'warn' ? 'info'
                                                : null;
                                        perScanner.ignoreScripts.push(ign);
                                        pushFinding('ignoreScripts', label, ign,
                                            ign === 'risk' ? 'avoid --ignore-scripts'
                                                : ign === 'info' ? 'needs scripts' : undefined);

                                        const ty = DashboardBuilder.typosquatSeverity(h.typosquat);
                                        perScanner.typosquat.push(ty);
                                        pushFinding('typosquat', label, ty,
                                            h.typosquat.closestMatch
                                                ? `vs. ${h.typosquat.closestMatch}` : undefined);

                                        const pv = DashboardBuilder.provenanceSeverity(h.provenance);
                                        perScanner.provenance.push(pv);
                                        pushFinding('provenance', label, pv,
                                            h.provenance.level ?? undefined);

                                        const ext = DashboardBuilder.externalSeverity(h.external);
                                        perScanner.external.push(ext);
                                        pushFinding('external', label, ext,
                                            h.external.count > 0 ? `${h.external.count} source(s)` : undefined);

                                        const dep = DashboardBuilder.deprecationSeverity(h.deprecation);
                                        perScanner.deprecation.push(dep);
                                        pushFinding('deprecation', label, dep,
                                            dep === 'risk' ? 'this version deprecated'
                                                : dep === 'warn' ? 'latest deprecated'
                                                    : dep === 'info' ? 'older version(s) deprecated'
                                                        : undefined);
                                    }

                                    /*
                                     * Per-package cells (12 scanners). Each one's
                                     * findings list is sorted + capped inside the
                                     * builder.
                                     */
                                    const perPackageScanners: ScannerId[] = [
                                        'cve', 'license', 'scripts', 'patterns', 'binaries', 'obfuscation',
                                        'manifestRedFlags', 'capability',
                                        'maintainer', 'churn', 'cadence', 'freshness',
                                        'ignoreScripts', 'typosquat', 'provenance', 'deprecation'
                                    ];
                                    for (const id of perPackageScanners) {
                                        emitCell(id, DashboardBuilder.scorePerPackage(
                                            perScanner[id], packageCount, perFindings[id]
                                        ));
                                        if (aborted) {
                                            return;
                                        }
                                    }

                                    /*
                                     * External-sources column: N/A when no source
                                     * is configured (avoids a misleading 100/100
                                     * when every flag is off). When at least one
                                     * source is enabled, normal per-package
                                     * scoring applies.
                                     */
                                    if (!securityScanner.hasExternalSources()) {
                                        emitCell('external', DashboardBuilder.naCell('no external source configured'));
                                    } else {
                                        emitCell('external', DashboardBuilder.scorePerPackage(
                                            perScanner.external, packageCount, perFindings.external
                                        ));
                                    }
                                    if (aborted) {
                                        return;
                                    }

                                    /*
                                     * Integrity + Mutable-resolution both walk
                                     * the lockfile, so they have nothing to
                                     * compare against when we're scanning from
                                     * the manifest fallback. Emit a clear N/A
                                     * instead of silently scoring 100/100.
                                     */
                                    send('progress', {
                                        current: cellsDone,
                                        total: totalCells,
                                        projectName: projectName,
                                        scanner: 'integrity' as ScannerId
                                    });
                                    if (lockfile) {
                                        const integrityFindings = await integrityScanner.scan(lockfile.packages);
                                        const integritySevs = integrityFindings.map((f) => DashboardBuilder.integritySeverity(f));
                                        const integrityCellFindings: CellFinding[] = integrityFindings.map((f) => ({
                                            label: `${f.name}@${f.version}`,
                                            severity: DashboardBuilder.integritySeverity(f),
                                            detail: f.kind
                                        }));
                                        emitCell('integrity', DashboardBuilder.scorePerProject(
                                            integritySevs, packageCount, integrityCellFindings
                                        ));
                                    } else {
                                        emitCell('integrity', DashboardBuilder.naCell('no lockfile'));
                                    }

                                    send('progress', {
                                        current: cellsDone,
                                        total: totalCells,
                                        projectName: projectName,
                                        scanner: 'mutableResolution' as ScannerId
                                    });
                                    if (lockfile) {
                                        const mutableResolutionReport = MutableResolutionScanner.scan(lockfile);
                                        emitCell('mutableResolution', DashboardBuilder.mutableResolutionCell(mutableResolutionReport));
                                    } else {
                                        emitCell('mutableResolution', DashboardBuilder.naCell('no lockfile'));
                                    }

                                    /*
                                     * Unused — only on local projects; remote sources
                                     * surface as N/A via the detector's `supported`
                                     * flag, which `unusedCell` translates for us.
                                     */
                                    send('progress', {
                                        current: cellsDone,
                                        total: totalCells,
                                        projectName: projectName,
                                        scanner: 'unused' as ScannerId
                                    });
                                    const unusedReport = await unusedDetector.scan(project);
                                    emitCell('unused', DashboardBuilder.unusedCell(unusedReport, packageCount));

                                    // Template compliance — runs only when the
                                    // project lists at least one template id; the
                                    // resolver is the same as the per-project
                                    // /api/projects/:id/compliance route.
                                    send('progress', {
                                        current: cellsDone,
                                        total: totalCells,
                                        projectName: projectName,
                                        scanner: 'template' as ScannerId
                                    });
                                    const declared = project.getTemplates();
                                    if (declared.length === 0) {
                                        emitCell('template', DashboardBuilder.naCell('no templates declared'));
                                    } else {
                                        templates = templateLoader.loadAll();
                                        const knownIds = declared.filter((id) => templates.has(id));
                                        const resolver = new TemplateResolver(
                                            templates,
                                            (id) => templateLoader.getFilesDir(id)
                                        );
                                        const resolved = resolver.resolve(knownIds);
                                        const manifests = await project.loadManifests();
                                        const projectRoot = project instanceof ProjectLocal
                                            ? project.getRoot()
                                            : undefined;
                                        const report = templateChecker.check(manifests, resolved, {projectRoot: projectRoot});
                                        const sevs = report.findings.map((f) => DashboardBuilder.complianceSeverity(f));
                                        const tplCellFindings: CellFinding[] = report.findings.map((f) => ({
                                            label: f.target,
                                            severity: DashboardBuilder.complianceSeverity(f),
                                            detail: f.kind
                                        }));
                                        emitCell('template', DashboardBuilder.scorePerProject(
                                            sevs, packageCount, tplCellFindings
                                        ));
                                    }
                                }
                            } catch (e) {
                                columnError = (e as Error).message;
                                for (const id of SCANNER_IDS) {
                                    if (!(id in cells)) {
                                        emitCell(id, DashboardBuilder.naCell(columnError));
                                    }
                                }
                            }

                            const column: DashboardColumn = {
                                project: {unid: unid, name: projectName, type: project.getType()},
                                cells: cells,
                                ...columnError ? {error: columnError} : {},
                                ...columnNote ? {note: columnNote} : {},
                                ...columnSize !== undefined ? {sizeBytes: columnSize.totalBytes} : {},
                                ...columnSize ? {
                                    sizeCoverage: {
                                        covered: columnSize.coveredCount,
                                        total: columnSize.totalCount
                                    }
                                } : {}
                            };
                            columns.push(column);
                            send('column-end', {column: column});
                        }

                        if (!aborted) {
                        /*
                         * Downloads pass — collect every distinct name
                         * installed by any project, batch-fetch from the
                         * npm public downloads API, then fold into per-
                         * project sums (within-project deduped) +
                         * ecosystem-deduped total. Best-effort: a network
                         * failure here just leaves the downloads fields
                         * unset on the columns.
                         */
                            let ecosystemDownloads: number|null = null;
                            try {
                                const everyName = new Set<string>();
                                for (const ns of projectNames.values()) {
                                    for (const n of ns) {
                                        everyName.add(n);
                                    }
                                }
                                if (everyName.size > 0) {
                                    send('progress', {
                                        current: cellsDone,
                                        total: totalCells,
                                        projectName: '',
                                        scanner: null,
                                        detail: `Fetching weekly downloads for ${everyName.size} distinct package(s)`
                                    });
                                    const downloadsByName = await downloadsFetcher.fetchMany(
                                        Array.from(everyName),
                                        (fetched, total) => {
                                            send('progress', {
                                                current: cellsDone,
                                                total: totalCells,
                                                projectName: '',
                                                scanner: null,
                                                detail: `Fetching weekly downloads (${fetched}/${total})`
                                            });
                                        }
                                    );
                                    const folded = DownloadsAggregator.fold(projectNames, downloadsByName);
                                    for (const col of columns) {
                                        const v = folded.perProject.get(col.project.unid);
                                        if (typeof v === 'number') {
                                            col.downloadsLastWeek = v;
                                        }
                                    }
                                    ecosystemDownloads = folded.ecosystemDeduped;
                                }
                            } catch (e) {
                                console.warn(`nppm: dashboard downloads fetch failed: ${(e as Error).message}`);
                            }

                            const dashboard: ApiDashboardResponse = {
                                scanners: [...SCANNER_IDS],
                                columns: columns
                            };
                            /*
                             * Persist the result so the next view-open can
                             * render an immediate first-paint without waiting
                             * for a fresh SSE scan. Failure to write is
                             * non-fatal — the user just gets the empty state
                             * next time.
                             */
                            try {
                                if (!fs.existsSync(cacheDir)) {
                                    fs.mkdirSync(cacheDir, {recursive: true});
                                }
                                const payload: ApiDashboardSnapshotResponse = {
                                    snapshot: dashboard,
                                    timestamp: new Date().toISOString()
                                };
                                fs.writeFileSync(dashboardSnapshotPath, JSON.stringify(payload));
                                /*
                                 * Append (or overwrite, for same-UTC-day) the
                                 * compact daily record powering the Trend tab
                                 * + macro-donut delta.
                                 */
                                try {
                                    dashboardHistoryStore.recordScan(
                                        dashboard, payload.timestamp!, ecosystemDownloads
                                    );
                                } catch (e) {
                                    console.warn(`nppm: dashboard history save failed: ${(e as Error).message}`);
                                }
                            } catch (e) {
                                console.warn(`nppm: dashboard snapshot save failed: ${(e as Error).message}`);
                            }
                            send('end', {dashboard: dashboard});
                        }
                    } catch (e) {
                        send('error', {msg: (e as Error).message});
                    } finally {
                        res.end();
                    }
                });

                server.middlewares.use(app);
            }
        };
    }

}

export default defineConfig({
    plugins: [Server.plugin()]
});