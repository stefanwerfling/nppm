import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {defineConfig, Plugin} from 'vite';
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
} from './Api/ApiTypes.js';
import {JsonCache} from './Cache/JsonCache.js';
import {ConfigProjectType, SchemaConfig} from './Config/Config.js';
import {ConfigLoader} from './Config/ConfigLoader.js';
import {FingerprintDiffer} from './Fingerprint/FingerprintDiff.js';
import {GitResolver} from './Fingerprint/GitResolver.js';
import {GitHistoryBackfill} from './History/GitHistoryBackfill.js';
import {HistoryStore} from './History/HistoryStore.js';
import {RemoteGitHistoryBackfill} from './History/RemoteGitHistoryBackfill.js';
import {CellFinding, DashboardBuilder, DashboardCell, DashboardColumn, ScannerId, SCANNER_IDS} from './Dashboard/DashboardBuilder.js';
import {DepGraphBuilder} from './DepGraph/DepGraphBuilder.js';
import {ImpactAnalyzer, ImpactProjectReport} from './Security/ImpactAnalyzer.js';
import {MatrixBuilder} from './Matrix/MatrixBuilder.js';
import {ProjectMatrixBuilder} from './Matrix/ProjectMatrixBuilder.js';
import {Project} from './Project/Project.js';
import {ReleasesFetcher} from './Releases/ReleasesFetcher.js';
import {CycloneDxBuilder} from './Sbom/CycloneDxBuilder.js';
import {SbomCollector} from './Sbom/SbomCollector.js';
import {SpdxBuilder} from './Sbom/SpdxBuilder.js';
import {LifecycleScriptScanner} from './Upgrade/LifecycleScriptScanner.js';
import {PackageJsonEditor} from './Upgrade/PackageJsonEditor.js';
import {Upgrader} from './Upgrade/Upgrader.js';
import {IntegrityScanner} from './Security/IntegrityScanner.js';
import {PrReviewBuilder} from './PrReview/PrReviewBuilder.js';
import {ProjectGitea} from './Project/ProjectGitea.js';
import {ProjectGithub} from './Project/ProjectGithub.js';
import {ProjectLocal} from './Project/ProjectLocal.js';
import {ProjectRemote} from './Project/ProjectRemote.js';
import {SchemaTemplate, Template} from './Templates/Template.js';
import {TemplateApplier} from './Templates/TemplateApplier.js';
import {TemplateComplianceChecker} from './Templates/TemplateComplianceChecker.js';
import {TemplateLoader} from './Templates/TemplateLoader.js';
import {TemplateResolver} from './Templates/TemplateResolver.js';
import {BackupStore} from './Upgrade/BackupStore.js';
import {TimelineBuilder} from './Vulnerability/TimelineBuilder.js';

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
            configureServer(server) {
            const app = express();
            app.use(express.json());

            const configFile = process.env.NPPM_CONFIG_FILE;
            const projectRoot = process.env.NPPM_PROJECT_ROOT ?? process.cwd();

            const envPath = path.resolve(projectRoot, '.env');

            if (fs.existsSync(envPath)) {
                console.log('Read Env.');
                dotenv.config({quiet: true, path: envPath});
            }

            // Each configured project gets a fresh UUID per server start.
            // The frontend only ever knows the UUID — restart = new IDs.
            const projects = new Map<string, Project>();

            // Parse + validate the config first; on failure log and
            // fall through to an empty environment so the rest of the
            // plugin can still wire its middleware (the user gets an
            // empty project list rather than a crashing server).
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

            // Releases cache pocket. GitHub rate-limits anonymous
            // requests to 60/hour — without caching, a busy user
            // browsing dep details would burn the budget on every
            // panel open. TTL keeps it from going *too* stale.
            const releasesCache = new JsonCache(path.join(cacheDir, 'releases'), cacheTtlMinutes);
            const releasesFetcher = new ReleasesFetcher(registry, releasesCache, {
                token: process.env.GH_TOKEN
            });

            // History persists next to nppm.json (not in cache) — the
            // user wants to keep / inspect / commit it independent of
            // the cache directory. Hidden dot-prefix to match the
            // `.nppm-cache` convention.
            const historyDir = path.join(projectRoot, '.nppm-history');
            const historyStore = new HistoryStore(historyDir);
            const gitBackfill = new GitHistoryBackfill();
            const remoteBackfill = new RemoteGitHistoryBackfill();
            const timelineBuilder = new TimelineBuilder(securityCache);
            const prReviewBuilder = new PrReviewBuilder(osvClient);
            const integrityScanner = new IntegrityScanner(registry);

            // Dashboard snapshot path. Lives in the cache directory
            // (a re-scan re-creates it; deleting it just forces the
            // next view-open to start with the empty-state instead of
            // the previous result). Not gated behind JsonCache because
            // we never want TTL-eviction here — the user wants to see
            // *the last* result regardless of age.
            const dashboardSnapshotPath = path.join(cacheDir, 'dashboard-snapshot.json');

            // Templates catalogue. Lives next to nppm.json in
            // `nppm-templates/<id>/template.json` (one folder per
            // template). CRUD routes refresh on every read so user
            // edits are picked up live. Remote sources are fetched
            // once at boot into `.nppm-cache/templates-remote/` and
            // surfaced as read-only entries in the loader.
            const templatesDir = path.join(projectRoot, 'nppm-templates');
            const remoteTemplatesDir = path.join(cacheDir, 'templates-remote');
            const templateLoader = new TemplateLoader(templatesDir, remoteTemplatesDir);
            const templateSources = (rawConfig as {templateSources?: unknown}).templateSources;
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

            // -------------------------------------------------------------
            // GET /api/projects — one row per configured project, with a
            // best-effort packageCount so the treeview can show a hint
            // without fetching the full package list.
            // -------------------------------------------------------------
            app.get('/api/projects', async (_req, res) => {
                const result: ApiProject[] = [];

                for (const [unid, project] of projects.entries()) {
                    // Only local projects have an on-disk root the
                    // frontend can plug into the IDE URL — remote
                    // projects live as cached contents-API blobs.
                    const root = project instanceof ProjectLocal
                        ? project.getRoot()
                        : undefined;
                    try {
                        const manifests = await project.loadManifests();
                        const total = manifests.reduce(
                            (sum, m) => sum + m.dependencies.length,
                            0
                        );

                        result.push({
                            unid,
                            name: project.getName(),
                            type: project.getType(),
                            packageCount: total,
                            workspaceCount: manifests.length - 1,
                            root,
                            hidden: project.isHidden()
                        });
                    } catch (e) {
                        result.push({
                            unid,
                            name: project.getName(),
                            type: project.getType(),
                            packageCount: 0,
                            workspaceCount: 0,
                            root,
                            hidden: project.isHidden(),
                            error: (e as Error).message
                        });
                    }
                }

                const response: ApiProjectsResponse = {projects: result, editor};
                res.status(200).json(response);
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/config — return the raw nppm.json
            // entry for one project (including the token, when set).
            // Used by the edit modal to pre-fill its form. The dev
            // server is bound to localhost; the token round-trip
            // never leaves the user's machine.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/config', async (req, res) => {
                const project = projects.get(req.params.id);
                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }
                try {
                    const idx = project.getConfigIndex();
                    if (!configFile || !fs.existsSync(configFile)) {
                        res.status(404).json({success: false, msg: 'nppm.json not found'});
                        return;
                    }
                    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as {projects?: unknown[]};
                    const entry = (cfg.projects ?? [])[idx];
                    if (!entry || typeof entry !== 'object') {
                        res.status(404).json({success: false, msg: 'Project entry not found in nppm.json'});
                        return;
                    }
                    const response: ApiProjectConfigResponse = entry as ApiProjectConfigResponse;
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/projects — add a new project. Body shape is the
            // discriminated union over local/github/gitea; unused-for-
            // the-type fields are tolerated and ignored. Persists to
            // nppm.json and registers the new project in the live map
            // under a fresh UUID — no server restart needed.
            // -------------------------------------------------------------
            app.post('/api/projects', async (req, res) => {
                const body = req.body as ApiProjectMutationRequest;
                const validation = Server._validateProjectBody(body);
                if (validation !== null) {
                    res.status(400).json({success: false, msg: validation});
                    return;
                }
                try {
                    let newIndex = 0;
                    Server._mutateConfig(configFile, (cfg) => {
                        if (!Array.isArray(cfg.projects)) {
                            cfg.projects = [];
                        }
                        const entry = Server._projectEntryFromBody(body);
                        cfg.projects.push(entry);
                        newIndex = cfg.projects.length - 1;
                    });
                    const project = Server._instantiateProject(
                        body, projectRoot, remoteCache, newIndex
                    );
                    const unid = crypto.randomUUID();
                    projects.set(unid, project);

                    const response: ApiProjectMutationResponse = {
                        success: true,
                        project: await Server._toApiProject(unid, project)
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // PUT /api/projects/:id — edit an existing project's
            // settings. The body fully describes the new shape; the
            // type may change (e.g. from `local` to `github`). The
            // UUID stays stable so any open browser tab continues to
            // address the same project.
            // -------------------------------------------------------------
            app.put('/api/projects/:id', async (req, res) => {
                const existing = projects.get(req.params.id);
                if (!existing) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }
                const body = req.body as ApiProjectMutationRequest;
                const validation = Server._validateProjectBody(body);
                if (validation !== null) {
                    res.status(400).json({success: false, msg: validation});
                    return;
                }
                try {
                    const idx = existing.getConfigIndex();
                    Server._mutateConfig(configFile, (cfg) => {
                        if (!Array.isArray(cfg.projects) || idx < 0 || idx >= cfg.projects.length) {
                            throw new Error('Project entry not found in nppm.json (stale index)');
                        }
                        cfg.projects[idx] = Server._projectEntryFromBody(body);
                    });
                    const project = Server._instantiateProject(
                        body, projectRoot, remoteCache, idx
                    );
                    projects.set(req.params.id, project);

                    const response: ApiProjectMutationResponse = {
                        success: true,
                        project: await Server._toApiProject(req.params.id, project)
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // PATCH /api/projects/:id/visibility — toggle the hidden
            // flag both in memory and back into nppm.json. Body:
            // `{hidden: boolean}`. The flag affects whether the
            // project shows up in the cross-project matrix; the
            // treeview always renders the project regardless so
            // per-project drill-down keeps working.
            // -------------------------------------------------------------
            app.patch('/api/projects/:id/visibility', async (req, res) => {
                const project = projects.get(req.params.id);
                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }

                const body = req.body as {hidden?: unknown};
                const hidden = body?.hidden === true;

                try {
                    Server._mutateConfig(configFile, (cfg) => {
                        const idx = project.getConfigIndex();
                        if (!Array.isArray(cfg.projects) || idx < 0 || idx >= cfg.projects.length) {
                            throw new Error('Project entry not found in nppm.json (stale index)');
                        }
                        const entry = cfg.projects[idx] as {hidden?: boolean};
                        if (hidden) {
                            entry.hidden = true;
                        } else {
                            delete entry.hidden;
                        }
                    });
                    project.setHidden(hidden);
                    res.status(200).json({success: true, hidden});
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/config — the non-`projects` sections of nppm.json
            // (server / browser / registry / cache / actions / security)
            // verbatim from disk. The settings modal reads this on open
            // so unsaved disk-side edits don't get clobbered.
            // -------------------------------------------------------------
            app.get('/api/config', async (_req, res) => {
                try {
                    if (!configFile || !fs.existsSync(configFile)) {
                        res.status(404).json({success: false, msg: 'nppm.json not found'});
                        return;
                    }
                    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
                    const {projects: _ignored, ...rest} = cfg;
                    const response: ApiConfigResponse = rest as ApiConfigResponse;
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // PUT /api/config — full replacement of the non-`projects`
            // sections in nppm.json. The `projects` array is left
            // untouched (managed by /api/projects routes). Body is
            // validated against `SchemaConfig` after merge so partial
            // shapes that violate the schema are rejected.
            //
            // Most settings only take effect on a dev-server restart
            // (port, registry URL, cache dir, …). `actions.editor` and
            // `actions.allowInstall` are read fresh per request so they
            // pick up live — but the frontend should still surface a
            // "restart" hint for the others.
            // -------------------------------------------------------------
            app.put('/api/config', async (req, res) => {
                const body = req.body as ApiConfigMutationRequest;
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    res.status(400).json({success: false, msg: 'request body required'});
                    return;
                }
                try {
                    Server._mutateConfig(configFile, (cfg) => {
                        // Replace every known section explicitly; absent
                        // keys in `body` drop the section entirely so
                        // the on-disk shape stays clean.
                        for (const key of ['server', 'browser', 'registry', 'cache', 'actions', 'security', 'ui']) {
                            delete cfg[key];
                        }
                        for (const [key, value] of Object.entries(body)) {
                            cfg[key] = value;
                        }
                        const errors: SchemaErrors = [];
                        if (!SchemaConfig.validate(cfg, errors)) {
                            throw new Error(`Invalid config: ${JSON.stringify(errors)}`);
                        }
                    });
                    const response: ApiConfigMutationResponse = {success: true};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/cache/clear — wipe every cache pocket
            // (registry / fingerprint / releases / security / osv /
            // bundlephobia / npm-user / npm-2fa / templates-remote /
            // remote …) for all projects in one shot. The .nppm-cache
            // directory itself + its subdirectories stay in place so
            // the JsonCache instances spun up at boot keep writing
            // successfully; only the files are removed. The
            // .nppm-history/ store lives at projectRoot, not under
            // cacheDir, so it is never touched.
            // -------------------------------------------------------------
            app.post('/api/cache/clear', async (_req, res) => {
                try {
                    let removed = 0;
                    if (fs.existsSync(cacheDir)) {
                        const walk = (dir: string): void => {
                            for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
                                const full = path.join(dir, e.name);
                                if (e.isDirectory()) {
                                    walk(full);
                                } else {
                                    fs.unlinkSync(full);
                                    removed++;
                                }
                            }
                        };
                        walk(cacheDir);
                    }
                    const response: ApiCacheClearResponse = {success: true, removed};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/templates — catalogue summary. Drives the
            // "Templates" treeview entry's cross-project matrix
            // header. Reloads the on-disk catalogue first so the
            // user sees freshly-edited templates without bouncing
            // the server.
            // -------------------------------------------------------------
            app.get('/api/templates', async (_req, res) => {
                templates = templateLoader.loadAll();
                const response: ApiTemplatesResponse = {
                    templates: [...templates.values()].map((t) => Server._toTemplateSummary(t, templateLoader))
                };
                res.status(200).json(response);
            });

            // -------------------------------------------------------------
            // GET /api/templates/:id — raw template body for the
            // edit modal. Mirrors the on-disk `template.json` 1:1
            // (no `files/` content — only metadata).
            // -------------------------------------------------------------
            app.get('/api/templates/:id', async (req, res, next) => {
                // `/api/templates/matrix` is a sibling route registered
                // later; let it through so express keeps matching.
                if (req.params.id === 'matrix') {
                    return next();
                }
                templates = templateLoader.loadAll();
                const tpl = templates.get(req.params.id);
                if (!tpl) {
                    res.status(404).json({success: false, msg: `Unknown template ${req.params.id}`});
                    return;
                }
                res.status(200).json(tpl);
            });

            // -------------------------------------------------------------
            // POST /api/templates — create a new template. Body =
            // full template JSON. Writes
            // `nppm-templates/<id>/template.json`. Refuses if a
            // template with the same id already exists; the user
            // either edits via PUT or picks a new id.
            // -------------------------------------------------------------
            app.post('/api/templates', async (req, res) => {
                const body = req.body as ApiTemplateMutationRequest;
                const error = Server._validateTemplateBody(body);
                if (error) {
                    res.status(400).json({success: false, msg: error});
                    return;
                }
                const errors: SchemaErrors = [];
                if (!SchemaTemplate.validate(body, errors)) {
                    res.status(400).json({success: false, msg: `Invalid template: ${JSON.stringify(errors)}`});
                    return;
                }
                templates = templateLoader.loadAll();
                if (templates.has(body.id)) {
                    res.status(409).json({success: false, msg: `Template "${body.id}" already exists`});
                    return;
                }
                try {
                    Server._writeTemplate(templatesDir, body);
                    templates = templateLoader.loadAll();
                    const saved = templates.get(body.id);
                    if (!saved) {
                        throw new Error('failed to read back the saved template');
                    }
                    const response: ApiTemplateMutationResponse = {
                        success: true,
                        template: Server._toTemplateSummary(saved, templateLoader)
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // PUT /api/templates/:id — full replacement of the
            // template body. The id in the URL is authoritative —
            // body.id is required to match (defends against the form
            // accidentally renaming the template through edit; rename
            // is a delete + create dance).
            // -------------------------------------------------------------
            app.put('/api/templates/:id', async (req, res) => {
                const body = req.body as ApiTemplateMutationRequest;
                if (body?.id !== req.params.id) {
                    res.status(400).json({success: false, msg: 'id in body must match id in URL'});
                    return;
                }
                const error = Server._validateTemplateBody(body);
                if (error) {
                    res.status(400).json({success: false, msg: error});
                    return;
                }
                const errors: SchemaErrors = [];
                if (!SchemaTemplate.validate(body, errors)) {
                    res.status(400).json({success: false, msg: `Invalid template: ${JSON.stringify(errors)}`});
                    return;
                }
                templates = templateLoader.loadAll();
                if (!templates.has(body.id)) {
                    res.status(404).json({success: false, msg: `Unknown template ${body.id}`});
                    return;
                }
                const src = templateLoader.getSource(body.id);
                if (src?.kind === 'remote') {
                    res.status(403).json({success: false, msg: `Template "${body.id}" is remote (read-only)`});
                    return;
                }
                try {
                    Server._writeTemplate(templatesDir, body);
                    templates = templateLoader.loadAll();
                    const saved = templates.get(body.id);
                    if (!saved) {
                        throw new Error('failed to read back the saved template');
                    }
                    const response: ApiTemplateMutationResponse = {
                        success: true,
                        template: Server._toTemplateSummary(saved, templateLoader)
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // DELETE /api/templates/:id — remove the entire
            // `nppm-templates/<id>/` directory (including any
            // `files/` content). Projects that still reference the
            // id keep their config but compliance reports it as
            // `unresolvedIds[]` on the next read.
            // -------------------------------------------------------------
            app.delete('/api/templates/:id', async (req, res) => {
                templates = templateLoader.loadAll();
                if (!templates.has(req.params.id)) {
                    res.status(404).json({success: false, msg: `Unknown template ${req.params.id}`});
                    return;
                }
                const src = templateLoader.getSource(req.params.id);
                if (src?.kind === 'remote') {
                    res.status(403).json({success: false, msg: `Template "${req.params.id}" is remote (read-only)`});
                    return;
                }
                try {
                    const dir = path.join(templatesDir, req.params.id);
                    fs.rmSync(dir, {recursive: true, force: true});
                    templates = templateLoader.loadAll();
                    const response: ApiTemplateDeleteResponse = {success: true};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/templates/sources — append a remote template
            // source URL to nppm.json's `templateSources` array and
            // immediately refresh the remote cache so the new
            // template shows up without restarting the dev server.
            // -------------------------------------------------------------
            app.post('/api/templates/sources', async (req, res) => {
                const body = req.body as Partial<ApiAddTemplateSourceRequest>;
                const url = typeof body?.url === 'string' ? body.url.trim() : '';
                if (!url || !/^https?:\/\//i.test(url)) {
                    res.status(400).json({success: false, msg: 'http(s) URL required'});
                    return;
                }
                try {
                    Server._mutateConfig(configFile, (cfg) => {
                        const existing = Array.isArray(cfg.templateSources)
                            ? (cfg.templateSources as string[])
                            : [];
                        if (existing.includes(url)) {
                            throw new Error(`URL already configured: ${url}`);
                        }
                        cfg.templateSources = [...existing, url];
                    });
                    const cfg = JSON.parse(fs.readFileSync(configFile!, 'utf-8')) as Record<string, unknown>;
                    const urls = Array.isArray(cfg.templateSources)
                        ? (cfg.templateSources as string[]).filter((u): u is string => typeof u === 'string')
                        : [];
                    await templateLoader.refreshRemote(urls);
                    templates = templateLoader.loadAll();
                    let templateId: string|null = null;
                    for (const id of templates.keys()) {
                        const src = templateLoader.getSource(id);
                        if (src?.kind === 'remote' && src.url === url) {
                            templateId = id;
                            break;
                        }
                    }
                    const response: ApiAddTemplateSourceResponse = {success: true, templateId};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/compliance — diff one project
            // against its configured template chain. Empty
            // `templateIds` → empty findings; unknown templates are
            // surfaced in `unresolvedIds` so the user can see the typo.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/compliance', async (req, res) => {
                const project = projects.get(req.params.id);
                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }
                try {
                    templates = templateLoader.loadAll();
                    const requestedIds = project.getTemplates();
                    const knownIds = requestedIds.filter((id) => templates.has(id));
                    const unresolvedIds = requestedIds.filter((id) => !templates.has(id));
                    const resolver = new TemplateResolver(
                        templates,
                        (id) => templateLoader.getFilesDir(id)
                    );
                    const resolved = resolver.resolve(knownIds);
                    const manifests = await project.loadManifests();
                    const projectRoot = project instanceof ProjectLocal
                        ? project.getRoot()
                        : undefined;
                    const report = templateChecker.check(manifests, resolved, {projectRoot});
                    const response: ApiComplianceResponse = {
                        project: {unid: req.params.id, name: project.getName()},
                        templateIds: report.templateIds,
                        findings: report.findings,
                        worst: report.worst,
                        unresolvedIds
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/projects/:id/compliance/apply — SSE stream that
            // applies the selected compliance findings to disk. The
            // body is `{targets: string[]}` (subset of the finding
            // target strings from `GET .../compliance`). A single
            // backup snapshot is written first; every per-target
            // outcome is streamed back so the UI can render a live
            // log + final counter.
            //
            // Only local projects are eligible — remote projects (no
            // on-disk root) get a 400 response. `actions.allowInstall`
            // is *not* gated against the apply path: this only edits
            // package.json / config files, never runs `npm install`.
            // -------------------------------------------------------------
            app.post('/api/projects/:id/compliance/apply', async (req, res) => {
                const project = projects.get(req.params.id);
                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }
                if (!(project instanceof ProjectLocal)) {
                    res.status(400).json({success: false, msg: 'Template apply only supports local projects'});
                    return;
                }
                const body = req.body as ApiComplianceApplyRequest;
                const targets = Array.isArray(body?.targets) ? body.targets : [];
                if (targets.length === 0) {
                    res.status(400).json({success: false, msg: 'targets array required'});
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

                try {
                    templates = templateLoader.loadAll();
                    const requestedIds = project.getTemplates();
                    const knownIds = requestedIds.filter((id) => templates.has(id));
                    const resolver = new TemplateResolver(
                        templates,
                        (id) => templateLoader.getFilesDir(id)
                    );
                    const resolved = resolver.resolve(knownIds);
                    const manifests = await project.loadManifests();
                    const projectRoot = project.getRoot();
                    const backupStore = new BackupStore(path.join(projectRoot, '.nppm-backups'));
                    const applier = new TemplateApplier();

                    const start: ApiComplianceApplyStartEvent = {count: targets.length, backupDir: null};
                    send('start', start);

                    const result = applier.apply({
                        projectRoot,
                        manifests,
                        template: resolved,
                        selectedTargets: targets,
                        backupStore,
                        onProgress: (i, total, outcome) => {
                            const ev: ApiComplianceApplyProgressEvent = {
                                current: i,
                                total,
                                target: outcome.target,
                                status: outcome.status,
                                msg: outcome.msg
                            };
                            send('progress', ev);
                        }
                    });

                    if (result.backup) {
                        const startUpdate: ApiComplianceApplyStartEvent = {
                            count: targets.length,
                            backupDir: result.backup.dir
                        };
                        send('backup', startUpdate);
                    }

                    const applied = result.outcomes.filter((o) => o.status === 'applied').length;
                    const skipped = result.outcomes.filter((o) => o.status === 'skipped').length;
                    const errored = result.outcomes.filter((o) => o.status === 'error').length;
                    const end: ApiComplianceApplyEndEvent = {applied, skipped, errored};
                    send('end', end);
                } catch (e) {
                    send('error', {msg: (e as Error).message});
                } finally {
                    res.end();
                }
            });

            // -------------------------------------------------------------
            // GET /api/templates/matrix — cross-project compliance
            // overview. One row per template, one cell per project.
            // Cells for projects that don't list the template id stay
            // null (template not applicable). Used by the Templates
            // treeview entry's main view.
            // -------------------------------------------------------------
            app.get('/api/templates/matrix', async (_req, res) => {
                templates = templateLoader.loadAll();
                const resolver = new TemplateResolver(
                    templates,
                    (id) => templateLoader.getFilesDir(id)
                );
                const rows: ApiTemplatesMatrixRow[] = [];
                for (const tpl of templates.values()) {
                    const cells: ApiTemplatesMatrixCell[] = [];
                    for (const [unid, project] of projects.entries()) {
                        const declared = project.getTemplates();
                        if (!declared.includes(tpl.id)) {
                            cells.push({
                                projectUnid: unid,
                                projectName: project.getName(),
                                matchedTemplateIds: [],
                                worst: null,
                                findingCount: 0
                            });
                            continue;
                        }
                        try {
                            const knownIds = declared.filter((id) => templates.has(id));
                            const resolved = resolver.resolve(knownIds);
                            const manifests = await project.loadManifests();
                            const projectRoot = project instanceof ProjectLocal
                                ? project.getRoot()
                                : undefined;
                            const report = templateChecker.check(manifests, resolved, {projectRoot});
                            cells.push({
                                projectUnid: unid,
                                projectName: project.getName(),
                                matchedTemplateIds: report.templateIds,
                                worst: report.worst,
                                findingCount: report.findings.length
                            });
                        } catch (e) {
                            cells.push({
                                projectUnid: unid,
                                projectName: project.getName(),
                                matchedTemplateIds: declared,
                                worst: 'risk',
                                findingCount: 0
                            });
                            console.warn(`nppm: template matrix failed for ${project.getName()}: ${(e as Error).message}`);
                        }
                    }
                    rows.push({
                        template: Server._toTemplateSummary(tpl, templateLoader),
                        cells
                    });
                }
                const response: ApiTemplatesMatrixResponse = {rows};
                res.status(200).json(response);
            });

            // -------------------------------------------------------------
            // GET /api/fs/browse?path=<absolute>[&showHidden=1] — list
            // the directory at `path` so the frontend directory picker
            // can navigate the user's filesystem. The dev server runs
            // on the user's box (bound to localhost), so the user
            // already has full filesystem access via their shell —
            // no traversal guard required; `path` must just be
            // absolute (a relative path would be ambiguous w.r.t the
            // server cwd).
            //
            // Defaults to `process.cwd()` when `path` is omitted (matches
            // the initial-state the picker wants on first open).
            //
            // Per-entry EACCES is swallowed silently — the offending
            // row just disappears from the list rather than failing the
            // whole request.
            // -------------------------------------------------------------
            app.get('/api/fs/browse', async (req, res) => {
                const requested = typeof req.query.path === 'string' && req.query.path.length > 0
                    ? req.query.path
                    : process.cwd();
                const showHidden = req.query.showHidden === '1';

                if (!path.isAbsolute(requested)) {
                    res.status(400).json({success: false, msg: `path must be absolute, got "${requested}"`});
                    return;
                }

                try {
                    const response = await Server._listDirectory(requested, showHidden);
                    res.status(200).json(response);
                } catch (e) {
                    const err = e as NodeJS.ErrnoException;
                    if (err.code === 'ENOENT') {
                        // Fall back to home directory when the
                        // requested path doesn't exist — most likely
                        // a stale value from the form field.
                        try {
                            const fallback = await Server._listDirectory(os.homedir(), showHidden);
                            res.status(200).json(fallback);
                            return;
                        } catch (e2) {
                            res.status(500).json({success: false, msg: (e2 as Error).message});
                            return;
                        }
                    }
                    res.status(500).json({success: false, msg: err.message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/lockfile — parsed package-lock.json
            // for one project, or `lockfile: null` if the project has
            // none committed. 404 on unknown UUID.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/lockfile', async (req, res) => {
                const project = projects.get(req.params.id);

                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }

                try {
                    const lockfile = await project.loadLockfile();

                    // Auto-snapshot: whenever we successfully read a
                    // lockfile, hand the package set to the history
                    // store. It diffs against the prior snapshot and
                    // appends an entry only when something changed.
                    // Errors are non-fatal — history is best-effort.
                    if (lockfile) {
                        try {
                            historyStore.recordSnapshot(
                                project.getKey(),
                                project.getName(),
                                lockfile.source,
                                lockfile.packages.map((p) => ({name: p.name, version: p.version})),
                                {
                                    cvesForOldVersion: (name, version) => {
                                        // Read from the single-query OSV
                                        // cache only — never hit the
                                        // network from inside the
                                        // history path.
                                        const cached = securityCache.get<{data: {id: string}[]|null}>(
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
                        lockfile
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/depgraph — flat dep graph for the D3
            // collapsible tree view. Returns `rootDeps` + `packages` map
            // keyed by `name@version`; the frontend walks it on-demand.
            // Pulls CVE counts from the existing OSV single-query cache
            // and `latest` from the registry cache — no extra network
            // calls.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/depgraph', async (req, res) => {
                const project = projects.get(req.params.id);

                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }

                try {
                    const graph = await DepGraphBuilder.build(req.params.id, project, registry, securityCache);
                    if (!graph) {
                        res.status(404).json({success: false, msg: 'Kein Lockfile vorhanden'});
                        return;
                    }
                    res.status(200).json(graph);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/impact?name=<name>[&version=<pattern>] — cross-
            // project blast-radius lookup. Iterates every configured
            // project, builds its DepGraph (warm-cache fast), runs the
            // ImpactAnalyzer, and returns the aggregate report. The
            // version pattern is the permissive shape documented on
            // `ImpactAnalyzer.versionMatches`; missing/empty = match
            // every version.
            //
            // Hidden projects are scanned too — incident response cares
            // about all repos, not just the matrix-visible ones.
            // -------------------------------------------------------------
            app.get('/api/impact', async (req, res) => {
                const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
                if (name === '') {
                    res.status(400).json({success: false, msg: 'name query param required'});
                    return;
                }
                const rawVersion = typeof req.query.version === 'string' ? req.query.version.trim() : '';
                const versionPattern = rawVersion === '' ? null : rawVersion;

                const perProject: ImpactProjectReport[] = [];
                const skipped: {unid: string; name: string; type: string; reason: string}[] = [];

                for (const [unid, project] of projects.entries()) {
                    try {
                        const graph = await DepGraphBuilder.build(unid, project, registry, securityCache);
                        if (!graph) {
                            skipped.push({
                                unid,
                                name: project.getName(),
                                type: project.getType(),
                                reason: 'no lockfile'
                            });
                            continue;
                        }
                        perProject.push(ImpactAnalyzer.analyzeGraph(graph, name, versionPattern));
                    } catch (e) {
                        skipped.push({
                            unid,
                            name: project.getName(),
                            type: project.getType(),
                            reason: (e as Error).message
                        });
                    }
                }

                const report: ApiImpactResponse = ImpactAnalyzer.buildReport(
                    {name, versionPattern},
                    perProject,
                    skipped
                );
                res.status(200).json(report);
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/matrix — per-project matrix with one
            // column per workspace (root first) + a Latest column from
            // the registry. Independent of the global matrix, but reuses
            // the same status semantics.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/matrix', async (req, res) => {
                const project = projects.get(req.params.id);

                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }

                try {
                    const matrix = await ProjectMatrixBuilder.build(req.params.id, project, registry);
                    res.status(200).json(matrix);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/history — append-only timeline of
            // package changes for one project. Entries are sorted newest
            // first; the auto-snapshot writer in the lockfile endpoint
            // is what populates them.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/history', async (req, res) => {
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
                        gitAvailable,
                        gitBackfilledHead: file.gitBackfilledHead ?? null
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/history/backfill — SSE. Runs the
            // same git-history reconstruction as the Vulnerability-
            // Timeline scan, but stops there (no OSV catch-up). Lets
            // the History view itself trigger a backfill — semantically
            // the right home for the action, and faster than the full
            // scan when you don't care about CVE coverage.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/history/backfill', async (req, res) => {
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

                    send('start', {gitAvailable, backfillRequired});

                    let mergedCount = 0;

                    if (backfillRequired) {
                        let result;
                        if (project instanceof ProjectLocal) {
                            result = gitBackfill.build(
                                project.getRoot(),
                                (current, total) => {
                                    if (!aborted) {
                                        send('progress', {current, total});
                                    }
                                }
                            );
                        } else if (project instanceof ProjectRemote) {
                            try {
                                result = await remoteBackfill.build(
                                    project,
                                    (current, total) => {
                                        if (!aborted) {
                                            send('progress', {current, total});
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
                        mergedCount
                    });
                } catch (e) {
                    send('error', {msg: (e as Error).message});
                } finally {
                    res.end();
                }
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/vulnerability-timeline — cache-only
            // read. Walks the project's history (git-backfilled + live
            // snapshots) and crosses it with the on-disk OSV cache to
            // produce a list of `[t_in, t_out)` exposure windows per
            // CVE. Fast — never reaches OSV. The companion `/scan`
            // SSE endpoint warms the cache + (if needed) backfills
            // from git first.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/vulnerability-timeline', async (req, res) => {
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

            // -------------------------------------------------------------
            // GET /api/projects/:id/vulnerability-timeline/scan — SSE.
            // Phase 1: walk git log for `package-lock.json`, splice
            // reconstructed entries into the history store (idempotent
            // by HEAD SHA).
            // Phase 2: dedupe every `name@version` the history mentions,
            // batch-query OSV for missing ones, write the records into
            // the OSV caches the regular endpoints already use.
            // Final event carries the freshly rebuilt timeline so the
            // frontend doesn't have to round-trip after the stream
            // closes.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/vulnerability-timeline/scan', async (req, res) => {
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
                        // Re-run the walk when HEAD moved OR when a
                        // previous run set the watermark but produced
                        // no entries (recovery from a broken earlier
                        // backfill — the user clicks the pill again
                        // expecting their history to fill in).
                        backfillRequired = backfillHead !== null
                            && (existing.gitBackfilledHead !== backfillHead
                                || existing.entries.length === 0);
                    }

                    send('start', {gitAvailable, backfillRequired});

                    if (backfillRequired) {
                        let result;
                        if (project instanceof ProjectLocal) {
                            result = gitBackfill.build(
                                project.getRoot(),
                                (current, total) => {
                                    if (!aborted) {
                                        send('progress', {current, total, phase: 'backfill'});
                                    }
                                }
                            );
                        } else if (project instanceof ProjectRemote) {
                            try {
                                result = await remoteBackfill.build(
                                    project,
                                    (current, total) => {
                                        if (!aborted) {
                                            send('progress', {current, total, phase: 'backfill'});
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
                            // Only seed `lastSnapshot` when the
                            // backfill produced resolved versions
                            // (`committed` source). Declared-range
                            // entries from the `package-json`
                            // fallback would otherwise trip a
                            // false "every dep changed" diff on
                            // the next live `recordSnapshot`.
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

                    // OSV catch-up. Walk every (name, version) the
                    // history mentions, ask the batched OSV endpoint
                    // for the unscanned ones, then refresh the
                    // single-query records for any vuln we discovered
                    // (so the timeline has `published` dates, not just
                    // IDs).
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

                    const pairs: {name: string; version: string}[] = [];
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
                    const withVulns: {name: string; version: string; vulnIds: string[]}[] = [];

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

                    // For coordinates that have vulns but no full-record
                    // cache entry yet, hit the single endpoint so the
                    // timeline gets real `published` dates. Bounded by
                    // the number of vulnerable packages (typically << all).
                    for (const v of withVulns) {
                        if (aborted) {
                            return;
                        }
                        const cached = securityCache.get<{data: unknown}>(`osv_${v.name}@${v.version}`);
                        if (cached !== null) {
                            continue;
                        }
                        try {
                            await osvClient.query(v.name, v.version);
                        } catch {
                            // best-effort — the batch IDs already let
                            // the timeline classify the vuln, just
                            // without a precise published date.
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
                    send('end', {timeline});
                } catch (e) {
                    send('error', {msg: (e as Error).message});
                } finally {
                    res.end();
                }
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/pr-review?base=&head= — diff
            // `package.json` + `package-lock.json` between two git
            // refs (default `main` vs `HEAD`), surface every changed
            // dep with its CVE delta from the cached OSV pocket. Local
            // projects only in v1 — remote would need API-driven
            // git-show.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/pr-review', async (req, res) => {
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

            // -------------------------------------------------------------
            // GET /api/projects/:id/integrity — cross-check the
            // lockfile's pinned `resolved` + `integrity` per entry
            // against what the registry currently serves. Surfaces
            // mirror-hijack / dependency-confusion / lockfile-
            // injection as risk-level findings. Works on any
            // project type — `loadLockfile()` returns null cleanly
            // for sources without one (signals via `noLockfile`).
            // -------------------------------------------------------------
            app.get('/api/projects/:id/integrity', async (req, res) => {
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
                        findings,
                        summary,
                        noLockfile: false
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/projects/:id/unused — depcheck-style hygiene scan
            // for one local project. Returns three buckets (unused /
            // misplaced / missing) plus the list of files the regex
            // scanner couldn't fully resolve (dynamic specs). Remote
            // projects respond with `supported: false` rather than a
            // 4xx, so the UI can render an info banner.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/unused', async (req, res) => {
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

            // -------------------------------------------------------------
            // GET /api/projects/:id/sbom?format=cyclonedx|spdx — emit a
            // Software Bill of Materials for one project. Walks the
            // lockfile + registry (no fingerprint downloads) and emits
            // the requested format. `format` defaults to `cyclonedx`.
            // Content-Type is `application/vnd.cyclonedx+json` or
            // `application/spdx+json` so downstream tooling can route
            // the response by MIME.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/sbom', async (req, res) => {
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

            // -------------------------------------------------------------
            // POST /api/projects/:id/upgrade/preview — plan a single
            // dep bump in one workspace's package.json. Returns the
            // before/after file contents (for the diff) plus a
            // SecurityScanner heads-up on the target version. Does
            // not write to disk. Local projects only.
            // -------------------------------------------------------------
            app.post('/api/projects/:id/upgrade/preview', async (req, res) => {
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

                    // Resolve latest from the registry so the modal can
                    // call out the concrete version even when the
                    // requested range is `^X`. Used as the SecurityScanner
                    // input too.
                    let latestResolved: string|null = null;
                    let heads = null;
                    try {
                        const pack = await registry.fetchOne(request.name);
                        latestResolved = pack?.latest ?? null;
                        if (latestResolved) {
                            heads = await securityScanner.scan(request.name, latestResolved);
                        }
                    } catch {
                        // Registry / scanner outages must not block the
                        // preview — the user still sees the planned edit
                        // and can decide.
                    }

                    const response: ApiUpgradePreviewResponse = {
                        project: {unid: req.params.id, name: project.getName()},
                        request,
                        packageJsonPath: abs,
                        packageJsonRel: rel,
                        before: result.before,
                        after: result.after,
                        latestResolvedVersion: latestResolved,
                        securityHeadsUp: heads,
                        allowInstall
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/projects/:id/upgrade/apply — write the edit to
            // disk (with a backup), then optionally stream
            // `npm install --ignore-scripts` as SSE. `mode` is either
            // `edit` (write only) or `install` (write + run). Install
            // path is gated by `actions.allowInstall` in nppm.json.
            // -------------------------------------------------------------
            app.post('/api/projects/:id/upgrade/apply', async (req, res) => {
                const project = projects.get(req.params.id);
                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }
                if (!(project instanceof ProjectLocal)) {
                    res.status(400).json({success: false, msg: 'Upgrade only supported for local projects'});
                    return;
                }

                const body = req.body as ApiUpgradeRequest & {mode?: 'edit'|'install'};
                if (!body || !body.name || !body.depType || !body.toRange) {
                    res.status(400).json({success: false, msg: 'name, depType and toRange are required'});
                    return;
                }
                const mode = body.mode === 'install' ? 'install' : 'edit';
                if (mode === 'install' && !allowInstall) {
                    res.status(403).json({success: false, msg: 'Install path disabled — set actions.allowInstall=true in nppm.json'});
                    return;
                }

                // SSE setup — the route always streams so the frontend
                // can use one consumer for both modes. Edit-only ends
                // immediately after the `edit-done` event.
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
                        onStart: (command: string, cwd: string) => send('start', {command, cwd}),
                        onStdout: (chunk: string) => send('stdout', {chunk}),
                        onStderr: (chunk: string) => send('stderr', {chunk}),
                        onEnd: (exitCode: number|null) => {
                            send('end', {exitCode});
                            res.end();
                        },
                        onError: (msg: string) => send('error', {msg})
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

            // -------------------------------------------------------------
            // GET /api/projects/:id/lifecycle-scripts — list every
            // install-time hook (`preinstall`/`install`/`postinstall`/
            // `prepare`) found across `node_modules/*` of one project.
            // Read-only; available regardless of `actions.allowInstall`
            // because the user always wants to *see* what was skipped.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/lifecycle-scripts', async (req, res) => {
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
                        allowInstall
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/projects/:id/lifecycle-scripts/run — SSE stream
            // for `npm rebuild <name>`. Gated by `actions.allowInstall`
            // because it runs third-party code on the user's machine.
            // -------------------------------------------------------------
            app.post('/api/projects/:id/lifecycle-scripts/run', async (req, res) => {
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
                    onStart: (command: string, cwd: string) => send('start', {command, cwd}),
                    onStdout: (chunk: string) => send('stdout', {chunk}),
                    onStderr: (chunk: string) => send('stderr', {chunk}),
                    onEnd: (exitCode: number|null) => {
                        send('end', {exitCode});
                        res.end();
                    },
                    onError: (msg: string) => send('error', {msg})
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

            // -------------------------------------------------------------
            // GET /api/lockfile/analyze-all — SSE stream that walks every
            // configured project's lockfile (or node_modules fallback),
            // deduplicates `name@version` across the whole set, and
            // streams CVE findings. Driven by the topbar "Alle scannen"
            // button.
            //
            // Result events include `projects: string[]` so the UI can
            // show which projects pulled in each vulnerable package.
            // -------------------------------------------------------------
            // -------------------------------------------------------------
            // GET /api/dashboard/snapshot — last persisted scan result.
            // Returned by the SSE `end` handler on every successful
            // scan; the view uses it to render an immediate first-paint
            // on open while leaving the user free to trigger a fresh
            // scan via the Re-scan button.
            //
            // Returns `{snapshot: null, timestamp: null}` when no scan
            // has run yet (first-ever view-open or after Settings → Clear
            // cache) — distinct from a 500, which is reserved for actual
            // disk errors.
            // -------------------------------------------------------------
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
            app.get('/api/dashboard/scan', async (req, res) => {
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
                            projectName
                        });

                        const cells: Partial<Record<ScannerId, DashboardCell>> = {};
                        let columnError: string|undefined;

                        const emitCell = (scanner: ScannerId, cell: DashboardCell): void => {
                            cells[scanner] = cell;
                            send('cell', {projectUnid: unid, scanner, cell});
                            cellsDone++;
                            send('progress', {
                                current: cellsDone,
                                total: totalCells,
                                projectName,
                                scanner
                            });
                        };

                        const skipColumnAsNa = (msg: string): void => {
                            columnError = msg;
                            for (const id of SCANNER_IDS) {
                                emitCell(id, DashboardBuilder.naCell(msg));
                            }
                        };

                        try {
                            const lockfile = await project.loadLockfile();
                            if (!lockfile) {
                                skipColumnAsNa('no lockfile');
                            } else {
                                // Unique package list — same dedup MatrixBuilder
                                // and the OSV-all stream apply, so the per-package
                                // batches don't redo work for hoisted duplicates.
                                const seen = new Set<string>();
                                const packages: {name: string; version: string}[] = [];
                                for (const pkg of lockfile.packages) {
                                    const key = `${pkg.name}@${pkg.version}`;
                                    if (seen.has(key)) {
                                        continue;
                                    }
                                    seen.add(key);
                                    packages.push({name: pkg.name, version: pkg.version});
                                }
                                const packageCount = packages.length;

                                // Announce the slow phase first so the
                                // progress bar already shows what's
                                // happening while the parallel batches run.
                                send('progress', {
                                    current: cellsDone,
                                    total: totalCells,
                                    projectName,
                                    scanner: 'cve' as ScannerId
                                });

                                const [osvMap, heuristics, churns] = await Promise.all([
                                    osvClient.queryBatch(packages),
                                    securityScanner.scanHeuristicsBatch(packages),
                                    securityScanner.scanChurnBatch(packages)
                                ]);

                                if (aborted) {
                                    return;
                                }

                                // Per-package scanner buckets — null entries are
                                // packages where the scanner found nothing.
                                // Findings collected in parallel so the cell payload
                                // surfaces concrete labels in the FindingsModal.
                                const perScanner: Record<string, (ReturnType<typeof DashboardBuilder.cveSeverity>)[]> = {
                                    cve: [], license: [], scripts: [], patterns: [],
                                    binaries: [], obfuscation: [], maintainer: [], churn: [], cadence: [],
                                    freshness: [], ignoreScripts: [], typosquat: [], provenance: [],
                                    external: [], deprecation: []
                                };
                                const perFindings: Record<string, CellFinding[]> = {
                                    cve: [], license: [], scripts: [], patterns: [],
                                    binaries: [], obfuscation: [], maintainer: [], churn: [], cadence: [],
                                    freshness: [], ignoreScripts: [], typosquat: [], provenance: [],
                                    external: [], deprecation: []
                                };

                                const pushFinding = (scanner: ScannerId, label: string,
                                    sev: ReturnType<typeof DashboardBuilder.cveSeverity>, detail?: string): void => {
                                    if (sev === null) {
                                        return;
                                    }
                                    perFindings[scanner].push({label, severity: sev, detail});
                                };

                                for (let i = 0; i < packages.length; i++) {
                                    const h = heuristics[i];
                                    const label = `${packages[i].name}@${packages[i].version}`;
                                    const pkgKey = label;
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

                                    // ignoreScripts is derived heuristically from the
                                    // batched scripts.maxSeverity since the batch entry
                                    // doesn't carry the IgnoreScriptsFinding directly.
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

                                // Per-package cells (12 scanners). Each one's
                                // findings list is sorted + capped inside the
                                // builder.
                                const perPackageScanners: ScannerId[] = [
                                    'cve', 'license', 'scripts', 'patterns', 'binaries', 'obfuscation',
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

                                // External-sources column: N/A when no source
                                // is configured (avoids a misleading 100/100
                                // when every flag is off). When at least one
                                // source is enabled, normal per-package
                                // scoring applies.
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

                                // Integrity — per-project, scans the lockfile.
                                send('progress', {
                                    current: cellsDone,
                                    total: totalCells,
                                    projectName,
                                    scanner: 'integrity' as ScannerId
                                });
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

                                // Unused — only on local projects; remote sources
                                // surface as N/A via the detector's `supported`
                                // flag, which `unusedCell` translates for us.
                                send('progress', {
                                    current: cellsDone,
                                    total: totalCells,
                                    projectName,
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
                                    projectName,
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
                                    const report = templateChecker.check(manifests, resolved, {projectRoot});
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
                            project: {unid, name: projectName, type: project.getType()},
                            cells,
                            ...(columnError ? {error: columnError} : {})
                        };
                        columns.push(column);
                        send('column-end', {column});
                    }

                    if (!aborted) {
                        const dashboard: ApiDashboardResponse = {
                            scanners: [...SCANNER_IDS],
                            columns
                        };
                        // Persist the result so the next view-open can
                        // render an immediate first-paint without waiting
                        // for a fresh SSE scan. Failure to write is
                        // non-fatal — the user just gets the empty state
                        // next time.
                        try {
                            if (!fs.existsSync(cacheDir)) {
                                fs.mkdirSync(cacheDir, {recursive: true});
                            }
                            const payload: ApiDashboardSnapshotResponse = {
                                snapshot: dashboard,
                                timestamp: new Date().toISOString()
                            };
                            fs.writeFileSync(dashboardSnapshotPath, JSON.stringify(payload));
                        } catch (e) {
                            console.warn(`nppm: dashboard snapshot save failed: ${(e as Error).message}`);
                        }
                        send('end', {dashboard});
                    }
                } catch (e) {
                    send('error', {msg: (e as Error).message});
                } finally {
                    res.end();
                }
            });

            app.get('/api/lockfile/analyze-all', async (_req, res) => {
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
                    // Phase 1 — collect everything. Walk each project,
                    // map `name@version` → set of project names. Emits
                    // one `progress` per project so the user sees the
                    // collection phase even before OSV runs.
                    const byKey = new Map<string, {name: string; version: string; projects: Set<string>}>();
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
                                    const key = `${pkg.name}@${pkg.version}`;
                                    let entry = byKey.get(key);
                                    if (!entry) {
                                        entry = {
                                            name: pkg.name,
                                            version: pkg.version,
                                            projects: new Set()
                                        };
                                        byKey.set(key, entry);
                                    }
                                    entry.projects.add(project.getName());
                                }
                            }
                        } catch (e) {
                            // Per-project lockfile failure is non-fatal
                            // — skip that project and keep going.
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

                    // Phase 2 — batch through OSV. Same shape as the
                    // per-project stream.
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
                                vulnIds,
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

            // -------------------------------------------------------------
            // GET /api/projects/:id/lockfile/analyze — SSE stream that
            // walks every unique (name@version) in the lockfile through
            // an OSV batch and emits one `result` event per package plus
            // a `progress` event per chunk. Used by the InstalledView
            // "Analyse starten" button.
            //
            // Event sequence: `start` (once) → repeated `result` +
            // `progress` → `end` (once) | `error`.
            // -------------------------------------------------------------
            app.get('/api/projects/:id/lockfile/analyze', async (req, res) => {
                const project = projects.get(req.params.id);

                if (!project) {
                    res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                    return;
                }

                res.set({
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    // Disable proxy/vite buffering so each event hits the
                    // browser as soon as it's written.
                    'X-Accel-Buffering': 'no'
                });
                res.flushHeaders();

                const send = (event: string, data: object): void => {
                    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                };

                let aborted = false;
                req.on('close', () => {
                    // Client closed the SSE stream — stop scheduling new
                    // chunks. We can't cancel an in-flight OSV request
                    // mid-flight, but the loop will exit on the next
                    // iteration.
                    aborted = true;
                });

                try {
                    const lockfile = await project.loadLockfile();

                    if (!lockfile) {
                        send('error', {msg: 'Kein package-lock.json in diesem Projekt.'});
                        res.end();
                        return;
                    }

                    // Dedupe — the same package can appear multiple times
                    // in nested installs (`node_modules/a/node_modules/b`)
                    // but we only need to ask OSV once per `name@version`.
                    const seen = new Set<string>();
                    const queue: {name: string; version: string}[] = [];

                    for (const p of lockfile.packages) {
                        const key = `${p.name}@${p.version}`;
                        if (seen.has(key)) {
                            continue;
                        }
                        seen.add(key);
                        queue.push({name: p.name, version: p.version});
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
                                vulnIds
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

            // -------------------------------------------------------------
            // GET /api/projects/:id/packages — full manifest list for one
            // project. 404 on unknown UUID (the frontend can then trigger
            // a resync via /api/projects).
            // -------------------------------------------------------------
            app.get('/api/projects/:id/packages', async (req, res) => {
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

            // -------------------------------------------------------------
            // GET /api/matrix — the cross-project view. Builds once per
            // request from the current on-disk manifests; registry data
            // is cached per package on disk (TTL).
            // -------------------------------------------------------------
            app.get('/api/matrix', async (_req, res) => {
                try {
                    const matrix = await MatrixBuilder.build(projects, registry);
                    res.status(200).json(matrix);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/fingerprint?name=...&version=... — per-file SHA-256
            // map of a published `pkg@version`. Tarball is fetched from the
            // npm registry and cached permanently (immutable). Name +
            // version travel as query params so scoped names (`@scope/foo`)
            // don't break Express route parsing.
            // -------------------------------------------------------------
            app.get('/api/fingerprint', async (req, res) => {
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
                    const fingerprint = await fingerprintBuilder.build(name, version);
                    const response: ApiFingerprintResponse = {fingerprint};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/matrix/security — bulk vuln-count lookup used by
            // the matrix badge. Body: `{packages: [{name, version}]}`.
            // Responds with `vulnIds` per coordinate (or `null` when OSV
            // failed for that one). Single call lets the frontend
            // populate every row badge in one round-trip.
            // -------------------------------------------------------------
            app.post('/api/matrix/security', async (req, res) => {
                const body = req.body as Partial<ApiMatrixSecurityRequest>;

                if (!body || !Array.isArray(body.packages)) {
                    res.status(400).json({
                        success: false,
                        msg: 'body must contain a `packages` array'
                    });
                    return;
                }

                const packages = body.packages.filter(
                    (p): p is {name: string; version: string} =>
                        typeof p?.name === 'string' && typeof p?.version === 'string'
                );

                try {
                    const map = await osvClient.queryBatch(packages);
                    const results = packages.map((p) => ({
                        name: p.name,
                        version: p.version,
                        vulnIds: map.get(`${p.name}@${p.version}`) ?? null
                    }));

                    const response: ApiMatrixSecurityResponse = {results};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/matrix/heuristics — bulk fingerprint-derived scan
            // (lifecycle scripts + code patterns) for the matrix badge.
            // Body: `{packages: [{name, version}]}`. Slow cold path
            // (downloads tarballs at concurrency=10); warm path hits the
            // permanent fingerprint cache and runs in milliseconds.
            // -------------------------------------------------------------
            app.post('/api/matrix/heuristics', async (req, res) => {
                const body = req.body as Partial<ApiMatrixHeuristicsRequest>;

                if (!body || !Array.isArray(body.packages)) {
                    res.status(400).json({
                        success: false,
                        msg: 'body must contain a `packages` array'
                    });
                    return;
                }

                const packages = body.packages.filter(
                    (p): p is {name: string; version: string} =>
                        typeof p?.name === 'string' && typeof p?.version === 'string'
                );

                try {
                    const results = await securityScanner.scanHeuristicsBatch(packages);
                    const response: ApiMatrixHeuristicsResponse = {results};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/matrix/bundles — bundlephobia batched lookup for
            // the matrix size column. Body: `{packages: [{name, version}]}`.
            // Permanent cache (immutable `name@version`) so warm runs
            // return instantly; cold runs queue under the fetcher's
            // concurrency cap.
            // -------------------------------------------------------------
            app.post('/api/matrix/bundles', async (req, res) => {
                const body = req.body as Partial<ApiBundlesRequest>;

                if (!body || !Array.isArray(body.packages)) {
                    res.status(400).json({
                        success: false,
                        msg: 'body must contain a `packages` array'
                    });
                    return;
                }

                const packages = body.packages.filter(
                    (p): p is {name: string; version: string} =>
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
                    const response: ApiBundlesResponse = {results};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // GET /api/matrix/integrity — cross-project integrity roll-up
            // for the global matrix badge. Runs `IntegrityScanner.scan`
            // per project lockfile, merges findings, then collapses by
            // package name to the worst severity + risk-tier count.
            // No body: the route always acts on every configured
            // project. Best-effort per project — a single lockfile read
            // error skips that project, not the whole response.
            // -------------------------------------------------------------
            app.get('/api/matrix/integrity', async (_req, res) => {
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
                            // Skip projects whose lockfile cannot be
                            // parsed — the matrix view still gets the
                            // healthy ones.
                        }
                    }

                    const aggregated = IntegrityScanner.aggregateByName(allFindings);
                    const results = Array.from(aggregated.entries()).map(([name, v]) => ({
                        name,
                        severity: v.severity,
                        riskCount: v.riskCount
                    }));
                    const response: ApiMatrixIntegrityResponse = {results};
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
            });

            // -------------------------------------------------------------
            // POST /api/matrix/upgrade/preview — Bulk-Upgrade Wizard.
            // Takes an array of picks (one per checked cross-project
            // matrix cell), plans each as a single-project upgrade
            // preview, and returns the union. Picks targeting remote
            // or unknown projects, or deps not present in the target
            // package.json, come back as `skipped` envelopes so the
            // modal can still list them.
            // -------------------------------------------------------------
            app.post('/api/matrix/upgrade/preview', async (req, res) => {
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
                        results.push({pick, skipped: 'unknown-project'});
                        continue;
                    }
                    if (!(project instanceof ProjectLocal)) {
                        results.push({pick, skipped: 'not-local'});
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
                            // PackageJsonEditor returns changed:false both
                            // when the dep is missing AND when it's already
                            // at the target. Distinguish via currentRange.
                            const current = PackageJsonEditor.currentRange(
                                result.before, pick.depType, pick.name
                            );
                            results.push({
                                pick,
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
                            // Registry / scanner outages must not block
                            // the bulk preview.
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
                            allowInstall
                        };
                        results.push({pick, preview});
                    } catch (e) {
                        results.push({pick, skipped: 'not-found', msg: (e as Error).message});
                    }
                }

                const response: ApiBulkUpgradePreviewResponse = {results, allowInstall};
                res.status(200).json(response);
            });

            // -------------------------------------------------------------
            // POST /api/matrix/upgrade/apply — SSE. Groups picks by
            // project, snapshots each project's touched files into ONE
            // backup folder, applies the edits, then (if mode=install)
            // runs `npm install --ignore-scripts` once per project,
            // sequentially. Streams events:
            //
            //   project-start  { unid, name, picks }
            //   pick-result    { unid, rel, name, changed, skipped? }
            //   start          { command, cwd }        // install only
            //   stdout|stderr  { chunk }
            //   end            { unid, exitCode }
            //   done           { totalProjects }
            // -------------------------------------------------------------
            app.post('/api/matrix/upgrade/apply', async (req, res) => {
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

                // Group by projectUnid, preserving first-seen order so
                // the UI log reads top-to-bottom by what the user picked.
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
                            send('project-skip', {unid, reason: 'unknown-project'});
                            continue;
                        }
                        if (!(project instanceof ProjectLocal)) {
                            send('project-skip', {unid, reason: 'not-local'});
                            continue;
                        }

                        send('project-start', {
                            unid,
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
                            send('backup', {unid, dir: apply.backup.dir, files: apply.backup.files});
                            for (const out of apply.results) {
                                send('pick-result', {
                                    unid,
                                    name: out.request.name,
                                    rel: out.rel,
                                    changed: out.result.changed
                                });
                            }

                            if (mode === 'install') {
                                await new Promise<void>((resolve) => {
                                    const sink = {
                                        onStart: (command: string, cwd: string) => send('start', {unid, command, cwd}),
                                        onStdout: (chunk: string) => send('stdout', {unid, chunk}),
                                        onStderr: (chunk: string) => send('stderr', {unid, chunk}),
                                        onEnd: (exitCode: number|null) => {
                                            send('end', {unid, exitCode});
                                            currentChild = null;
                                            resolve();
                                        },
                                        onError: (msg: string) => send('error', {unid, msg})
                                    };
                                    currentChild = upgrader.runInstall(sink);
                                });
                            }
                        } catch (e) {
                            send('error', {unid, msg: (e as Error).message, backupDir});
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

            // -------------------------------------------------------------
            // GET /api/releases?name=...[&version=...] — merged release
            // timeline: registry-known versions + (when github.com)
            // GitHub release titles / bodies. Newest first.
            //
            // When `version` is a git URL (`github:...`, `git+...`,
            // etc.) the registry's `name` entry is an unrelated
            // package — return an empty timeline so the UI doesn't
            // mis-attribute another author's releases to the user's
            // git dep.
            // -------------------------------------------------------------
            app.get('/api/releases', async (req, res) => {
                const name = typeof req.query.name === 'string' ? req.query.name : '';
                const version = typeof req.query.version === 'string' ? req.query.version : '';
                if (!name) {
                    res.status(400).json({success: false, msg: 'name query param is required'});
                    return;
                }
                if (version && GitResolver.isGitVersion(version)) {
                    const response: ApiReleasesResponse = {
                        name,
                        releases: []
                    };
                    res.status(200).json(response);
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

            // -------------------------------------------------------------
            // GET /api/security?name=...&version=... — OSV.dev vuln list
            // + lifecycle-script heuristic for one `pkg@version`. Same
            // query-param convention as the fingerprint routes so scoped
            // names survive.
            // -------------------------------------------------------------
            app.get('/api/security', async (req, res) => {
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

            // -------------------------------------------------------------
            // GET /api/fingerprint/diff?name=...&before=...&after=... —
            // file-level diff between two versions of the same package.
            // -------------------------------------------------------------
            app.get('/api/fingerprint/diff', async (req, res) => {
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
                        fingerprintBuilder.build(name, before),
                        fingerprintBuilder.build(name, after)
                    ]);

                    const response: ApiFingerprintDiffResponse = {
                        before: {name, version: before},
                        after: {name, version: after},
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
     * Walk a directory and produce the `ApiFsBrowseResponse` for it.
     * Hidden entries (dot-prefix) are filtered by default; symlinks
     * are followed to classify the target as dir/file; broken links
     * and other per-entry errors are swallowed so the row simply
     * disappears. Used by `GET /api/fs/browse` for the directory
     * picker; lifted out of the handler so the ENOENT-fallback can
     * reuse the same enumeration logic against the home directory.
     */
    /**
     * Validate a template-mutation body before handing it to the VTS
     * schema. The id format check + reserved-name check are easier
     * to express as code than to encode in VTS; everything else is
     * delegated to `SchemaTemplate.validate()`.
     */
    private static _validateTemplateBody(body: unknown): string|null {
        if (!body || typeof body !== 'object') {
            return 'request body required';
        }
        const id = (body as {id?: unknown}).id;
        if (typeof id !== 'string' || id.length === 0) {
            return 'id is required';
        }
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
            return `id "${id}" must be lower-case alphanumerics + hyphens (max 64 chars)`;
        }
        return null;
    }

    /**
     * Write `<dir>/<id>/template.json` with 2-space indent + trailing
     * newline. Creates the parent folder if it doesn't exist. Leaves
     * `<dir>/<id>/files/` untouched — file content is managed
     * out-of-band by the user.
     */
    private static _writeTemplate(dir: string, body: ApiTemplateMutationRequest): void {
        const tplDir = path.join(dir, body.id);
        fs.mkdirSync(tplDir, {recursive: true});
        const file = path.join(tplDir, 'template.json');
        const clean = Server._stripEmpty(body);
        fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
    }

    /**
     * Drop empty arrays / objects / undefineds from the body so the
     * on-disk template.json stays minimal. Keeps the file diff-clean
     * after edits — every save would otherwise produce noise from
     * empty-bucket scaffolding the user didn't actually fill in.
     */
    private static _stripEmpty(body: ApiTemplateMutationRequest): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) {
            if (v === undefined || v === null) {
                continue;
            }
            if (Array.isArray(v) && v.length === 0) {
                continue;
            }
            if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) {
                continue;
            }
            out[k] = v;
        }
        return out;
    }

    /**
     * Collapse a parsed `Template` into the lightweight summary the
     * Templates view + matrix consume. Counts pre-compute per-bucket
     * sizes so the UI can show "+12 runtime, +5 dev" without loading
     * the full rule body.
     */
    private static _toTemplateSummary(t: Template, loader: TemplateLoader): ApiTemplateSummary {
        const pkgs = t.packages;
        const src = loader.getSource(t.id);
        return {
            id: t.id,
            name: t.name ?? t.id,
            extends: t.extends ?? [],
            mode: (t.mode === 'strict' ? 'strict' : 'additive'),
            runtimeCount: pkgs?.runtime ? Object.keys(pkgs.runtime).length : 0,
            devCount: pkgs?.dev ? Object.keys(pkgs.dev).length : 0,
            peerCount: pkgs?.peer ? Object.keys(pkgs.peer).length : 0,
            optionalCount: pkgs?.optional ? Object.keys(pkgs.optional).length : 0,
            forbiddenCount: t.forbidden?.length ?? 0,
            hasRoot: t.root !== undefined && Object.keys(t.root).length > 0,
            source: src?.kind === 'remote' ? 'remote' : 'local',
            sourceUrl: src?.kind === 'remote' ? src.url : undefined
        };
    }

    private static async _listDirectory(absPath: string, showHidden: boolean): Promise<ApiFsBrowseResponse> {
        const dirents = await fs.promises.readdir(absPath, {withFileTypes: true});
        const entries: ApiFsBrowseEntry[] = [];
        for (const d of dirents) {
            if (!showHidden && d.name.startsWith('.')) {
                continue;
            }
            let kind: 'dir'|'file'|null = null;
            if (d.isDirectory()) {
                kind = 'dir';
            } else if (d.isFile()) {
                kind = 'file';
            } else if (d.isSymbolicLink()) {
                try {
                    const stat = await fs.promises.stat(path.join(absPath, d.name));
                    kind = stat.isDirectory() ? 'dir' : 'file';
                } catch {
                    continue;
                }
            }
            if (kind === null) {
                continue;
            }
            entries.push({name: d.name, type: kind});
        }
        entries.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'dir' ? -1 : 1;
            }
            return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
        });
        const parent = path.dirname(absPath);
        return {
            path: absPath,
            parent: parent === absPath ? null : parent,
            entries
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
        mutator: (cfg: {projects?: unknown[]} & Record<string, unknown>) => void
    ): void {
        if (!configFile) {
            throw new Error('nppm.json path not configured — cannot persist changes');
        }
        if (!fs.existsSync(configFile)) {
            throw new Error(`nppm.json not found at ${configFile}`);
        }
        const raw = fs.readFileSync(configFile, 'utf-8');
        const cfg = JSON.parse(raw) as {projects?: unknown[]} & Record<string, unknown>;
        mutator(cfg);
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    }

    /**
     * Validate a project-mutation body. Returns `null` when the
     * body is acceptable, or a human-readable error string when it
     * isn't. Each project type has its own required-field rule.
     */
    private static _validateProjectBody(body: ApiProjectMutationRequest): string|null {
        if (!body || typeof body !== 'object') {
            return 'request body required';
        }
        switch (body.type) {
            case ConfigProjectType.local:
                if (!body.path || typeof body.path !== 'string') {
                    return 'path is required for local projects';
                }
                return null;
            case ConfigProjectType.github:
                if (!body.repo || typeof body.repo !== 'string') {
                    return 'repo is required for github projects';
                }
                return null;
            case ConfigProjectType.gitea:
                if (!body.url || typeof body.url !== 'string') {
                    return 'url is required for gitea projects';
                }
                return null;
            default:
                return `unknown project type "${body.type as string}"`;
        }
    }

    /**
     * Build the JSON entry that should be appended / overwritten in
     * `nppm.json`'s `projects` array. Only the type-relevant fields
     * are kept so the on-disk shape stays clean.
     */
    private static _projectEntryFromBody(body: ApiProjectMutationRequest): Record<string, unknown> {
        const out: Record<string, unknown> = {type: body.type};
        if (body.name && body.name.length > 0) {
            out.name = body.name;
        }
        if (body.type === ConfigProjectType.local) {
            out.path = body.path;
        } else if (body.type === ConfigProjectType.github) {
            out.repo = body.repo;
            if (body.ref) {
                out.ref = body.ref;
            }
            if (body.token) {
                out.token = body.token;
            }
        } else if (body.type === ConfigProjectType.gitea) {
            out.url = body.url;
            if (body.ref) {
                out.ref = body.ref;
            }
            if (body.token) {
                out.token = body.token;
            }
        }
        if (body.hidden === true) {
            out.hidden = true;
        }
        if (Array.isArray(body.templates) && body.templates.length > 0) {
            out.templates = body.templates;
        }
        return out;
    }

    /**
     * Construct a live `Project` instance from the mutation body.
     * The shared `remoteCache` is the same one the loader hands out
     * at boot, so freshly-added remote projects warm into the same
     * cache pocket without extra plumbing.
     */
    private static _instantiateProject(
        body: ApiProjectMutationRequest,
        projectRoot: string,
        remoteCache: import('./Cache/JsonCache.js').JsonCache,
        configIndex: number
    ): import('./Project/Project.js').Project {
        const hidden = body.hidden === true;
        const templates = Array.isArray(body.templates) ? body.templates : [];
        if (body.type === ConfigProjectType.local) {
            const absRoot = path.resolve(projectRoot, body.path!);
            return new ProjectLocal(absRoot, body.name, {hidden, configIndex, templates});
        }
        if (body.type === ConfigProjectType.github) {
            return new ProjectGithub(
                body.repo!,
                body.name ?? body.repo!,
                body.ref,
                ConfigLoader.expandEnv(body.token),
                remoteCache,
                {hidden, configIndex, templates}
            );
        }
        return new ProjectGitea(
            body.url!,
            body.name ?? body.url!,
            body.ref,
            ConfigLoader.expandEnv(body.token),
            remoteCache,
            {hidden, configIndex, templates}
        );
    }

    /**
     * Build the `ApiProject` summary for one fresh / edited project
     * — mirrors what `GET /api/projects` would return for that
     * single entry. Pulls `packageCount` + `workspaceCount` via the
     * same `loadManifests` path so the frontend's treeview row
     * renders with real numbers immediately.
     */
    private static async _toApiProject(
        unid: string,
        project: import('./Project/Project.js').Project
    ): Promise<ApiProject> {
        const root = project instanceof ProjectLocal ? project.getRoot() : undefined;
        try {
            const manifests = await project.loadManifests();
            const total = manifests.reduce((sum, m) => sum + m.dependencies.length, 0);
            return {
                unid,
                name: project.getName(),
                type: project.getType(),
                packageCount: total,
                workspaceCount: manifests.length - 1,
                root,
                hidden: project.isHidden()
            };
        } catch (e) {
            return {
                unid,
                name: project.getName(),
                type: project.getType(),
                packageCount: 0,
                workspaceCount: 0,
                root,
                hidden: project.isHidden(),
                error: (e as Error).message
            };
        }
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