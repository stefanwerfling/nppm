import {ApiHistoryResponse} from '../../shared/Api/ApiTypes.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {ProjectRemote} from '../Project/ProjectRemote.js';
import {ServerContext} from './ServerContext.js';

/**
 * Append-only per-project change log. The cache-only read route
 * returns whatever the `HistoryStore` has on disk; the SSE backfill
 * route walks `git log -- package-lock.json` (or the remote-host
 * commits API) to reconstruct entries that pre-date nppm. The
 * Vulnerability scan endpoint runs the same backfill + an OSV
 * catch-up on top.
 */
export class HistoryController {

    public static register(ctx: ServerContext): void {
        HistoryController._registerRead(ctx);
        HistoryController._registerBackfill(ctx);
    }

    private static _registerRead(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/history', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const file = ctx.historyStore.read(project.getKey(), project.getName());
                const gitAvailable = project instanceof ProjectLocal
                    && ctx.gitBackfill.isAvailable(project.getRoot())
                    || project instanceof ProjectRemote
                    && ctx.remoteBackfill.isAvailable(project);
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
    }

    private static _registerBackfill(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/history/backfill', async(req, res): Promise<void> => {
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
                aborted = true;
            });

            try {
                const localAvailable = project instanceof ProjectLocal
                    && ctx.gitBackfill.isAvailable(project.getRoot());
                const remoteAvailable = project instanceof ProjectRemote
                    && ctx.remoteBackfill.isAvailable(project);
                const gitAvailable = localAvailable || remoteAvailable;

                let backfillHead: string|null = null;
                if (localAvailable && project instanceof ProjectLocal) {
                    backfillHead = ctx.gitBackfill.headSha(project.getRoot());
                } else if (remoteAvailable && project instanceof ProjectRemote) {
                    backfillHead = await ctx.remoteBackfill.headSha(project);
                }

                const existing = ctx.historyStore.read(project.getKey(), project.getName());
                const backfillRequired = gitAvailable
                    && backfillHead !== null
                    && (existing.gitBackfilledHead !== backfillHead
                        || existing.entries.length === 0);

                send('start', {gitAvailable: gitAvailable, backfillRequired: backfillRequired});

                let mergedCount = 0;

                if (backfillRequired) {
                    let result;
                    if (project instanceof ProjectLocal) {
                        result = ctx.gitBackfill.build(
                            project.getRoot(),
                            (current, total): void => {
                                if (!aborted) {
                                    send('progress', {current: current, total: total});
                                }
                            }
                        );
                    } else if (project instanceof ProjectRemote) {
                        try {
                            result = await ctx.remoteBackfill.build(
                                project,
                                (current, total): void => {
                                    if (!aborted) {
                                        send('progress', {current: current, total: total});
                                    }
                                }
                            );
                        } catch (e) {
                            send('error', {msg: `Remote backfill failed: ${(e as Error).message}`});
                            res.end();
                            return;
                        }
                    }

                    if (aborted || !result) {
                        return;
                    }

                    const summary = ctx.historyStore.backfillFromGit(
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

                const finalState = ctx.historyStore.read(project.getKey(), project.getName());
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
    }
}