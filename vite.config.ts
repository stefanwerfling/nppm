import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {defineConfig, Plugin, ViteDevServer} from 'vite';
import {SchemaErrors} from 'vts';
import {ConfigController} from './backend/Api/ConfigController.js';
import {DashboardController} from './backend/Api/DashboardController.js';
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
import {GitHistoryBackfill} from './backend/History/GitHistoryBackfill.js';
import {HistoryStore} from './backend/History/HistoryStore.js';
import {RemoteGitHistoryBackfill} from './backend/History/RemoteGitHistoryBackfill.js';
import {DashboardHistoryStore} from './backend/Dashboard/DashboardHistoryStore.js';
import {NpmDownloadsFetcher} from './backend/Downloads/NpmDownloadsFetcher.js';
import {Project} from './backend/Project/Project.js';
import {GitCommitsFetcher} from './backend/Releases/GitCommitsFetcher.js';
import {GitHeadFetcher} from './backend/Releases/GitHeadFetcher.js';
import {ReleasesFetcher} from './backend/Releases/ReleasesFetcher.js';
import {IntegrityScanner} from './backend/Security/IntegrityScanner.js';
import {PrReviewBuilder} from './backend/PrReview/PrReviewBuilder.js';
import {ProjectGitea} from './backend/Project/ProjectGitea.js';
import {Template} from './backend/Templates/Template.js';
import {TemplateComplianceChecker} from './backend/Templates/TemplateComplianceChecker.js';
import {TemplateLoader} from './backend/Templates/TemplateLoader.js';
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
                    osvClient,
                    securityCache
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
                 * tarball moves under our feet. Both builders go into the
                 * ServerContext; `ctx.pickFingerprintBuilder(version)` is
                 * what the Controllers call to pick between them.
                 */
                const headFingerprintBuilder = new FingerprintBuilder(null);

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
                const templates: Map<string, Template> = templateLoader.loadAll();
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
                    gitCommitsFetcher: gitCommitsFetcher,
                    dashboardSnapshotPath: dashboardSnapshotPath,
                    dashboardHistoryStore: dashboardHistoryStore,
                    downloadsFetcher: downloadsFetcher
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
                DashboardController.register(ctx);

                server.middlewares.use(app);
            }
        };
    }

}

export default defineConfig({
    plugins: [Server.plugin()]
});