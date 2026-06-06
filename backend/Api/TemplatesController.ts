import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {
    ApiAddTemplateSourceRequest,
    ApiAddTemplateSourceResponse,
    ApiComplianceApplyEndEvent,
    ApiComplianceApplyProgressEvent,
    ApiComplianceApplyRequest,
    ApiComplianceApplyStartEvent,
    ApiComplianceResponse,
    ApiTemplateDeleteResponse,
    ApiTemplateMutationRequest,
    ApiTemplateMutationResponse,
    ApiTemplateSummary,
    ApiTemplatesMatrixCell,
    ApiTemplatesMatrixResponse,
    ApiTemplatesMatrixRow,
    ApiTemplatesResponse
} from '../../shared/Api/ApiTypes.js';
import {NppmDirs} from '../Config/NppmDirs.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {BackupStore} from '../Upgrade/BackupStore.js';
import {SchemaTemplate, Template} from '../Templates/Template.js';
import {TemplateApplier} from '../Templates/TemplateApplier.js';
import {TemplateLoader} from '../Templates/TemplateLoader.js';
import {TemplateResolver} from '../Templates/TemplateResolver.js';
import {SchemaApiAddTemplateSource, SchemaApiComplianceApply} from './Schemas/SchemaApiTemplates.js';
import {ServerContext} from './ServerContext.js';

/**
 * Template-catalogue CRUD plus the per-project compliance check /
 * apply flow + the cross-project compliance matrix. Reuses
 * `ctx.templateLoader` so a freshly-edited local template is picked up
 * on the next read — every handler starts with a `ctx.refreshTemplates()`
 * round-trip.
 *
 * Remote templates are read-only: the CRUD endpoints (PUT / DELETE)
 * refuse with 403 when the targeted id was loaded from a remote source.
 */
export class TemplatesController {

    public static register(ctx: ServerContext): void {
        TemplatesController._registerList(ctx);
        TemplatesController._registerGetOne(ctx);
        TemplatesController._registerCreate(ctx);
        TemplatesController._registerUpdate(ctx);
        TemplatesController._registerDelete(ctx);
        TemplatesController._registerAddSource(ctx);
        TemplatesController._registerCompliance(ctx);
        TemplatesController._registerComplianceApply(ctx);
        TemplatesController._registerMatrix(ctx);
    }

    private static _registerList(ctx: ServerContext): void {
        ctx.app.get('/api/templates', async(_req, res): Promise<void> => {
            const templates = ctx.refreshTemplates();
            const response: ApiTemplatesResponse = {
                templates: [...templates.values()].map(
                    (t): ApiTemplateSummary => TemplatesController._toTemplateSummary(t, ctx.templateLoader)
                )
            };
            res.status(200).json(response);
        });
    }

    private static _registerGetOne(ctx: ServerContext): void {
        ctx.app.get('/api/templates/:id', async(req, res, next): Promise<void> => {
            /*
             * `/api/templates/matrix` is a sibling route registered
             * later; let it through so express keeps matching.
             */
            if (req.params.id === 'matrix') {
                next();
                return;
            }
            const templates = ctx.refreshTemplates();
            const tpl = templates.get(req.params.id);
            if (!tpl) {
                res.status(404).json({success: false, msg: `Unknown template ${req.params.id}`});
                return;
            }
            res.status(200).json(tpl);
        });
    }

