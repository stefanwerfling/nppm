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
    ApiSecurityResponse
} from './Api/ApiTypes.js';
import {JsonCache} from './Cache/JsonCache.js';
import {ConfigProjectType, SchemaConfig} from './Config/Config.js';
import {FingerprintBuilder} from './Fingerprint/FingerprintBuilder.js';
import {diffFingerprints} from './Fingerprint/FingerprintDiff.js';
import {HistoryStore} from './History/HistoryStore.js';
import {buildDepGraph} from './DepGraph/DepGraphBuilder.js';
import {buildMatrix} from './Matrix/MatrixBuilder.js';
import {buildProjectMatrix} from './Matrix/ProjectMatrixBuilder.js';
import {Project} from './Project/Project.js';
import {ProjectGitea} from './Project/ProjectGitea.js';
import {ProjectGithub} from './Project/ProjectGithub.js';
import {ProjectLocal} from './Project/ProjectLocal.js';
import {Registry} from './Registry/Registry.js';
import {ReleasesFetcher} from './Releases/ReleasesFetcher.js';
import {LicenseSeverity} from './Security/LicenseScanner.js';
import {OsvClient} from './Security/OsvClient.js';
import {SecurityScanner} from './Security/SecurityScanner.js';

/**
 * Resolve a `"$VARNAME"` string into the corresponding env-var value;
 * pass anything else through unchanged. Used for token fields so the
 * config file never contains literal secrets.
 */
function expandEnv(value: string|undefined): string|undefined {
    if (!value) {
        return value;
    }

    const match = /^\$([A-Z_][A-Z0-9_]*)$/i.exec(value);
    if (!match) {
        return value;
    }

    return process.env[match[1]];
}

/**
 * Express middleware mounted on the Vite dev server. Mirrors the
 * vtseditor architecture: backend lives here, frontend is everything
 * Vite serves from this same root.
 */
