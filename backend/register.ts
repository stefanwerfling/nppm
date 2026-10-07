import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {ConfigController} from './Api/ConfigController.js';
import {DashboardController} from './Api/DashboardController.js';
import {FingerprintController} from './Api/FingerprintController.js';
import {FsController} from './Api/FsController.js';
import {GithubController} from './Api/GithubController.js';
import {HistoryController} from './Api/HistoryController.js';
import {ImpactController} from './Api/ImpactController.js';
import {IntegrityController} from './Api/IntegrityController.js';
import {LockfileController} from './Api/LockfileController.js';
import {MatrixController} from './Api/MatrixController.js';
import {PackagesController} from './Api/PackagesController.js';
import {PrReviewController} from './Api/PrReviewController.js';
import {ProjectsController} from './Api/ProjectsController.js';
import {RegistryProxyController} from './Api/RegistryProxyController.js';
import {ReleasesController} from './Api/ReleasesController.js';
import {SbomController} from './Api/SbomController.js';
import {SecurityController} from './Api/SecurityController.js';
import {ServerContext} from './Api/ServerContext.js';
import {SelfCodeController} from './Api/SelfCodeController.js';
import {SourceGraphController} from './Api/SourceGraphController.js';
import {TemplatesController} from './Api/TemplatesController.js';
import {UnusedController} from './Api/UnusedController.js';
import {UpgradeController} from './Api/UpgradeController.js';
import {VulnerabilityController} from './Api/VulnerabilityController.js';
import {JsonCache} from './Cache/JsonCache.js';
import {ConfigProjectType, SchemaConfig} from './Config/Config.js';
import {ConfigLoader} from './Config/ConfigLoader.js';
import {NppmDirs} from './Config/NppmDirs.js';
import {FingerprintBuilder} from './Fingerprint/FingerprintBuilder.js';
import {GitHistoryBackfill} from './History/GitHistoryBackfill.js';
import {HistoryStore} from './History/HistoryStore.js';
import {RemoteGitHistoryBackfill} from './History/RemoteGitHistoryBackfill.js';
import {DashboardHistoryStore} from './Dashboard/DashboardHistoryStore.js';
import {NpmDownloadsFetcher} from './Downloads/NpmDownloadsFetcher.js';
import {Project} from './Project/Project.js';
import {GitCommitsFetcher} from './Releases/GitCommitsFetcher.js';
import {GitHeadFetcher} from './Releases/GitHeadFetcher.js';
import {ReleasesFetcher} from './Releases/ReleasesFetcher.js';
import {IntegrityScanner} from './Security/IntegrityScanner.js';
import {PrReviewBuilder} from './PrReview/PrReviewBuilder.js';
import {ProjectGitea} from './Project/ProjectGitea.js';
import {SelfCodeScanner} from './SelfCode/SelfCodeScanner.js';
import {SourceGraphBuilder} from './SourceGraph/SourceGraphBuilder.js';
import {Template} from './Templates/Template.js';
import {TemplateComplianceChecker} from './Templates/TemplateComplianceChecker.js';
import {TemplateLoader} from './Templates/TemplateLoader.js';
import {TimelineBuilder} from './Vulnerability/TimelineBuilder.js';

/**
 * Options for {@link createNppmApp}. Explicit parameters replace the
 * `NPPM_PROJECT_ROOT` / `NPPM_CONFIG_FILE` process-env globals so nppm
 * can be mounted in-process by a host (pkgstudio) alongside other
 * modules without them clobbering each other's cwd/env. The standalone
 * Vite server passes the same values from its env.
 */
export interface RegisterNppmOptions {
    /** Absolute path the config + caches + history resolve against. */
    projectRoot: string;
    /** Absolute path to nppm.json (optional — empty project list if absent). */
    configFile?: string;
    /**
     * Inline config object, used instead of reading `configFile`. Lets a
     * host (pkgstudio) scope nppm to a single project folder without
     * writing a config file to disk.
     */
    config?: unknown;
}

/**
 * Builds a self-contained Express app with every nppm backend route
 * registered (own `express.json()` body parser, so it can be mounted
 * under any prefix). This is the single reusable wiring point: the
 * standalone `vite.config.ts` mounts it at `/`, pkgstudio mounts it at
 * `/mod/nppm`. The Controllers own every HTTP route; this function owns
 * none.
 */
export function createNppmApp(opts: RegisterNppmOptions): express.Express {
    const app = express();
    app.use(express.json());

    const configFile = opts.configFile;
    const projectRoot = opts.projectRoot;

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
     * wiring can still happen (the user gets an empty project
     * list rather than a crashing server).
     */
    let rawConfig: unknown = {projects: []};
    const rawCandidate: unknown = opts.config !== undefined
        ? opts.config
        : (configFile && fs.existsSync(configFile)
            ? JSON.parse(fs.readFileSync(configFile, 'utf-8'))
            : undefined);

    if (rawCandidate !== undefined) {
        const errors: SchemaErrors = [];
        if (SchemaConfig.validate(rawCandidate, errors)) {
            rawConfig = rawCandidate;
        } else {
            console.log('nppm config has an incorrect structure:');
            console.log(errors);
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
        token: loaded.githubToken
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
        githubToken: loaded.githubToken,
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
     * Source-graph cache pocket. Pure FS walk + regex, so
     * a TTL of `cacheTtlMinutes` is plenty — the
     * fingerprint key already includes file-count and
     * max(mtime), so cache hits only survive when the
     * project actually hasn't changed.
     */
    const sourceGraphCache = new JsonCache(
        path.join(cacheDir, 'source-graph'),
        cacheTtlMinutes
    );
    const sourceGraphBuilder = new SourceGraphBuilder(sourceGraphCache);

    /*
     * Self-code pattern scan over the project's own
     * source. Caching is keyed on (file count, max mtime)
     * so an edit invalidates the cache without re-scanning
     * untouched files.
     */
    const selfCodeCache = new JsonCache(
        path.join(cacheDir, 'self-code'),
        cacheTtlMinutes
    );
    const selfCodeScanner = new SelfCodeScanner(selfCodeCache);

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
     * Controller. Holds the loaded config, project map,
     * history/cache stores, fingerprint builders, and the
     * remote-host fetchers — anything a route handler might
     * need without having to be re-constructed per request.
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
        downloadsFetcher: downloadsFetcher,
        sourceGraphBuilder: sourceGraphBuilder,
        selfCodeScanner: selfCodeScanner,
        initialIgnoredFindings: loaded.ignoredFindings
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
    GithubController.register(ctx);
    SourceGraphController.register(ctx);
    SelfCodeController.register(ctx);
    RegistryProxyController.register(ctx);

    return app;
}