    private static _registerCreate(ctx: ServerContext): void {
        ctx.app.post('/api/templates', async(req, res): Promise<void> => {
            const body = req.body as ApiTemplateMutationRequest;
            const idError = TemplatesController._validateTemplateBody(body);
            if (idError) {
                res.status(400).json({success: false, msg: idError});
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaTemplate.validate(body, errors)) {
                res.status(400).json({success: false, msg: `Invalid template: ${JSON.stringify(errors)}`});
                return;
            }
            const existing = ctx.refreshTemplates();
            if (existing.has(body.id)) {
                res.status(409).json({success: false, msg: `Template "${body.id}" already exists`});
                return;
            }
            try {
                TemplatesController._writeTemplate(ctx.templatesDir, body);
                const reloaded = ctx.refreshTemplates();
                const saved = reloaded.get(body.id);
                if (!saved) {
                    throw new Error('failed to read back the saved template');
                }
                const response: ApiTemplateMutationResponse = {
                    success: true,
                    template: TemplatesController._toTemplateSummary(saved, ctx.templateLoader)
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerUpdate(ctx: ServerContext): void {
        ctx.app.put('/api/templates/:id', async(req, res): Promise<void> => {
            const body = req.body as ApiTemplateMutationRequest;
            if (body?.id !== req.params.id) {
                res.status(400).json({success: false, msg: 'id in body must match id in URL'});
                return;
            }
            const idError = TemplatesController._validateTemplateBody(body);
            if (idError) {
                res.status(400).json({success: false, msg: idError});
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaTemplate.validate(body, errors)) {
                res.status(400).json({success: false, msg: `Invalid template: ${JSON.stringify(errors)}`});
                return;
            }
            const existing = ctx.refreshTemplates();
            if (!existing.has(body.id)) {
                res.status(404).json({success: false, msg: `Unknown template ${body.id}`});
                return;
            }
            const src = ctx.templateLoader.getSource(body.id);
            if (src?.kind === 'remote') {
                res.status(403).json({success: false, msg: `Template "${body.id}" is remote (read-only)`});
                return;
            }
            try {
                TemplatesController._writeTemplate(ctx.templatesDir, body);
                const reloaded = ctx.refreshTemplates();
                const saved = reloaded.get(body.id);
                if (!saved) {
                    throw new Error('failed to read back the saved template');
                }
                const response: ApiTemplateMutationResponse = {
                    success: true,
                    template: TemplatesController._toTemplateSummary(saved, ctx.templateLoader)
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerDelete(ctx: ServerContext): void {
        ctx.app.delete('/api/templates/:id', async(req, res): Promise<void> => {
            const existing = ctx.refreshTemplates();
            if (!existing.has(req.params.id)) {
                res.status(404).json({success: false, msg: `Unknown template ${req.params.id}`});
                return;
            }
            const src = ctx.templateLoader.getSource(req.params.id);
            if (src?.kind === 'remote') {
                res.status(403).json({success: false, msg: `Template "${req.params.id}" is remote (read-only)`});
                return;
            }
            try {
                const dir = path.join(ctx.templatesDir, req.params.id);
                fs.rmSync(dir, {recursive: true, force: true});
                ctx.refreshTemplates();
                const response: ApiTemplateDeleteResponse = {success: true};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerAddSource(ctx: ServerContext): void {
        ctx.app.post('/api/templates/sources', async(req, res): Promise<void> => {
            const errors: SchemaErrors = [];
            if (!SchemaApiAddTemplateSource.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: `invalid request body: ${JSON.stringify(errors)}`});
                return;
            }
            const url = (req.body as ApiAddTemplateSourceRequest).url.trim();
            if (!/^https?:\/\//iu.test(url)) {
                res.status(400).json({success: false, msg: 'http(s) URL required'});
                return;
            }
            try {
                ctx.mutateConfig((cfg): void => {
                    const have = Array.isArray(cfg.templateSources)
                        ? cfg.templateSources as string[]
                        : [];
                    if (have.includes(url)) {
                        throw new Error(`URL already configured: ${url}`);
                    }
                    cfg.templateSources = [...have, url];
                });
                if (!ctx.configFile) {
                    throw new Error('nppm.json path not configured');
                }
                const cfg = JSON.parse(fs.readFileSync(ctx.configFile, 'utf-8')) as Record<string, unknown>;
                const urls = Array.isArray(cfg.templateSources)
                    ? (cfg.templateSources as string[]).filter((u): u is string => typeof u === 'string')
                    : [];
                await ctx.templateLoader.refreshRemote(urls);
                const reloaded = ctx.refreshTemplates();
                let templateId: string|null = null;
                for (const id of reloaded.keys()) {
                    const src = ctx.templateLoader.getSource(id);
                    if (src?.kind === 'remote' && src.url === url) {
                        templateId = id;
                        break;
                    }
                }
                const response: ApiAddTemplateSourceResponse = {success: true, templateId: templateId};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerCompliance(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/compliance', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const templates = ctx.refreshTemplates();
                const requestedIds = project.getTemplates();
                const knownIds = requestedIds.filter((id): boolean => templates.has(id));
                const unresolvedIds = requestedIds.filter((id): boolean => !templates.has(id));
                const resolver = new TemplateResolver(
                    templates,
                    (id): string => ctx.templateLoader.getFilesDir(id)
                );
                const resolved = resolver.resolve(knownIds);
                const manifests = await project.loadManifests();
                const projectRoot = project instanceof ProjectLocal ? project.getRoot() : undefined;
                const report = ctx.templateChecker.check(manifests, resolved, {projectRoot: projectRoot});
                const response: ApiComplianceResponse = {
                    project: {unid: req.params.id, name: project.getName()},
                    templateIds: report.templateIds,
                    findings: report.findings,
                    worst: report.worst,
                    unresolvedIds: unresolvedIds
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerComplianceApply(ctx: ServerContext): void {
        ctx.app.post('/api/projects/:id/compliance/apply', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            if (!(project instanceof ProjectLocal)) {
                res.status(400).json({success: false, msg: 'Template apply only supports local projects'});
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaApiComplianceApply.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: `invalid request body: ${JSON.stringify(errors)}`});
                return;
            }
            const targets = (req.body as ApiComplianceApplyRequest).targets;
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
                const templates = ctx.refreshTemplates();
                const requestedIds = project.getTemplates();
                const knownIds = requestedIds.filter((id): boolean => templates.has(id));
                const resolver = new TemplateResolver(
                    templates,
                    (id): string => ctx.templateLoader.getFilesDir(id)
                );
                const resolved = resolver.resolve(knownIds);
                const manifests = await project.loadManifests();
                const projectRoot = project.getRoot();
                const backupStore = new BackupStore(NppmDirs.backups(projectRoot));
                const applier = new TemplateApplier();

                const start: ApiComplianceApplyStartEvent = {count: targets.length, backupDir: null};
                send('start', start);

                const result = applier.apply({
                    projectRoot: projectRoot,
                    manifests: manifests,
                    template: resolved,
                    selectedTargets: targets,
                    backupStore: backupStore,
                    onProgress: (i, total, outcome): void => {
                        const ev: ApiComplianceApplyProgressEvent = {
                            current: i,
                            total: total,
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

                const applied = result.outcomes.filter((o): boolean => o.status === 'applied').length;
                const skipped = result.outcomes.filter((o): boolean => o.status === 'skipped').length;
                const errored = result.outcomes.filter((o): boolean => o.status === 'error').length;
                const end: ApiComplianceApplyEndEvent = {applied: applied, skipped: skipped, errored: errored};
                send('end', end);
            } catch (e) {
                send('error', {msg: (e as Error).message});
            } finally {
                res.end();
            }
        });
    }

    private static _registerMatrix(ctx: ServerContext): void {
        ctx.app.get('/api/templates/matrix', async(_req, res): Promise<void> => {
            const templates = ctx.refreshTemplates();
            const resolver = new TemplateResolver(
                templates,
                (id): string => ctx.templateLoader.getFilesDir(id)
            );
            const rows: ApiTemplatesMatrixRow[] = [];
            for (const tpl of templates.values()) {
                const cells: ApiTemplatesMatrixCell[] = [];
                for (const [unid, project] of ctx.projects.entries()) {
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
                        const knownIds = declared.filter((id): boolean => templates.has(id));
                        const resolved = resolver.resolve(knownIds);
                        // eslint-disable-next-line no-await-in-loop
                        const manifests = await project.loadManifests();
                        const projectRoot = project instanceof ProjectLocal ? project.getRoot() : undefined;
                        const report = ctx.templateChecker.check(manifests, resolved, {projectRoot: projectRoot});
                        cells.push({
                            projectUnid: unid,
                            projectName: project.getName(),
                            matchedTemplateIds: report.templateIds,
                            worst: report.worst,
                            findingCount: report.findings.length
                        });
                    } catch {
                        cells.push({
                            projectUnid: unid,
                            projectName: project.getName(),
                            matchedTemplateIds: [],
                            worst: null,
                            findingCount: 0
                        });
                    }
                }
                rows.push({
                    template: TemplatesController._toTemplateSummary(tpl, ctx.templateLoader),
                    cells: cells
                });
            }
            const response: ApiTemplatesMatrixResponse = {rows: rows};
            res.status(200).json(response);
        });
    }

    /**
     * Validate a template-mutation body before handing it to the VTS
     * schema. The id format check + reserved-name check are easier to
     * express as code than to encode in VTS; everything else is
     * delegated to `SchemaTemplate.validate()`.
     */
    private static _validateTemplateBody(body: unknown): string|null {
        if (!body || typeof body !== 'object') {
            return 'request body required';
        }
        const id = (body as {id?: unknown;}).id;
        if (typeof id !== 'string' || id.length === 0) {
            return 'id is required';
        }
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) {
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
        const clean = TemplatesController._stripEmpty(body);
        fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`);
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
            mode: t.mode === 'strict' ? 'strict' : 'additive',
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

}