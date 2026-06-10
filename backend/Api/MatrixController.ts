import {SchemaErrors} from 'vts';
import {
    ApiBulkUpgradeApplyRequest,
    ApiBulkUpgradePick,
    ApiBulkUpgradePreviewRequest,
    ApiBulkUpgradePreviewResponse,
    ApiBulkUpgradePreviewResult,
    ApiBundlesRequest,
    ApiBundlesResponse,
    ApiMatrixHeuristicsRequest,
    ApiMatrixHeuristicsResponse,
    ApiMatrixIntegrityResponse,
    ApiMatrixSecurityRequest,
    ApiMatrixSecurityResponse,
    ApiUpgradePreviewResponse,
    ApiUpgradeRequest
} from '../../shared/Api/ApiTypes.js';
import {MatrixBuilder} from '../Matrix/MatrixBuilder.js';
import {ProjectMatrixBuilder} from '../Matrix/ProjectMatrixBuilder.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {IntegrityScanner} from '../Security/IntegrityScanner.js';
import {PackageJsonEditor} from '../Upgrade/PackageJsonEditor.js';
import {Upgrader} from '../Upgrade/Upgrader.js';
import {
    SchemaApiBulkUpgradeRequest,
    SchemaApiMatrixBatchRequest
} from './Schemas/SchemaApiMatrix.js';
import {ServerContext} from './ServerContext.js';

/**
 * Cross-project matrix endpoints + the per-project sibling. Lives in
 * one Controller so all matrix-shaped logic (row × column build,
 * batched badge lookups, bulk upgrade wizard) stays co-located.
 *
 * Route map:
 *   GET  /api/projects/:id/matrix      — per-project (workspaces × deps)
 *   GET  /api/matrix                   — cross-project (projects × deps)
 *   POST /api/matrix/security          — OSV vuln-id batch
 *   POST /api/matrix/heuristics        — lifecycle + pattern batch
 *   POST /api/matrix/bundles           — bundlephobia size batch
 *   GET  /api/matrix/integrity         — cross-project IntegrityScanner roll-up
 *   POST /api/matrix/upgrade/preview   — Bulk-Upgrade Wizard preview
 *   POST /api/matrix/upgrade/apply     — Bulk-Upgrade Wizard SSE apply
 *
 * The three POST batches share `SchemaApiMatrixBatchRequest` because
 * they all consume `{packages: [{name, version}]}`.
 */
export class MatrixController {

    public static register(ctx: ServerContext): void {
        MatrixController._registerProjectMatrix(ctx);
        MatrixController._registerGlobalMatrix(ctx);
        MatrixController._registerSecurity(ctx);
        MatrixController._registerHeuristics(ctx);
        MatrixController._registerBundles(ctx);
        MatrixController._registerIntegrity(ctx);
        MatrixController._registerBulkPreview(ctx);
        MatrixController._registerBulkApply(ctx);
    }

