import {SchemaErrors} from 'vts';
import {
    ApiLifecycleRunRequest,
    ApiLifecycleScriptsResponse,
    ApiUpgradePreviewResponse,
    ApiUpgradeRequest
} from '../../shared/Api/ApiTypes.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {LifecycleScriptScanner} from '../Upgrade/LifecycleScriptScanner.js';
import {Upgrader} from '../Upgrade/Upgrader.js';
import {SchemaApiLifecycleRunRequest, SchemaApiUpgradeRequest} from './Schemas/SchemaApiUpgrade.js';
import {ServerContext} from './ServerContext.js';

/**
 * Per-project upgrade pipeline: dry-run preview, write-with-backup
 * apply (optionally followed by `npm install --ignore-scripts`),
 * lifecycle-script discovery, and the per-package `npm rebuild`
 * runner. The two SSE-streaming routes share one event-writer helper
 * so the wire shape stays uniform across edit / install / rebuild.
 *
 * Local projects only — remote sources don't expose a writable disk
 * root. The install + rebuild paths are additionally gated behind
 * `ctx.loaded.allowInstall` because they run third-party code.
 */
export class UpgradeController {

    public static register(ctx: ServerContext): void {
        UpgradeController._registerPreview(ctx);
        UpgradeController._registerApply(ctx);
        UpgradeController._registerLifecycleList(ctx);
        UpgradeController._registerLifecycleRun(ctx);
    }

    private static _registerPreview(ctx: ServerContext): void {
        ctx.app.post('/api/projects/:id/upgrade/preview', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            if (!(project instanceof ProjectLocal)) {
                res.status(400).json({success: false, msg: 'Upgrade only supported for local projects'});
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaApiUpgradeRequest.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: `invalid request body: ${JSON.stringify(errors)}`});
                return;
            }
            const request = req.body as ApiUpgradeRequest;
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
                    const pack = await ctx.loaded.registry.fetchOne(request.name);
                    latestResolved = pack?.latest ?? null;
                    if (latestResolved) {
                        heads = await ctx.loaded.securityScanner.scan(request.name, latestResolved);
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
                    allowInstall: ctx.loaded.allowInstall
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerApply(ctx: ServerContext): void {
        ctx.app.post('/api/projects/:id/upgrade/apply', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            if (!(project instanceof ProjectLocal)) {
                res.status(400).json({success: false, msg: 'Upgrade only supported for local projects'});
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaApiUpgradeRequest.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: `invalid request body: ${JSON.stringify(errors)}`});
                return;
            }
            const body = req.body as ApiUpgradeRequest & {mode?: 'edit'|'install';};
            const mode = body.mode === 'install' ? 'install' : 'edit';
            if (mode === 'install' && !ctx.loaded.allowInstall) {
                res.status(403).json({
                    success: false,
                    msg: 'Install path disabled — set actions.allowInstall=true in nppm.json'
                });
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
                    onStart: (command: string, cwd: string): void => send('start', {command: command, cwd: cwd}),
                    onStdout: (chunk: string): void => send('stdout', {chunk: chunk}),
                    onStderr: (chunk: string): void => send('stderr', {chunk: chunk}),
                    onEnd: (exitCode: number|null): void => {
                        send('end', {exitCode: exitCode});
                        res.end();
                    },
                    onError: (msg: string): void => send('error', {msg: msg})
                };

                const child = upgrader.runInstall(sink);
                req.on('close', (): void => {
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
    }

    private static _registerLifecycleList(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/lifecycle-scripts', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
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
                    allowInstall: ctx.loaded.allowInstall
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerLifecycleRun(ctx: ServerContext): void {
        ctx.app.post('/api/projects/:id/lifecycle-scripts/run', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            if (!(project instanceof ProjectLocal)) {
                res.status(400).json({success: false, msg: 'Lifecycle scripts only supported for local projects'});
                return;
            }
            if (!ctx.loaded.allowInstall) {
                res.status(403).json({
                    success: false,
                    msg: 'Lifecycle script execution disabled — set actions.allowInstall=true in nppm.json'
                });
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaApiLifecycleRunRequest.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: `invalid request body: ${JSON.stringify(errors)}`});
                return;
            }
            const body = req.body as ApiLifecycleRunRequest;

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
                onStart: (command: string, cwd: string): void => send('start', {command: command, cwd: cwd}),
                onStdout: (chunk: string): void => send('stdout', {chunk: chunk}),
                onStderr: (chunk: string): void => send('stderr', {chunk: chunk}),
                onEnd: (exitCode: number|null): void => {
                    send('end', {exitCode: exitCode});
                    res.end();
                },
                onError: (msg: string): void => send('error', {msg: msg})
            };

            const child = upgrader.runRebuild(body.name, sink);
            req.on('close', (): void => {
                try {
                    child.kill();
                } catch {
                    // already exited
                }
            });
        });
    }
}