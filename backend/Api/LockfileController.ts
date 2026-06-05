import {ApiLockfileResponse} from '../../shared/Api/ApiTypes.js';
import {DepGraphBuilder} from '../DepGraph/DepGraphBuilder.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {ServerContext} from './ServerContext.js';

/**
 * Lockfile-backed read + analyze routes for a single project plus the
 * cross-project OSV sweep. Three shapes live here:
 *
 *  - GET /api/projects/:id/lockfile — parsed lockfile (or
 *    `lockfile: null` for a project without one). Auto-snapshots the
 *    package set into `HistoryStore` so the History view stays fresh
 *    on every read; snapshot failures are logged, never propagated.
 *  - GET /api/projects/:id/depgraph — flat resolved graph for the
 *    D3 tree view. Pulls `latest` + cached CVE counts from the
 *    existing pockets, no extra network.
 *  - GET /api/projects/:id/lockfile/analyze (SSE) — per-project
 *    OSV batch. Emits `start` → repeated `result`+`progress` → `end`.
 *  - GET /api/lockfile/analyze-all (SSE) — same shape but dedupes
 *    `name@version` across every configured project, then attaches
 *    `projects: string[]` to each `result` so the UI knows who pulled
 *    the vulnerable coordinate in.
 *
 * Git-sourced deps are queried under their resolved URL so OSV / the
 * registry never get asked about a same-named public package — see
 * the `useGitUrl` branches below.
 */
export class LockfileController {

    public static register(ctx: ServerContext): void {
        LockfileController._registerLockfile(ctx);
        LockfileController._registerDepGraph(ctx);
        LockfileController._registerAnalyze(ctx);
        LockfileController._registerAnalyzeAll(ctx);
    }

    private static _registerLockfile(ctx: ServerContext): void {
        const {securityCache} = ctx.loaded;

        ctx.app.get('/api/projects/:id/lockfile', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
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
                        ctx.historyStore.recordSnapshot(
                            project.getKey(),
                            project.getName(),
                            lockfile.source,
                            lockfile.packages.map((p) => ({name: p.name, version: p.version})),
                            {
                                cvesForOldVersion: (name, version): string[]|null => {
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
    }

    private static _registerDepGraph(ctx: ServerContext): void {
        const {registry, securityCache} = ctx.loaded;

        ctx.app.get('/api/projects/:id/depgraph', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
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
    }

    private static _registerAnalyze(ctx: ServerContext): void {
        const {osvClient} = ctx.loaded;

        ctx.app.get('/api/projects/:id/lockfile/analyze', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
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
            req.on('close', (): void => {
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
                    // eslint-disable-next-line no-await-in-loop
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
    }

    private static _registerAnalyzeAll(ctx: ServerContext): void {
        const {osvClient} = ctx.loaded;

        ctx.app.get('/api/lockfile/analyze-all', async(req, res): Promise<void> => {
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
            req.on('close', (): void => {
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
                const projectList = Array.from(ctx.projects.values());

                let collected = 0;
                for (const project of projectList) {
                    if (aborted) {
                        return;
                    }

                    try {
                        // eslint-disable-next-line no-await-in-loop
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
                    // eslint-disable-next-line no-await-in-loop
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
    }

}