    private static _registerProjectMatrix(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/matrix', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const matrix = await ProjectMatrixBuilder.build(
                    req.params.id,
                    project,
                    ctx.loaded.registry,
                    ctx.gitHeadFetcher,
                    {
                        catalogue: ctx.refreshTemplates(),
                        filesDirFor: (id): string => ctx.templateLoader.getFilesDir(id)
                    }
                );
                res.status(200).json(matrix);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerGlobalMatrix(ctx: ServerContext): void {
        ctx.app.get('/api/matrix', async(_req, res): Promise<void> => {
            try {
                const matrix = await MatrixBuilder.build(
                    ctx.projects,
                    ctx.loaded.registry,
                    ctx.gitHeadFetcher,
                    {
                        catalogue: ctx.refreshTemplates(),
                        filesDirFor: (id): string => ctx.templateLoader.getFilesDir(id)
                    }
                );
                res.status(200).json(matrix);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerSecurity(ctx: ServerContext): void {
        ctx.app.post('/api/matrix/security', async(req, res): Promise<void> => {
            const errors: SchemaErrors = [];
            if (!SchemaApiMatrixBatchRequest.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: 'body must contain a `packages` array'});
                return;
            }
            const packages = (req.body as ApiMatrixSecurityRequest).packages;
            try {
                const map = await ctx.loaded.osvClient.queryBatch(packages);
                const ignoredFindings = ctx.getIgnoredFindings();
                const results = packages.map((p) => {
                    const ids = map.get(`${p.name}@${p.version}`) ?? null;
                    const kept = ids === null
                        ? null
                        : ids.filter((id) => !ignoredFindings.matches(p.name, p.version, 'cve', id));
                    return {
                        name: p.name,
                        version: p.version,
                        vulnIds: kept
                    };
                });
                const response: ApiMatrixSecurityResponse = {results: results};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerHeuristics(ctx: ServerContext): void {
        ctx.app.post('/api/matrix/heuristics', async(req, res): Promise<void> => {
            const errors: SchemaErrors = [];
            if (!SchemaApiMatrixBatchRequest.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: 'body must contain a `packages` array'});
                return;
            }
            const packages = (req.body as ApiMatrixHeuristicsRequest).packages;
            try {
                const raw = await ctx.loaded.securityScanner.scanHeuristicsBatch(packages);
                const ignoredFindings = ctx.getIgnoredFindings();
                const results = raw.map((e) => ignoredFindings.applyToBatchEntry(e));
                const response: ApiMatrixHeuristicsResponse = {results: results};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerBundles(ctx: ServerContext): void {
        ctx.app.post('/api/matrix/bundles', async(req, res): Promise<void> => {
            const errors: SchemaErrors = [];
            if (!SchemaApiMatrixBatchRequest.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: 'body must contain a `packages` array'});
                return;
            }
            const packages = (req.body as ApiBundlesRequest).packages;
            try {
                const map = await ctx.loaded.bundlephobiaFetcher.fetchMany(packages);
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
    }

    private static _registerIntegrity(ctx: ServerContext): void {
        ctx.app.get('/api/matrix/integrity', async(_req, res): Promise<void> => {
            try {
                const allFindings = [];
                for (const project of ctx.projects.values()) {
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        const lockfile = await project.loadLockfile();
                        if (!lockfile) {
                            continue;
                        }
                        // eslint-disable-next-line no-await-in-loop
                        const findings = await ctx.integrityScanner.scan(lockfile.packages);
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
    }

    private static _registerBulkPreview(ctx: ServerContext): void {
        ctx.app.post('/api/matrix/upgrade/preview', async(req, res): Promise<void> => {
            const errors: SchemaErrors = [];
            if (!SchemaApiBulkUpgradeRequest.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: 'body must contain a `picks` array'});
                return;
            }
            const picks = (req.body as ApiBulkUpgradePreviewRequest).picks;
            const results: ApiBulkUpgradePreviewResult[] = [];

            for (const pick of picks) {
                const project = ctx.getProject(pick.projectUnid);
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
                        // eslint-disable-next-line no-await-in-loop
                        const pack = await ctx.loaded.registry.fetchOne(pick.name);
                        latestResolved = pack?.latest ?? null;
                        if (latestResolved) {
                            // eslint-disable-next-line no-await-in-loop
                            heads = await ctx.loaded.securityScanner.scan(pick.name, latestResolved);
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
                        allowInstall: ctx.loaded.allowInstall
                    };
                    results.push({pick: pick, preview: preview});
                } catch (e) {
                    results.push({pick: pick, skipped: 'not-found', msg: (e as Error).message});
                }
            }

            const response: ApiBulkUpgradePreviewResponse = {
                results: results,
                allowInstall: ctx.loaded.allowInstall
            };
            res.status(200).json(response);
        });
    }

    private static _registerBulkApply(ctx: ServerContext): void {
        ctx.app.post('/api/matrix/upgrade/apply', async(req, res): Promise<void> => {
            const errors: SchemaErrors = [];
            if (!SchemaApiBulkUpgradeRequest.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: 'body must contain a `picks` array'});
                return;
            }
            const body = req.body as ApiBulkUpgradeApplyRequest;
            const mode = body.mode === 'install' ? 'install' : 'edit';
            if (mode === 'install' && !ctx.loaded.allowInstall) {
                res.status(403).json({
                    success: false,
                    msg: 'Install path disabled — set actions.allowInstall=true in nppm.json'
                });
                return;
            }
            const picks = body.picks;

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
            req.on('close', (): void => {
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
                    const project = ctx.getProject(unid);
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
                            /*
                             * Sequential per-project install run — the
                             * outer-scope `currentChild` reference is
                             * intentional so the SSE close hook can
                             * kill whichever child is live.
                             */
                            // eslint-disable-next-line no-await-in-loop, no-loop-func
                            await new Promise<void>((resolve) => {
                                const sink = {
                                    onStart: (command: string, cwd: string): void => send('start', {unid: unid, command: command, cwd: cwd}),
                                    onStdout: (chunk: string): void => send('stdout', {unid: unid, chunk: chunk}),
                                    onStderr: (chunk: string): void => send('stderr', {unid: unid, chunk: chunk}),
                                    onEnd: (exitCode: number|null): void => {
                                        send('end', {unid: unid, exitCode: exitCode});
                                        currentChild = null;
                                        resolve();
                                    },
                                    onError: (msg: string): void => send('error', {unid: unid, msg: msg})
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
    }

}