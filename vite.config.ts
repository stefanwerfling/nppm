import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {defineConfig, Plugin, ViteDevServer} from 'vite';
import {SchemaErrors} from 'vts';
import {
    ApiBulkUpgradeApplyRequest,
    ApiBulkUpgradePick,
    ApiBulkUpgradePreviewRequest,
    ApiBulkUpgradePreviewResponse,
    ApiAddTemplateSourceRequest,
    ApiAddTemplateSourceResponse,
    ApiBulkUpgradePreviewResult,
    ApiBundlesRequest,
    ApiBundlesResponse,
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
    ApiLockfileResponse,
    ApiManifest,
    ApiMatrixHeuristicsRequest,
    ApiMatrixHeuristicsResponse,
    ApiMatrixIntegrityResponse,
    ApiMatrixSecurityRequest,
    ApiMatrixSecurityResponse,
    ApiPackagesResponse,
    ApiProject,
    ApiProjectConfigResponse,
    ApiProjectMutationRequest,
    ApiProjectMutationResponse,
    ApiProjectsResponse,
    ApiReleasesResponse,
    ApiSecurityResponse,
    ApiUnusedResponse,
    ApiUpgradePreviewResponse,
    ApiUpgradeRequest,
    ApiLifecycleScriptsResponse,
    ApiLifecycleRunRequest
} from './shared/Api/ApiTypes.js';
import {ConfigController} from './backend/Api/ConfigController.js';
import {FsController} from './backend/Api/FsController.js';
import {ProjectsController} from './backend/Api/ProjectsController.js';
import {ServerContext} from './backend/Api/ServerContext.js';
import {TemplatesController} from './backend/Api/TemplatesController.js';
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
import {DepGraphBuilder} from './backend/DepGraph/DepGraphBuilder.js';
import {ImpactAnalyzer, ImpactProjectReport} from './backend/Security/ImpactAnalyzer.js';
import {MatrixBuilder} from './backend/Matrix/MatrixBuilder.js';
import {ProjectMatrixBuilder} from './backend/Matrix/ProjectMatrixBuilder.js';
import {Project} from './backend/Project/Project.js';
import {GitCommitsFetcher} from './backend/Releases/GitCommitsFetcher.js';
import {GitHeadFetcher} from './backend/Releases/GitHeadFetcher.js';
import {ReleasesFetcher} from './backend/Releases/ReleasesFetcher.js';
import {CycloneDxBuilder} from './backend/Sbom/CycloneDxBuilder.js';
import {SbomCollector} from './backend/Sbom/SbomCollector.js';
import {SpdxBuilder} from './backend/Sbom/SpdxBuilder.js';
import {LifecycleScriptScanner} from './backend/Upgrade/LifecycleScriptScanner.js';
import {PackageJsonEditor} from './backend/Upgrade/PackageJsonEditor.js';
import {Upgrader} from './backend/Upgrade/Upgrader.js';
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
                    remoteCache,
                    fingerprintBuilder,
                    osvClient,
                    securityCache,
                    securityScanner,
                    unusedDetector,
                    bundlephobiaFetcher,
                    allowInstall,
                    editor
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
                    initialTemplates: templates
                });
                ConfigController.register(ctx);
                FsController.register(ctx);
                ProjectsController.register(ctx);
                TemplatesController.register(ctx);


                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/lockfile — parsed package-lock.json
                 * for one project, or `lockfile: null` if the project has
                 * none committed. 404 on unknown UUID.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/lockfile', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    try {
                        const lockfile = await project.loadLockfile();

                        /*
                         * Auto-snapshot: whenever we successfully read a
                         * lockfile, hand the package set to the history
                         * store. It diffs against the prior snapshot and
                         * appends an entry only when something changed.
                         * Errors are non-fatal — history is best-effort.
                         */
                        if (lockfile) {
                            try {
                                historyStore.recordSnapshot(
                                    project.getKey(),
                                    project.getName(),
                                    lockfile.source,
                                    lockfile.packages.map((p) => ({name: p.name, version: p.version})),
                                    {
                                        cvesForOldVersion: (name, version) => {
                                        /*
                                         * Read from the single-query OSV
                                         * cache only — never hit the
                                         * network from inside the
                                         * history path.
                                         */
                                            const cached = securityCache.get<{data: {id: string;}[]|null;}>(
                                                `osv_${name}@${version}`
                                            );
                                            if (!cached || cached.data === null) {
                                                return null;
                                            }
                                            return cached.data.map((v) => v.id);
                                        }
                                    }
                                );
                            } catch (e) {
                                console.warn(`nppm: history snapshot failed for ${project.getName()}: ${(e as Error).message}`);
                            }
                        }

                        const response: ApiLockfileResponse = {
                            project: {
                                unid: req.params.id,
                                name: project.getName(),
                                type: project.getType()
                            },
                            lockfile: lockfile
                        };
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/depgraph — flat dep graph for the D3
                 * collapsible tree view. Returns `rootDeps` + `packages` map
                 * keyed by `name@version`; the frontend walks it on-demand.
                 * Pulls CVE counts from the existing OSV single-query cache
                 * and `latest` from the registry cache — no extra network
                 * calls.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/depgraph', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    try {
                        const graph = await DepGraphBuilder.build(req.params.id, project, registry, securityCache);
                        if (!graph) {
                            res.status(404).json({
                                success: false,
                                msg: 'No lockfile available for this project — commit package-lock.json or use a local project'
                            });
                            return;
                        }
                        res.status(200).json(graph);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/impact?name=<name>[&version=<pattern>] — cross-
                 * project blast-radius lookup. Iterates every configured
                 * project, builds its DepGraph (warm-cache fast), runs the
                 * ImpactAnalyzer, and returns the aggregate report. The
                 * version pattern is the permissive shape documented on
                 * `ImpactAnalyzer.versionMatches`; missing/empty = match
                 * every version.
                 * 
                 * Hidden projects are scanned too — incident response cares
                 * about all repos, not just the matrix-visible ones.
                 * -------------------------------------------------------------
                 */
                app.get('/api/impact', async(req, res) => {
                    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
                    if (name === '') {
                        res.status(400).json({success: false, msg: 'name query param required'});
                        return;
                    }
                    const rawVersion = typeof req.query.version === 'string' ? req.query.version.trim() : '';
                    const versionPattern = rawVersion === '' ? null : rawVersion;

                    const perProject: ImpactProjectReport[] = [];
                    const skipped: {unid: string; name: string; type: string; reason: string;}[] = [];

                    for (const [unid, project] of projects.entries()) {
                        try {
                            const graph = await DepGraphBuilder.build(unid, project, registry, securityCache);
                            if (!graph) {
                                skipped.push({
                                    unid: unid,
                                    name: project.getName(),
                                    type: project.getType(),
                                    reason: 'no lockfile'
                                });
                                continue;
                            }
                            perProject.push(ImpactAnalyzer.analyzeGraph(graph, name, versionPattern));
                        } catch (e) {
                            skipped.push({
                                unid: unid,
                                name: project.getName(),
                                type: project.getType(),
                                reason: (e as Error).message
                            });
                        }
                    }

                    const report: ApiImpactResponse = ImpactAnalyzer.buildReport(
                        {name: name, versionPattern: versionPattern},
                        perProject,
                        skipped
                    );
                    res.status(200).json(report);
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/matrix — per-project matrix with one
                 * column per workspace (root first) + a Latest column from
                 * the registry. Independent of the global matrix, but reuses
                 * the same status semantics.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/matrix', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    try {
                        const matrix = await ProjectMatrixBuilder.build(req.params.id, project, registry, gitHeadFetcher);
                        res.status(200).json(matrix);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/history — append-only timeline of
                 * package changes for one project. Entries are sorted newest
                 * first; the auto-snapshot writer in the lockfile endpoint
                 * is what populates them.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/history', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    try {
                        const file = historyStore.read(project.getKey(), project.getName());
                        const gitAvailable = (project instanceof ProjectLocal
                            && gitBackfill.isAvailable(project.getRoot()))
                        || (project instanceof ProjectRemote
                            && remoteBackfill.isAvailable(project));
                        const response: ApiHistoryResponse = {
                            project: {
                                unid: req.params.id,
                                name: project.getName(),
                                type: project.getType()
                            },
                            entries: [...file.entries].reverse(),
                            gitAvailable: gitAvailable,
                            gitBackfilledHead: file.gitBackfilledHead ?? null
                        };
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/history/backfill — SSE. Runs the
                 * same git-history reconstruction as the Vulnerability-
                 * Timeline scan, but stops there (no OSV catch-up). Lets
                 * the History view itself trigger a backfill — semantically
                 * the right home for the action, and faster than the full
                 * scan when you don't care about CVE coverage.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/history/backfill', async(req, res) => {
                    const project = projects.get(req.params.id);
                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

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

                    try {
                        const localAvailable = project instanceof ProjectLocal
                        && gitBackfill.isAvailable(project.getRoot());
                        const remoteAvailable = project instanceof ProjectRemote
                        && remoteBackfill.isAvailable(project);
                        const gitAvailable = localAvailable || remoteAvailable;

                        let backfillHead: string|null = null;
                        if (localAvailable && project instanceof ProjectLocal) {
                            backfillHead = gitBackfill.headSha(project.getRoot());
                        } else if (remoteAvailable && project instanceof ProjectRemote) {
                            backfillHead = await remoteBackfill.headSha(project);
                        }

                        const existing = historyStore.read(project.getKey(), project.getName());
                        const backfillRequired = gitAvailable
                        && backfillHead !== null
                        && (existing.gitBackfilledHead !== backfillHead
                            || existing.entries.length === 0);

                        send('start', {gitAvailable: gitAvailable, backfillRequired: backfillRequired});

                        let mergedCount = 0;

                        if (backfillRequired) {
                            let result;
                            if (project instanceof ProjectLocal) {
                                result = gitBackfill.build(
                                    project.getRoot(),
                                    (current, total) => {
                                        if (!aborted) {
                                            send('progress', {current: current, total: total});
                                        }
                                    }
                                );
                            } else if (project instanceof ProjectRemote) {
                                try {
                                    result = await remoteBackfill.build(
                                        project,
                                        (current, total) => {
                                            if (!aborted) {
                                                send('progress', {current: current, total: total});
                                            }
                                        }
                                    );
                                } catch (e) {
                                    send('error', {
                                        msg: `Remote backfill failed: ${(e as Error).message}`
                                    });
                                    res.end();
                                    return;
                                }
                            }

                            if (aborted || !result) {
                                return;
                            }

                            const summary = historyStore.backfillFromGit(
                                project.getKey(),
                                project.getName(),
                                result.entries,
                                result.headSha,
                                result.finalState,
                                result.source === 'committed'
                            );
                            mergedCount = summary.mergedCount;
                        }

                        if (aborted) {
                            return;
                        }

                        const finalState = historyStore.read(project.getKey(), project.getName());
                        send('end', {
                            entries: [...finalState.entries].reverse(),
                            gitBackfilledHead: finalState.gitBackfilledHead ?? null,
                            mergedCount: mergedCount
                        });
                    } catch (e) {
                        send('error', {msg: (e as Error).message});
                    } finally {
                        res.end();
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/vulnerability-timeline — cache-only
                 * read. Walks the project's history (git-backfilled + live
                 * snapshots) and crosses it with the on-disk OSV cache to
                 * produce a list of `[t_in, t_out)` exposure windows per
                 * CVE. Fast — never reaches OSV. The companion `/scan`
                 * SSE endpoint warms the cache + (if needed) backfills
                 * from git first.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/vulnerability-timeline', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    try {
                        const history = historyStore.read(project.getKey(), project.getName());
                        const gitAvailable = (project instanceof ProjectLocal
                            && gitBackfill.isAvailable(project.getRoot()))
                        || (project instanceof ProjectRemote
                            && remoteBackfill.isAvailable(project));
                        const timeline = timelineBuilder.build(
                            {unid: req.params.id, name: project.getName(), type: project.getType()},
                            history,
                            gitAvailable
                        );
                        res.status(200).json(timeline);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/vulnerability-timeline/scan — SSE.
                 * Phase 1: walk git log for `package-lock.json`, splice
                 * reconstructed entries into the history store (idempotent
                 * by HEAD SHA).
                 * Phase 2: dedupe every `name@version` the history mentions,
                 * batch-query OSV for missing ones, write the records into
                 * the OSV caches the regular endpoints already use.
                 * Final event carries the freshly rebuilt timeline so the
                 * frontend doesn't have to round-trip after the stream
                 * closes.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/vulnerability-timeline/scan', async(req, res) => {
                    const project = projects.get(req.params.id);
                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

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

                    try {
                        const localAvailable = project instanceof ProjectLocal
                        && gitBackfill.isAvailable(project.getRoot());
                        const remoteAvailable = project instanceof ProjectRemote
                        && remoteBackfill.isAvailable(project);
                        const gitAvailable = localAvailable || remoteAvailable;

                        let backfillRequired = false;
                        let backfillHead: string|null = null;
                        if (localAvailable && project instanceof ProjectLocal) {
                            backfillHead = gitBackfill.headSha(project.getRoot());
                        } else if (remoteAvailable && project instanceof ProjectRemote) {
                            backfillHead = await remoteBackfill.headSha(project);
                        }
                        if (gitAvailable) {
                            const existing = historyStore.read(project.getKey(), project.getName());
                            /*
                             * Re-run the walk when HEAD moved OR when a
                             * previous run set the watermark but produced
                             * no entries (recovery from a broken earlier
                             * backfill — the user clicks the pill again
                             * expecting their history to fill in).
                             */
                            backfillRequired = backfillHead !== null
                            && (existing.gitBackfilledHead !== backfillHead
                                || existing.entries.length === 0);
                        }

                        send('start', {gitAvailable: gitAvailable, backfillRequired: backfillRequired});

                        if (backfillRequired) {
                            let result;
                            if (project instanceof ProjectLocal) {
                                result = gitBackfill.build(
                                    project.getRoot(),
                                    (current, total) => {
                                        if (!aborted) {
                                            send('progress', {current: current, total: total, phase: 'backfill'});
                                        }
                                    }
                                );
                            } else if (project instanceof ProjectRemote) {
                                try {
                                    result = await remoteBackfill.build(
                                        project,
                                        (current, total) => {
                                            if (!aborted) {
                                                send('progress', {current: current, total: total, phase: 'backfill'});
                                            }
                                        }
                                    );
                                } catch (e) {
                                    send('error', {
                                        msg: `Remote backfill failed: ${(e as Error).message}`
                                    });
                                    res.end();
                                    return;
                                }
                            }
                            if (aborted || !result) {
                                return;
                            }
                            send('phase', {name: 'backfill', total: result.entries.length});

                            const summary = historyStore.backfillFromGit(
                                project.getKey(),
                                project.getName(),
                                result.entries,
                                result.headSha,
                                result.finalState,
                                /*
                                 * Only seed `lastSnapshot` when the
                                 * backfill produced resolved versions
                                 * (`committed` source). Declared-range
                                 * entries from the `package-json`
                                 * fallback would otherwise trip a
                                 * false "every dep changed" diff on
                                 * the next live `recordSnapshot`.
                                 */
                                result.source === 'committed'
                            );
                            send('backfill-done', {
                                mergedCount: summary.mergedCount,
                                headSha: summary.headSha
                            });
                        }

                        if (aborted) {
                            return;
                        }

                        /*
                         * OSV catch-up. Walk every (name, version) the
                         * history mentions, ask the batched OSV endpoint
                         * for the unscanned ones, then refresh the
                         * single-query records for any vuln we discovered
                         * (so the timeline has `published` dates, not just
                         * IDs).
                         */
                        const refreshed = historyStore.read(project.getKey(), project.getName());
                        const versions = new Set<string>();
                        for (const entry of refreshed.entries) {
                            for (const a of entry.added) {
                                versions.add(`${a.name}@${a.version}`);
                            }
                            for (const r of entry.removed) {
                                versions.add(`${r.name}@${r.version}`);
                            }
                            for (const u of entry.updated) {
                                versions.add(`${u.name}@${u.fromVersion}`);
                                versions.add(`${u.name}@${u.toVersion}`);
                            }
                        }
                        for (const p of refreshed.lastSnapshot?.packages ?? []) {
                            versions.add(`${p.name}@${p.version}`);
                        }

                        const pairs: {name: string; version: string;}[] = [];
                        for (const key of versions) {
                            const at = key.lastIndexOf('@');
                            if (at <= 0) {
                                continue;
                            }
                            pairs.push({name: key.slice(0, at), version: key.slice(at + 1)});
                        }

                        send('phase', {name: 'osv', total: pairs.length});

                        const CHUNK_SIZE = 50;
                        let done = 0;
                        const withVulns: {name: string; version: string; vulnIds: string[];}[] = [];

                        for (let i = 0; i < pairs.length; i += CHUNK_SIZE) {
                            if (aborted) {
                                return;
                            }
                            const chunk = pairs.slice(i, i + CHUNK_SIZE);
                            const map = await osvClient.queryBatch(chunk);
                            for (const c of chunk) {
                                const ids = map.get(`${c.name}@${c.version}`);
                                if (ids && ids.length > 0) {
                                    withVulns.push({name: c.name, version: c.version, vulnIds: ids});
                                }
                                done++;
                            }
                            send('progress', {current: done, total: pairs.length, phase: 'osv'});
                        }

                        /*
                         * For coordinates that have vulns but no full-record
                         * cache entry yet, hit the single endpoint so the
                         * timeline gets real `published` dates. Bounded by
                         * the number of vulnerable packages (typically << all).
                         */
                        for (const v of withVulns) {
                            if (aborted) {
                                return;
                            }
                            const cached = securityCache.get<{data: unknown;}>(`osv_${v.name}@${v.version}`);
                            if (cached !== null) {
                                continue;
                            }
                            try {
                                await osvClient.query(v.name, v.version);
                            } catch {
                            /*
                             * best-effort — the batch IDs already let
                             * the timeline classify the vuln, just
                             * without a precise published date.
                             */
                            }
                        }

                        if (aborted) {
                            return;
                        }

                        const finalHistory = historyStore.read(project.getKey(), project.getName());
                        const timeline = timelineBuilder.build(
                            {unid: req.params.id, name: project.getName(), type: project.getType()},
                            finalHistory,
                            gitAvailable
                        );
                        send('end', {timeline: timeline});
                    } catch (e) {
                        send('error', {msg: (e as Error).message});
                    } finally {
                        res.end();
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/pr-review?base=&head= — diff
                 * `package.json` + `package-lock.json` between two git
                 * refs (default `main` vs `HEAD`), surface every changed
                 * dep with its CVE delta from the cached OSV pocket. Local
                 * projects only in v1 — remote would need API-driven
                 * git-show.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/pr-review', async(req, res) => {
                    const project = projects.get(req.params.id);
                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }
                    if (!(project instanceof ProjectLocal)) {
                        res.status(400).json({success: false, msg: 'PR review only supported for local projects'});
                        return;
                    }

                    const base = typeof req.query.base === 'string' && req.query.base.length > 0
                        ? req.query.base
                        : 'main';
                    const head = typeof req.query.head === 'string' && req.query.head.length > 0
                        ? req.query.head
                        : 'HEAD';

                    try {
                        const report = await prReviewBuilder.build(project.getRoot(), base, head, {
                            unid: req.params.id,
                            name: project.getName(),
                            type: project.getType()
                        });
                        res.status(200).json(report);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/integrity — cross-check the
                 * lockfile's pinned `resolved` + `integrity` per entry
                 * against what the registry currently serves. Surfaces
                 * mirror-hijack / dependency-confusion / lockfile-
                 * injection as risk-level findings. Works on any
                 * project type — `loadLockfile()` returns null cleanly
                 * for sources without one (signals via `noLockfile`).
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/integrity', async(req, res) => {
                    const project = projects.get(req.params.id);
                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    try {
                        const lockfile = await project.loadLockfile();
                        if (!lockfile) {
                            const response: ApiIntegrityResponse = {
                                project: {
                                    unid: req.params.id,
                                    name: project.getName(),
                                    type: project.getType()
                                },
                                findings: [],
                                summary: IntegrityScanner.summarize([], 0),
                                noLockfile: true
                            };
                            res.status(200).json(response);
                            return;
                        }

                        const findings = await integrityScanner.scan(lockfile.packages);
                        const totalScanned = new Set(
                            lockfile.packages
                            .filter((p) => p.name && p.version)
                            .map((p) => `${p.name}@${p.version}`)
                        ).size;
                        const summary = IntegrityScanner.summarize(findings, totalScanned);
                        const response: ApiIntegrityResponse = {
                            project: {
                                unid: req.params.id,
                                name: project.getName(),
                                type: project.getType()
                            },
                            findings: findings,
                            summary: summary,
                            noLockfile: false
                        };
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/unused — depcheck-style hygiene scan
                 * for one local project. Returns three buckets (unused /
                 * misplaced / missing) plus the list of files the regex
                 * scanner couldn't fully resolve (dynamic specs). Remote
                 * projects respond with `supported: false` rather than a
                 * 4xx, so the UI can render an info banner.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/unused', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    try {
                        const report = await unusedDetector.scan(project);
                        report.project.unid = req.params.id;
                        const response: ApiUnusedResponse = report;
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/sbom?format=cyclonedx|spdx — emit a
                 * Software Bill of Materials for one project. Walks the
                 * lockfile + registry (no fingerprint downloads) and emits
                 * the requested format. `format` defaults to `cyclonedx`.
                 * Content-Type is `application/vnd.cyclonedx+json` or
                 * `application/spdx+json` so downstream tooling can route
                 * the response by MIME.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/sbom', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    const format = (req.query.format as string|undefined) ?? 'cyclonedx';
                    if (format !== 'cyclonedx' && format !== 'spdx') {
                        res.status(400).json({
                            success: false,
                            msg: `Unsupported format "${format}" — expected cyclonedx | spdx`
                        });
                        return;
                    }

                    try {
                        const collector = new SbomCollector(registry);
                        const data = await collector.collect(project);
                        if (format === 'cyclonedx') {
                            res.set('Content-Type', 'application/vnd.cyclonedx+json');
                            res.status(200).json(CycloneDxBuilder.build(data, '1'));
                        } else {
                            res.set('Content-Type', 'application/spdx+json');
                            res.status(200).json(SpdxBuilder.build(data, '1'));
                        }
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * POST /api/projects/:id/upgrade/preview — plan a single
                 * dep bump in one workspace's package.json. Returns the
                 * before/after file contents (for the diff) plus a
                 * SecurityScanner heads-up on the target version. Does
                 * not write to disk. Local projects only.
                 * -------------------------------------------------------------
                 */
                app.post('/api/projects/:id/upgrade/preview', async(req, res) => {
                    const project = projects.get(req.params.id);
                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }
                    if (!(project instanceof ProjectLocal)) {
                        res.status(400).json({success: false, msg: 'Upgrade only supported for local projects'});
                        return;
                    }

                    const request = req.body as ApiUpgradeRequest;
                    if (!request || !request.name || !request.depType || !request.toRange) {
                        res.status(400).json({success: false, msg: 'name, depType and toRange are required'});
                        return;
                    }

                    try {
                        const upgrader = new Upgrader(project.getRoot());
                        const {path: abs, rel, result} = upgrader.preview(request);

                        /*
                         * Resolve latest from the registry so the modal can
                         * call out the concrete version even when the
                         * requested range is `^X`. Used as the SecurityScanner
                         * input too.
                         */
                        let latestResolved: string|null = null;
                        let heads = null;
                        try {
                            const pack = await registry.fetchOne(request.name);
                            latestResolved = pack?.latest ?? null;
                            if (latestResolved) {
                                heads = await securityScanner.scan(request.name, latestResolved);
                            }
                        } catch {
                        /*
                         * Registry / scanner outages must not block the
                         * preview — the user still sees the planned edit
                         * and can decide.
                         */
                        }

                        const response: ApiUpgradePreviewResponse = {
                            project: {unid: req.params.id, name: project.getName()},
                            request: request,
                            packageJsonPath: abs,
                            packageJsonRel: rel,
                            before: result.before,
                            after: result.after,
                            latestResolvedVersion: latestResolved,
                            securityHeadsUp: heads,
                            allowInstall: allowInstall
                        };
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * POST /api/projects/:id/upgrade/apply — write the edit to
                 * disk (with a backup), then optionally stream
                 * `npm install --ignore-scripts` as SSE. `mode` is either
                 * `edit` (write only) or `install` (write + run). Install
                 * path is gated by `actions.allowInstall` in nppm.json.
                 * -------------------------------------------------------------
                 */
                app.post('/api/projects/:id/upgrade/apply', async(req, res) => {
                    const project = projects.get(req.params.id);
                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }
                    if (!(project instanceof ProjectLocal)) {
                        res.status(400).json({success: false, msg: 'Upgrade only supported for local projects'});
                        return;
                    }

                    const body = req.body as ApiUpgradeRequest & {mode?: 'edit'|'install';};
                    if (!body || !body.name || !body.depType || !body.toRange) {
                        res.status(400).json({success: false, msg: 'name, depType and toRange are required'});
                        return;
                    }
                    const mode = body.mode === 'install' ? 'install' : 'edit';
                    if (mode === 'install' && !allowInstall) {
                        res.status(403).json({success: false, msg: 'Install path disabled — set actions.allowInstall=true in nppm.json'});
                        return;
                    }

                    /*
                     * SSE setup — the route always streams so the frontend
                     * can use one consumer for both modes. Edit-only ends
                     * immediately after the `edit-done` event.
                     */
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

                    let editOut;
                    try {
                        const upgrader = new Upgrader(project.getRoot());
                        editOut = upgrader.applyEdit(body);
                        send('edit-done', {
                            path: editOut.path,
                            rel: editOut.rel,
                            backupDir: editOut.backup.dir,
                            backupFiles: editOut.backup.files
                        });
                        if (mode === 'edit') {
                            send('end', {exitCode: 0});
                            res.end();
                            return;
                        }

                        const sink = {
                            onStart: (command: string, cwd: string) => send('start', {command: command, cwd: cwd}),
                            onStdout: (chunk: string) => send('stdout', {chunk: chunk}),
                            onStderr: (chunk: string) => send('stderr', {chunk: chunk}),
                            onEnd: (exitCode: number|null) => {
                                send('end', {exitCode: exitCode});
                                res.end();
                            },
                            onError: (msg: string) => send('error', {msg: msg})
                        };

                        const child = upgrader.runInstall(sink);
                        req.on('close', () => {
                            try {
                                child.kill();
                            } catch {
                            // child may already have exited — ignore
                            }
                        });
                    } catch (e) {
                        send('error', {msg: (e as Error).message});
                        send('end', {exitCode: null});
                        res.end();
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/lifecycle-scripts — list every
                 * install-time hook (`preinstall`/`install`/`postinstall`/
                 * `prepare`) found across `node_modules/*` of one project.
                 * Read-only; available regardless of `actions.allowInstall`
                 * because the user always wants to *see* what was skipped.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/lifecycle-scripts', async(req, res) => {
                    const project = projects.get(req.params.id);
                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }
                    if (!(project instanceof ProjectLocal)) {
                        res.status(400).json({success: false, msg: 'Lifecycle scripts only supported for local projects'});
                        return;
                    }

                    try {
                        const scanner = new LifecycleScriptScanner(project.getRoot());
                        const response: ApiLifecycleScriptsResponse = {
                            project: {unid: req.params.id, name: project.getName()},
                            scripts: scanner.scan(),
                            allowInstall: allowInstall
                        };
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * POST /api/projects/:id/lifecycle-scripts/run — SSE stream
                 * for `npm rebuild <name>`. Gated by `actions.allowInstall`
                 * because it runs third-party code on the user's machine.
                 * -------------------------------------------------------------
                 */
                app.post('/api/projects/:id/lifecycle-scripts/run', async(req, res) => {
                    const project = projects.get(req.params.id);
                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }
                    if (!(project instanceof ProjectLocal)) {
                        res.status(400).json({success: false, msg: 'Lifecycle scripts only supported for local projects'});
                        return;
                    }
                    if (!allowInstall) {
                        res.status(403).json({success: false, msg: 'Lifecycle script execution disabled — set actions.allowInstall=true in nppm.json'});
                        return;
                    }
                    const body = req.body as ApiLifecycleRunRequest;
                    if (!body || !body.name) {
                        res.status(400).json({success: false, msg: 'name is required'});
                        return;
                    }

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

                    const upgrader = new Upgrader(project.getRoot());
                    const sink = {
                        onStart: (command: string, cwd: string) => send('start', {command: command, cwd: cwd}),
                        onStdout: (chunk: string) => send('stdout', {chunk: chunk}),
                        onStderr: (chunk: string) => send('stderr', {chunk: chunk}),
                        onEnd: (exitCode: number|null) => {
                            send('end', {exitCode: exitCode});
                            res.end();
                        },
                        onError: (msg: string) => send('error', {msg: msg})
                    };

                    const child = upgrader.runRebuild(body.name, sink);
                    req.on('close', () => {
                        try {
                            child.kill();
                        } catch {
                        // already exited
                        }
                    });
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/lockfile/analyze-all — SSE stream that walks every
                 * configured project's lockfile (or node_modules fallback),
                 * deduplicates `name@version` across the whole set, and
                 * streams CVE findings. Driven by the topbar "Alle scannen"
                 * button.
                 * 
                 * Result events include `projects: string[]` so the UI can
                 * show which projects pulled in each vulnerable package.
                 * -------------------------------------------------------------
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

                app.get('/api/lockfile/analyze-all', async(_req, res) => {
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
                    _req.on('close', () => {
                        aborted = true;
                    });

                    try {
                    /*
                     * Phase 1 — collect everything. Walk each project,
                     * map `name@version` → set of project names. Emits
                     * one `progress` per project so the user sees the
                     * collection phase even before OSV runs.
                     */
                        const byKey = new Map<string, {name: string; version: string; projects: Set<string>;}>();
                        const projectList = Array.from(projects.values());

                        let collected = 0;
                        for (const project of projectList) {
                            if (aborted) {
                                return;
                            }

                            try {
                                const lockfile = await project.loadLockfile();
                                if (lockfile) {
                                    for (const pkg of lockfile.packages) {
                                    /*
                                     * Git-sourced deps use the resolved URL
                                     * as their canonical coordinate so OSV
                                     * skips them cleanly instead of asking
                                     * about an unrelated public package of
                                     * the same name.
                                     */
                                        const useGitUrl = pkg.resolved
                                        && GitResolver.isGitVersion(pkg.resolved);
                                        const version = useGitUrl ? pkg.resolved! : pkg.version;
                                        const key = `${pkg.name}@${version}`;
                                        let entry = byKey.get(key);
                                        if (!entry) {
                                            entry = {
                                                name: pkg.name,
                                                version: version,
                                                projects: new Set()
                                            };
                                            byKey.set(key, entry);
                                        }
                                        entry.projects.add(project.getName());
                                    }
                                }
                            } catch (e) {
                            /*
                             * Per-project lockfile failure is non-fatal
                             * — skip that project and keep going.
                             */
                                console.warn(`nppm: analyze-all skipped ${project.getName()}: ${(e as Error).message}`);
                            }

                            collected++;
                            send('progress', {
                                current: 0,
                                total: byKey.size,
                                phase: `Collecting packages (${collected}/${projectList.length} projects)`
                            });
                        }

                        const queue = Array.from(byKey.values());
                        send('start', {total: queue.length});

                        /*
                         * Phase 2 — batch through OSV. Same shape as the
                         * per-project stream.
                         */
                        const CHUNK_SIZE = 50;
                        let done = 0;

                        for (let i = 0; i < queue.length; i += CHUNK_SIZE) {
                            if (aborted) {
                                return;
                            }
                            const chunk = queue.slice(i, i + CHUNK_SIZE);
                            const map = await osvClient.queryBatch(
                                chunk.map((c) => ({name: c.name, version: c.version}))
                            );

                            for (const entry of chunk) {
                                const key = `${entry.name}@${entry.version}`;
                                const vulnIds = map.get(key) ?? null;
                                send('result', {
                                    name: entry.name,
                                    version: entry.version,
                                    vulnIds: vulnIds,
                                    projects: Array.from(entry.projects).sort()
                                });
                                done++;
                            }

                            send('progress', {
                                current: done,
                                total: queue.length,
                                phase: 'Scanning CVEs'
                            });
                        }

                        if (!aborted) {
                            send('end', {total: queue.length});
                        }
                    } catch (e) {
                        send('error', {msg: (e as Error).message});
                    } finally {
                        res.end();
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/lockfile/analyze — SSE stream that
                 * walks every unique (name@version) in the lockfile through
                 * an OSV batch and emits one `result` event per package plus
                 * a `progress` event per chunk. Used by the InstalledView
                 * "Analyse starten" button.
                 * 
                 * Event sequence: `start` (once) → repeated `result` +
                 * `progress` → `end` (once) | `error`.
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/lockfile/analyze', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    res.set({
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        /*
                         * Disable proxy/vite buffering so each event hits the
                         * browser as soon as it's written.
                         */
                        'X-Accel-Buffering': 'no'
                    });
                    res.flushHeaders();

                    const send = (event: string, data: object): void => {
                        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    };

                    let aborted = false;
                    req.on('close', () => {
                    /*
                     * Client closed the SSE stream — stop scheduling new
                     * chunks. We can't cancel an in-flight OSV request
                     * mid-flight, but the loop will exit on the next
                     * iteration.
                     */
                        aborted = true;
                    });

                    try {
                        const lockfile = await project.loadLockfile();

                        if (!lockfile) {
                            send('error', {msg: 'No package-lock.json in this project.'});
                            res.end();
                            return;
                        }

                        /*
                         * Dedupe — the same package can appear multiple times
                         * in nested installs (`node_modules/a/node_modules/b`)
                         * but we only need to ask OSV once per `name@version`.
                         * Git-sourced deps query under their resolved URL so
                         * OSV skips them without asking npm about a foreign
                         * same-named package.
                         */
                        const seen = new Set<string>();
                        const queue: {name: string; version: string;}[] = [];

                        for (const p of lockfile.packages) {
                            const useGitUrl = p.resolved && GitResolver.isGitVersion(p.resolved);
                            const version = useGitUrl ? p.resolved! : p.version;
                            const key = `${p.name}@${version}`;
                            if (seen.has(key)) {
                                continue;
                            }
                            seen.add(key);
                            queue.push({name: p.name, version: version});
                        }

                        send('start', {total: queue.length});

                        const CHUNK_SIZE = 50;
                        let done = 0;

                        for (let i = 0; i < queue.length; i += CHUNK_SIZE) {
                            if (aborted) {
                                return;
                            }

                            const chunk = queue.slice(i, i + CHUNK_SIZE);
                            const map = await osvClient.queryBatch(chunk);

                            for (const pkg of chunk) {
                                const key = `${pkg.name}@${pkg.version}`;
                                const vulnIds = map.get(key) ?? null;
                                send('result', {
                                    name: pkg.name,
                                    version: pkg.version,
                                    vulnIds: vulnIds
                                });
                                done++;
                            }

                            send('progress', {current: done, total: queue.length});
                        }

                        if (!aborted) {
                            send('end', {total: queue.length});
                        }
                    } catch (e) {
                        send('error', {msg: (e as Error).message});
                    } finally {
                        res.end();
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/projects/:id/packages — full manifest list for one
                 * project. 404 on unknown UUID (the frontend can then trigger
                 * a resync via /api/projects).
                 * -------------------------------------------------------------
                 */
                app.get('/api/projects/:id/packages', async(req, res) => {
                    const project = projects.get(req.params.id);

                    if (!project) {
                        res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                        return;
                    }

                    try {
                        const manifests = await project.loadManifests();
                        const apiManifests: ApiManifest[] = manifests.map((m) => ({
                            name: m.name,
                            version: m.version,
                            workspace: m.workspace,
                            dependencies: m.dependencies
                        }));

                        const response: ApiPackagesResponse = {
                            project: {
                                unid: req.params.id,
                                name: project.getName(),
                                type: project.getType()
                            },
                            manifests: apiManifests
                        };

                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/matrix — the cross-project view. Builds once per
                 * request from the current on-disk manifests; registry data
                 * is cached per package on disk (TTL).
                 * -------------------------------------------------------------
                 */
                app.get('/api/matrix', async(_req, res) => {
                    try {
                        const matrix = await MatrixBuilder.build(projects, registry, gitHeadFetcher);
                        res.status(200).json(matrix);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/fingerprint?name=...&version=... — per-file SHA-256
                 * map of a published `pkg@version`. Tarball is fetched from the
                 * npm registry and cached permanently (immutable). Name +
                 * version travel as query params so scoped names (`@scope/foo`)
                 * don't break Express route parsing.
                 * -------------------------------------------------------------
                 */
                app.get('/api/fingerprint', async(req, res) => {
                    const name = typeof req.query.name === 'string' ? req.query.name : '';
                    const version = typeof req.query.version === 'string' ? req.query.version : '';

                    if (!name || !version) {
                        res.status(400).json({
                            success: false,
                            msg: 'name and version query params are required'
                        });
                        return;
                    }

                    try {
                        const fingerprint = await pickFingerprintBuilder(version).build(name, version);
                        const response: ApiFingerprintResponse = {fingerprint: fingerprint};
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * POST /api/matrix/security — bulk vuln-count lookup used by
                 * the matrix badge. Body: `{packages: [{name, version}]}`.
                 * Responds with `vulnIds` per coordinate (or `null` when OSV
                 * failed for that one). Single call lets the frontend
                 * populate every row badge in one round-trip.
                 * -------------------------------------------------------------
                 */
                app.post('/api/matrix/security', async(req, res) => {
                    const body = req.body as Partial<ApiMatrixSecurityRequest>;

                    if (!body || !Array.isArray(body.packages)) {
                        res.status(400).json({
                            success: false,
                            msg: 'body must contain a `packages` array'
                        });
                        return;
                    }

                    const packages = body.packages.filter(
                        (p): p is {name: string; version: string;} =>
                            typeof p?.name === 'string' && typeof p?.version === 'string'
                    );

                    try {
                        const map = await osvClient.queryBatch(packages);
                        const results = packages.map((p) => ({
                            name: p.name,
                            version: p.version,
                            vulnIds: map.get(`${p.name}@${p.version}`) ?? null
                        }));

                        const response: ApiMatrixSecurityResponse = {results: results};
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * POST /api/matrix/heuristics — bulk fingerprint-derived scan
                 * (lifecycle scripts + code patterns) for the matrix badge.
                 * Body: `{packages: [{name, version}]}`. Slow cold path
                 * (downloads tarballs at concurrency=10); warm path hits the
                 * permanent fingerprint cache and runs in milliseconds.
                 * -------------------------------------------------------------
                 */
                app.post('/api/matrix/heuristics', async(req, res) => {
                    const body = req.body as Partial<ApiMatrixHeuristicsRequest>;

                    if (!body || !Array.isArray(body.packages)) {
                        res.status(400).json({
                            success: false,
                            msg: 'body must contain a `packages` array'
                        });
                        return;
                    }

                    const packages = body.packages.filter(
                        (p): p is {name: string; version: string;} =>
                            typeof p?.name === 'string' && typeof p?.version === 'string'
                    );

                    try {
                        const results = await securityScanner.scanHeuristicsBatch(packages);
                        const response: ApiMatrixHeuristicsResponse = {results: results};
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * POST /api/matrix/bundles — bundlephobia batched lookup for
                 * the matrix size column. Body: `{packages: [{name, version}]}`.
                 * Permanent cache (immutable `name@version`) so warm runs
                 * return instantly; cold runs queue under the fetcher's
                 * concurrency cap.
                 * -------------------------------------------------------------
                 */
                app.post('/api/matrix/bundles', async(req, res) => {
                    const body = req.body as Partial<ApiBundlesRequest>;

                    if (!body || !Array.isArray(body.packages)) {
                        res.status(400).json({
                            success: false,
                            msg: 'body must contain a `packages` array'
                        });
                        return;
                    }

                    const packages = body.packages.filter(
                        (p): p is {name: string; version: string;} =>
                            typeof p?.name === 'string' && typeof p?.version === 'string'
                    );

                    try {
                        const map = await bundlephobiaFetcher.fetchMany(packages);
                        const results = packages.map((p) => {
                            const hit = map.get(`${p.name}@${p.version}`);
                            return {
                                name: p.name,
                                version: p.version,
                                size: hit?.size ?? null,
                                gzip: hit?.gzip ?? null,
                                dependencyCount: hit?.dependencyCount ?? null
                            };
                        });
                        const response: ApiBundlesResponse = {results: results};
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/matrix/integrity — cross-project integrity roll-up
                 * for the global matrix badge. Runs `IntegrityScanner.scan`
                 * per project lockfile, merges findings, then collapses by
                 * package name to the worst severity + risk-tier count.
                 * No body: the route always acts on every configured
                 * project. Best-effort per project — a single lockfile read
                 * error skips that project, not the whole response.
                 * -------------------------------------------------------------
                 */
                app.get('/api/matrix/integrity', async(_req, res) => {
                    try {
                        const allFindings = [];
                        for (const project of projects.values()) {
                            try {
                                const lockfile = await project.loadLockfile();
                                if (!lockfile) {
                                    continue;
                                }
                                const findings = await integrityScanner.scan(lockfile.packages);
                                allFindings.push(...findings);
                            } catch {
                            /*
                             * Skip projects whose lockfile cannot be
                             * parsed — the matrix view still gets the
                             * healthy ones.
                             */
                            }
                        }

                        const aggregated = IntegrityScanner.aggregateByName(allFindings);
                        const results = Array.from(aggregated.entries()).map(([name, v]) => ({
                            name: name,
                            severity: v.severity,
                            riskCount: v.riskCount
                        }));
                        const response: ApiMatrixIntegrityResponse = {results: results};
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * POST /api/matrix/upgrade/preview — Bulk-Upgrade Wizard.
                 * Takes an array of picks (one per checked cross-project
                 * matrix cell), plans each as a single-project upgrade
                 * preview, and returns the union. Picks targeting remote
                 * or unknown projects, or deps not present in the target
                 * package.json, come back as `skipped` envelopes so the
                 * modal can still list them.
                 * -------------------------------------------------------------
                 */
                app.post('/api/matrix/upgrade/preview', async(req, res) => {
                    const body = req.body as Partial<ApiBulkUpgradePreviewRequest>;
                    if (!body || !Array.isArray(body.picks)) {
                        res.status(400).json({success: false, msg: 'body must contain a `picks` array'});
                        return;
                    }

                    const picks = body.picks.filter(Server._isValidPick);
                    const results: ApiBulkUpgradePreviewResult[] = [];

                    for (const pick of picks) {
                        const project = projects.get(pick.projectUnid);
                        if (!project) {
                            results.push({pick: pick, skipped: 'unknown-project'});
                            continue;
                        }
                        if (!(project instanceof ProjectLocal)) {
                            results.push({pick: pick, skipped: 'not-local'});
                            continue;
                        }

                        try {
                            const upgrader = new Upgrader(project.getRoot());
                            const single: ApiUpgradeRequest = {
                                workspace: pick.workspace,
                                name: pick.name,
                                depType: pick.depType,
                                fromRange: pick.fromRange,
                                toRange: pick.toRange
                            };
                            const {path: abs, rel, result} = upgrader.preview(single);
                            if (!result.changed && result.before === result.after) {
                            /*
                             * PackageJsonEditor returns changed:false both
                             * when the dep is missing AND when it's already
                             * at the target. Distinguish via currentRange.
                             */
                                const current = PackageJsonEditor.currentRange(
                                    result.before, pick.depType, pick.name
                                );
                                results.push({
                                    pick: pick,
                                    skipped: current === null ? 'not-found' : 'no-change'
                                });
                                continue;
                            }

                            let latestResolved: string|null = null;
                            let heads = null;
                            try {
                                const pack = await registry.fetchOne(pick.name);
                                latestResolved = pack?.latest ?? null;
                                if (latestResolved) {
                                    heads = await securityScanner.scan(pick.name, latestResolved);
                                }
                            } catch {
                            /*
                             * Registry / scanner outages must not block
                             * the bulk preview.
                             */
                            }

                            const preview: ApiUpgradePreviewResponse = {
                                project: {unid: pick.projectUnid, name: project.getName()},
                                request: single,
                                packageJsonPath: abs,
                                packageJsonRel: rel,
                                before: result.before,
                                after: result.after,
                                latestResolvedVersion: latestResolved,
                                securityHeadsUp: heads,
                                allowInstall: allowInstall
                            };
                            results.push({pick: pick, preview: preview});
                        } catch (e) {
                            results.push({pick: pick, skipped: 'not-found', msg: (e as Error).message});
                        }
                    }

                    const response: ApiBulkUpgradePreviewResponse = {results: results, allowInstall: allowInstall};
                    res.status(200).json(response);
                });

                /*
                 * -------------------------------------------------------------
                 * POST /api/matrix/upgrade/apply — SSE. Groups picks by
                 * project, snapshots each project's touched files into ONE
                 * backup folder, applies the edits, then (if mode=install)
                 * runs `npm install --ignore-scripts` once per project,
                 * sequentially. Streams events:
                 * 
                 *   project-start  { unid, name, picks }
                 *   pick-result    { unid, rel, name, changed, skipped? }
                 *   start          { command, cwd }        // install only
                 *   stdout|stderr  { chunk }
                 *   end            { unid, exitCode }
                 *   done           { totalProjects }
                 * -------------------------------------------------------------
                 */
                app.post('/api/matrix/upgrade/apply', async(req, res) => {
                    const body = req.body as Partial<ApiBulkUpgradeApplyRequest>;
                    if (!body || !Array.isArray(body.picks)) {
                        res.status(400).json({success: false, msg: 'body must contain a `picks` array'});
                        return;
                    }
                    const mode = body.mode === 'install' ? 'install' : 'edit';
                    if (mode === 'install' && !allowInstall) {
                        res.status(403).json({
                            success: false,
                            msg: 'Install path disabled — set actions.allowInstall=true in nppm.json'
                        });
                        return;
                    }
                    const picks = body.picks.filter(Server._isValidPick);

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

                    /*
                     * Group by projectUnid, preserving first-seen order so
                     * the UI log reads top-to-bottom by what the user picked.
                     */
                    const groups = new Map<string, ApiBulkUpgradePick[]>();
                    for (const pick of picks) {
                        let list = groups.get(pick.projectUnid);
                        if (!list) {
                            list = [];
                            groups.set(pick.projectUnid, list);
                        }
                        list.push(pick);
                    }

                    let aborted = false;
                    let currentChild: ReturnType<typeof Upgrader.prototype.runInstall>|null = null;
                    req.on('close', () => {
                        aborted = true;
                        try {
                            currentChild?.kill();
                        } catch {
                        // ignore
                        }
                    });

                    try {
                        for (const [unid, list] of groups.entries()) {
                            if (aborted) {
                                return;
                            }
                            const project = projects.get(unid);
                            if (!project) {
                                send('project-skip', {unid: unid, reason: 'unknown-project'});
                                continue;
                            }
                            if (!(project instanceof ProjectLocal)) {
                                send('project-skip', {unid: unid, reason: 'not-local'});
                                continue;
                            }

                            send('project-start', {
                                unid: unid,
                                name: project.getName(),
                                picks: list.length
                            });

                            let backupDir: string|null = null;
                            try {
                                const upgrader = new Upgrader(project.getRoot());
                                const apply = upgrader.applyMany(list.map((p) => ({
                                    workspace: p.workspace,
                                    name: p.name,
                                    depType: p.depType,
                                    fromRange: p.fromRange,
                                    toRange: p.toRange
                                })));
                                backupDir = apply.backup.dir;
                                send('backup', {unid: unid, dir: apply.backup.dir, files: apply.backup.files});
                                for (const out of apply.results) {
                                    send('pick-result', {
                                        unid: unid,
                                        name: out.request.name,
                                        rel: out.rel,
                                        changed: out.result.changed
                                    });
                                }

                                if (mode === 'install') {
                                    await new Promise<void>((resolve) => {
                                        const sink = {
                                            onStart: (command: string, cwd: string) => send('start', {unid: unid, command: command, cwd: cwd}),
                                            onStdout: (chunk: string) => send('stdout', {unid: unid, chunk: chunk}),
                                            onStderr: (chunk: string) => send('stderr', {unid: unid, chunk: chunk}),
                                            onEnd: (exitCode: number|null) => {
                                                send('end', {unid: unid, exitCode: exitCode});
                                                currentChild = null;
                                                resolve();
                                            },
                                            onError: (msg: string) => send('error', {unid: unid, msg: msg})
                                        };
                                        currentChild = upgrader.runInstall(sink);
                                    });
                                }
                            } catch (e) {
                                send('error', {unid: unid, msg: (e as Error).message, backupDir: backupDir});
                            }
                        }

                        if (!aborted) {
                            send('done', {totalProjects: groups.size});
                        }
                    } catch (e) {
                        send('error', {msg: (e as Error).message});
                    } finally {
                        res.end();
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/releases?name=...[&version=...] — merged release
                 * timeline: registry-known versions + (when github.com)
                 * GitHub release titles / bodies. Newest first.
                 * 
                 * When `version` is a git URL we route to the commits
                 * fetcher instead of the registry — the npm packument of
                 * the same `name` belongs to an unrelated package (see the
                 * figtree / fundon collision). Each commit is mapped to
                 * the `Release` shape with sha + subject + author so the
                 * panel can show a per-commit timeline without a new
                 * UI surface.
                 * -------------------------------------------------------------
                 */
                app.get('/api/releases', async(req, res) => {
                    const name = typeof req.query.name === 'string' ? req.query.name : '';
                    const version = typeof req.query.version === 'string' ? req.query.version : '';
                    if (!name) {
                        res.status(400).json({success: false, msg: 'name query param is required'});
                        return;
                    }
                    if (version && GitResolver.isGitVersion(version)) {
                        try {
                            const commits = await gitCommitsFetcher.fetch(version);
                            if (!commits) {
                                const empty: ApiReleasesResponse = {name: name, releases: []};
                                res.status(200).json(empty);
                                return;
                            }
                            const response: ApiReleasesResponse = {
                                name: name,
                                repository: commits.repoUrl,
                                releases: commits.commits.map((c) => ({
                                    version: c.shortSha,
                                    publishedAt: c.date,
                                    name: c.subject,
                                    url: c.url,
                                    publisher: c.author ?? undefined,
                                    sha: c.sha
                                }))
                            };
                            res.status(200).json(response);
                        } catch (e) {
                            res.status(500).json({success: false, msg: (e as Error).message});
                        }
                        return;
                    }
                    try {
                        const out = await releasesFetcher.fetch(name);
                        if (!out) {
                            res.status(404).json({success: false, msg: `Unknown package ${name}`});
                            return;
                        }
                        const response: ApiReleasesResponse = out;
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/security?name=...&version=... — OSV.dev vuln list
                 * + lifecycle-script heuristic for one `pkg@version`. Same
                 * query-param convention as the fingerprint routes so scoped
                 * names survive.
                 * -------------------------------------------------------------
                 */
                app.get('/api/security', async(req, res) => {
                    const name = typeof req.query.name === 'string' ? req.query.name : '';
                    const version = typeof req.query.version === 'string' ? req.query.version : '';

                    if (!name || !version) {
                        res.status(400).json({
                            success: false,
                            msg: 'name and version query params are required'
                        });
                        return;
                    }

                    try {
                        const report = await securityScanner.scan(name, version);
                        const response: ApiSecurityResponse = report;
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                /*
                 * -------------------------------------------------------------
                 * GET /api/fingerprint/diff?name=...&before=...&after=... —
                 * file-level diff between two versions of the same package.
                 * -------------------------------------------------------------
                 */
                app.get('/api/fingerprint/diff', async(req, res) => {
                    const name = typeof req.query.name === 'string' ? req.query.name : '';
                    const before = typeof req.query.before === 'string' ? req.query.before : '';
                    const after = typeof req.query.after === 'string' ? req.query.after : '';

                    if (!name || !before || !after) {
                        res.status(400).json({
                            success: false,
                            msg: 'name, before and after query params are required'
                        });
                        return;
                    }

                    try {
                        const [fpBefore, fpAfter] = await Promise.all([
                            pickFingerprintBuilder(before).build(name, before),
                            pickFingerprintBuilder(after).build(name, after)
                        ]);

                        const response: ApiFingerprintDiffResponse = {
                            before: {name: name, version: before},
                            after: {name: name, version: after},
                            diff: fpBefore && fpAfter ? FingerprintDiffer.diff(fpBefore, fpAfter) : null
                        };
                        res.status(200).json(response);
                    } catch (e) {
                        res.status(500).json({success: false, msg: (e as Error).message});
                    }
                });

                server.middlewares.use(app);
            }
        };
    }


    /**
     * Read → mutate → write helper for nppm.json. Used by the
     * visibility, add, and edit routes so all three follow the
     * same atomic-write pattern: read fresh from disk, hand the
     * parsed object to `mutator`, then serialise with 2-space
     * indent and trailing newline. Throws when no config file
     * path is configured (the CLI can run with an inline rawConfig
     * but no on-disk file; mutations against that combination
     * fail loudly rather than silently dropping the change).
     */
    private static _mutateConfig(
        configFile: string|undefined,
        mutator: (cfg: {projects?: unknown[];} & Record<string, unknown>) => void
    ): void {
        if (!configFile) {
            throw new Error('nppm.json path not configured — cannot persist changes');
        }
        if (!fs.existsSync(configFile)) {
            throw new Error(`nppm.json not found at ${configFile}`);
        }
        const raw = fs.readFileSync(configFile, 'utf-8');
        const cfg = JSON.parse(raw) as {projects?: unknown[];} & Record<string, unknown>;
        mutator(cfg);
        fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
    }

    /**
     * Shape guard for one Bulk-Upgrade pick. Used by both the
     * `/api/matrix/upgrade/preview` and `/api/matrix/upgrade/apply`
     * routes — the body comes off the wire untyped, so a single
     * narrowing predicate keeps the route handlers readable.
     */
    private static _isValidPick(p: unknown): p is ApiBulkUpgradePick {
        if (!p || typeof p !== 'object') {
            return false;
        }
        const o = p as Record<string, unknown>;
        return typeof o.projectUnid === 'string'
            && typeof o.name === 'string'
            && typeof o.depType === 'string'
            && typeof o.fromRange === 'string'
            && typeof o.toRange === 'string';
    }

}

export default defineConfig({
    plugins: [Server.plugin()]
});