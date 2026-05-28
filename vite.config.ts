import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {defineConfig, Plugin} from 'vite';
import {SchemaErrors} from 'vts';
import {
    ApiFingerprintDiffResponse,
    ApiFingerprintResponse,
    ApiHistoryResponse,
    ApiLockfileResponse,
    ApiManifest,
    ApiMatrixHeuristicsRequest,
    ApiMatrixHeuristicsResponse,
    ApiMatrixSecurityRequest,
    ApiMatrixSecurityResponse,
    ApiPackagesResponse,
    ApiProject,
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
import {HistoryStore} from './History/HistoryStore.js';
import {DepGraphBuilder} from './DepGraph/DepGraphBuilder.js';
import {MatrixBuilder} from './Matrix/MatrixBuilder.js';
import {ProjectMatrixBuilder} from './Matrix/ProjectMatrixBuilder.js';
import {Project} from './Project/Project.js';
import {ReleasesFetcher} from './Releases/ReleasesFetcher.js';
import {CycloneDxBuilder} from './Sbom/CycloneDxBuilder.js';
import {SbomCollector} from './Sbom/SbomCollector.js';
import {SpdxBuilder} from './Sbom/SpdxBuilder.js';
import {LifecycleScriptScanner} from './Upgrade/LifecycleScriptScanner.js';
import {Upgrader} from './Upgrade/Upgrader.js';
import {ProjectLocal} from './Project/ProjectLocal.js';

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
                fingerprintBuilder,
                osvClient,
                securityCache,
                securityScanner,
                unusedDetector,
                allowInstall
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

            // -------------------------------------------------------------
            // GET /api/projects — one row per configured project, with a
            // best-effort packageCount so the treeview can show a hint
            // without fetching the full package list.
            // -------------------------------------------------------------
            app.get('/api/projects', async (_req, res) => {
                const result: ApiProject[] = [];

                for (const [unid, project] of projects.entries()) {
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
                            workspaceCount: manifests.length - 1
                        });
                    } catch (e) {
                        result.push({
                            unid,
                            name: project.getName(),
                            type: project.getType(),
                            packageCount: 0,
                            workspaceCount: 0,
                            error: (e as Error).message
                        });
                    }
                }

                const response: ApiProjectsResponse = {projects: result};
                res.status(200).json(response);
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
                    const response: ApiHistoryResponse = {
                        project: {
                            unid: req.params.id,
                            name: project.getName(),
                            type: project.getType()
                        },
                        entries: [...file.entries].reverse()
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
            // GET /api/releases?name=... — merged release timeline:
            // registry-known versions + (when github.com) GitHub
            // release titles / bodies. Newest first.
            // -------------------------------------------------------------
            app.get('/api/releases', async (req, res) => {
                const name = typeof req.query.name === 'string' ? req.query.name : '';
                if (!name) {
                    res.status(400).json({success: false, msg: 'name query param is required'});
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

}

export default defineConfig({
    plugins: [Server.plugin()]
});