function expressMiddleware(): Plugin {
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

            // Registry + cache defaults; overridden by nppm.json sections
            // below.
            let registryUrl = 'https://registry.npmjs.org';
            let registryAuth: string|undefined;
            let cacheDir = path.resolve(projectRoot, '.nppm-cache');
            let cacheTtlMinutes = 60;
            let maintainerOpts: {
                quickHandoverDays?: number;
                suspiciousGapDays?: number;
                matureVersions?: number;
                trustWindow?: number;
            } = {};
            let licenseOpts: {
                allowlist?: string[];
                denylist?: string[];
                treatUnknownAs?: string;
            } = {};

            // Two-pass: first parse the config to fix cache/registry
            // settings, then build cache instances, then construct
            // projects (some of which need the remote cache).
            let rawProjects: unknown[] = [];

            if (configFile && fs.existsSync(configFile)) {
                const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
                const errors: SchemaErrors = [];

                if (!SchemaConfig.validate(raw, errors)) {
                    console.log('nppm.json has an incorrect structure:');
                    console.log(errors);
                } else {
                    if (raw.registry) {
                        registryUrl = raw.registry.url ?? registryUrl;
                        registryAuth = raw.registry.auth;
                    }

                    if (raw.cache) {
                        if (raw.cache.dir) {
                            cacheDir = path.resolve(projectRoot, raw.cache.dir);
                        }
                        if (typeof raw.cache.ttlMinutes === 'number') {
                            cacheTtlMinutes = raw.cache.ttlMinutes;
                        }
                    }

                    if (raw.security?.maintainer) {
                        maintainerOpts = raw.security.maintainer;
                    }

                    if (raw.security?.license) {
                        licenseOpts = raw.security.license;
                    }

                    rawProjects = raw.projects;
                }
            }

            const registryCache = new JsonCache(path.join(cacheDir, 'registry'), cacheTtlMinutes);
            const registry = new Registry(registryUrl, registryCache, registryAuth);

            // Remote project files (GitHub/Gitea contents API) get a
            // dedicated cache pocket. Same TTL for now.
            const remoteCache = new JsonCache(path.join(cacheDir, 'remote'), cacheTtlMinutes);

            // Tarball fingerprints are *permanent*: a published
            // `pkg@version` is immutable on npm, so the cached fingerprint
            // never goes stale. The TTL on the constructor is ignored.
            const fingerprintCache = new JsonCache(
                path.join(cacheDir, 'fingerprint'),
                cacheTtlMinutes,
                {permanent: true}
            );
            const fingerprintBuilder = new FingerprintBuilder(fingerprintCache);

            // OSV results are *not* permanent — a new CVE can be filed
            // against an old version any time. Plain TTL cache.
            const securityCache = new JsonCache(path.join(cacheDir, 'security'), cacheTtlMinutes);
            const osvClient = new OsvClient(securityCache);
            // `treatUnknownAs` arrives as a free-form string from the
            // config (VTS schema can't constrain it to enum values
            // without adding a custom validator), so validate against
            // the enum here. Unknown values fall back to the scanner
            // default by staying `undefined`.
            const treatUnknownAsRaw = licenseOpts.treatUnknownAs;
            const treatUnknownAs = Object.values(LicenseSeverity)
                .includes(treatUnknownAsRaw as LicenseSeverity)
                ? treatUnknownAsRaw as LicenseSeverity
                : undefined;

            const securityScanner = new SecurityScanner(
                osvClient,
                fingerprintBuilder,
                registry,
                {
                    maintainer: maintainerOpts,
                    license: {
                        allowlist: licenseOpts.allowlist,
                        denylist: licenseOpts.denylist,
                        treatUnknownAs
                    }
                }
            );

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

            for (const entry of rawProjects as Array<{type: ConfigProjectType}>) {
                // VTS `Vts.or` does not yield a discriminated union in
                // TS — branch by type and cast inside.
                if (entry.type === ConfigProjectType.local) {
                    const local = entry as {type: ConfigProjectType.local; path: string; name?: string};
                    const absRoot = path.resolve(projectRoot, local.path);
                    const project = new ProjectLocal(absRoot, local.name);

                    projects.set(crypto.randomUUID(), project);
                    console.log(`📦 ${project.getName()} (local) — ${absRoot}`);
                } else if (entry.type === ConfigProjectType.github) {
                    const gh = entry as {
                        type: ConfigProjectType.github;
                        repo: string;
                        name?: string;
                        ref?: string;
                        token?: string;
                    };
                    const project = new ProjectGithub(
                        gh.repo,
                        gh.name ?? gh.repo,
                        gh.ref,
                        expandEnv(gh.token),
                        remoteCache
                    );

                    projects.set(crypto.randomUUID(), project);
                    console.log(`📦 ${project.getName()} (github:${gh.repo}${gh.ref ? '@' + gh.ref : ''})`);
                } else if (entry.type === ConfigProjectType.gitea) {
                    const ge = entry as {
                        type: ConfigProjectType.gitea;
                        url: string;
                        name?: string;
                        ref?: string;
                        token?: string;
                    };

                    try {
                        const project = new ProjectGitea(
                            ge.url,
                            ge.name ?? ge.url,
                            ge.ref,
                            expandEnv(ge.token),
                            remoteCache
                        );

                        projects.set(crypto.randomUUID(), project);
                        console.log(`📦 ${project.getName()} (gitea:${ge.url}${ge.ref ? '@' + ge.ref : ''})`);
                    } catch (e) {
                        console.warn(`nppm: gitea project skipped — ${(e as Error).message}`);
                    }
                }
            }

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
                    const graph = await buildDepGraph(req.params.id, project, registry, securityCache);
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
                    const matrix = await buildProjectMatrix(req.params.id, project, registry);
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
                            phase: `Sammle Pakete (${collected}/${projectList.length} Projekte)`
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
                            phase: 'Prüfe CVEs'
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
                    const matrix = await buildMatrix(projects, registry);
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
                        diff: fpBefore && fpAfter ? diffFingerprints(fpBefore, fpAfter) : null
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

export default defineConfig({
    plugins: [expressMiddleware()]
});