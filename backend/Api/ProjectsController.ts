import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {
    ApiProject,
    ApiProjectConfigResponse,
    ApiProjectMutationRequest,
    ApiProjectMutationResponse,
    ApiProjectsResponse
} from '../../shared/Api/ApiTypes.js';
import {JsonCache} from '../Cache/JsonCache.js';
import {ConfigProjectType} from '../Config/Config.js';
import {ConfigLoader} from '../Config/ConfigLoader.js';
import {Project} from '../Project/Project.js';
import {ProjectGitea} from '../Project/ProjectGitea.js';
import {ProjectGithub} from '../Project/ProjectGithub.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {SchemaApiProjectMutation, SchemaApiProjectVisibility} from './Schemas/SchemaApiProjects.js';
import {ServerContext} from './ServerContext.js';

/**
 * Routes that read / mutate the `projects` list in `nppm.json` plus
 * the runtime UUID map. Mutations stay atomic at the nppm.json level
 * (full file rewrite under a single mutator pass) and the runtime map
 * is updated in lockstep so an active browser tab never sees a stale
 * project.
 */
export class ProjectsController {

    public static register(ctx: ServerContext): void {
        ProjectsController._registerList(ctx);
        ProjectsController._registerGetConfig(ctx);
        ProjectsController._registerCreate(ctx);
        ProjectsController._registerUpdate(ctx);
        ProjectsController._registerVisibility(ctx);
    }

    private static _registerList(ctx: ServerContext): void {
        ctx.app.get('/api/projects', async(_req, res): Promise<void> => {
            const result: ApiProject[] = [];
            for (const [unid, project] of ctx.projects.entries()) {
                // eslint-disable-next-line no-await-in-loop
                result.push(await ProjectsController._toApiProject(unid, project));
            }
            const response: ApiProjectsResponse = {projects: result, editor: ctx.loaded.editor};
            res.status(200).json(response);
        });
    }

    private static _registerGetConfig(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/config', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const idx = project.getConfigIndex();
                if (!ctx.configFile || !fs.existsSync(ctx.configFile)) {
                    res.status(404).json({success: false, msg: 'nppm.json not found'});
                    return;
                }
                const cfg = JSON.parse(fs.readFileSync(ctx.configFile, 'utf-8')) as {projects?: unknown[];};
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
    }

    private static _registerCreate(ctx: ServerContext): void {
        ctx.app.post('/api/projects', async(req, res): Promise<void> => {
            const errors: SchemaErrors = [];
            if (!SchemaApiProjectMutation.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: `invalid request body: ${JSON.stringify(errors)}`});
                return;
            }
            const body = req.body as ApiProjectMutationRequest;
            const normalisedRepo = ProjectsController._validateGithubRepo(body);
            if (normalisedRepo !== null) {
                res.status(400).json({success: false, msg: normalisedRepo});
                return;
            }
            try {
                let newIndex = 0;
                ctx.mutateConfig((cfg): void => {
                    if (!Array.isArray(cfg.projects)) {
                        cfg.projects = [];
                    }
                    cfg.projects.push(ProjectsController._projectEntryFromBody(body));
                    newIndex = cfg.projects.length - 1;
                });
                const project = ProjectsController._instantiateProject(
                    body, ctx.projectRoot, ctx.loaded.remoteCache, newIndex
                );
                const unid = crypto.randomUUID();
                ctx.projects.set(unid, project);
                const response: ApiProjectMutationResponse = {
                    success: true,
                    project: await ProjectsController._toApiProject(unid, project)
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerUpdate(ctx: ServerContext): void {
        ctx.app.put('/api/projects/:id', async(req, res): Promise<void> => {
            const existing = ctx.getProject(req.params.id);
            if (!existing) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaApiProjectMutation.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: `invalid request body: ${JSON.stringify(errors)}`});
                return;
            }
            const body = req.body as ApiProjectMutationRequest;
            const normalisedRepo = ProjectsController._validateGithubRepo(body);
            if (normalisedRepo !== null) {
                res.status(400).json({success: false, msg: normalisedRepo});
                return;
            }
            try {
                const idx = existing.getConfigIndex();
                ctx.mutateConfig((cfg): void => {
                    if (!Array.isArray(cfg.projects) || idx < 0 || idx >= cfg.projects.length) {
                        throw new Error('Project entry not found in nppm.json (stale index)');
                    }
                    cfg.projects[idx] = ProjectsController._projectEntryFromBody(body);
                });
                const project = ProjectsController._instantiateProject(
                    body, ctx.projectRoot, ctx.loaded.remoteCache, idx
                );
                ctx.projects.set(req.params.id, project);
                const response: ApiProjectMutationResponse = {
                    success: true,
                    project: await ProjectsController._toApiProject(req.params.id, project)
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerVisibility(ctx: ServerContext): void {
        ctx.app.patch('/api/projects/:id/visibility', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            const errors: SchemaErrors = [];
            if (!SchemaApiProjectVisibility.validate(req.body, errors)) {
                res.status(400).json({success: false, msg: `invalid request body: ${JSON.stringify(errors)}`});
                return;
            }
            const hidden = (req.body as {hidden: boolean;}).hidden;
            try {
                ctx.mutateConfig((cfg): void => {
                    const idx = project.getConfigIndex();
                    if (!Array.isArray(cfg.projects) || idx < 0 || idx >= cfg.projects.length) {
                        throw new Error('Project entry not found in nppm.json (stale index)');
                    }
                    const entry = cfg.projects[idx] as {hidden?: boolean;};
                    if (hidden) {
                        entry.hidden = true;
                    } else {
                        delete entry.hidden;
                    }
                });
                project.setHidden(hidden);
                res.status(200).json({success: true, hidden: hidden});
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    /**
     * Re-validate the GitHub `repo` field against the
     * "owner/name"-or-URL pattern. Returns null on success or an
     * error message; the body has already passed the VTS shape
     * validation by the time we get here.
     */
    private static _validateGithubRepo(body: ApiProjectMutationRequest): string|null {
        if (body.type !== ConfigProjectType.github) {
            return null;
        }
        const repo = body.repo ?? '';
        if (ProjectsController._normaliseGithubRepo(repo) === null) {
            return `repo "${repo}" must look like "owner/name" or "https://github.com/owner/name"`;
        }
        return null;
    }

    /**
     * Accept both the short-form `owner/name` the GitHub contents API
     * actually wants and the long-form `https://github.com/owner/name(.git)?`
     * users tend to paste from the address bar. Returns the normalised
     * short form, or `null` when neither shape matches.
     */
    private static _normaliseGithubRepo(input: string): string|null {
        const v = input.trim().replace(/\.git$/u, '').replace(/\/$/u, '');
        const long = /^(?:https?:\/\/(?:[^@]+@)?github\.com\/|git@github\.com:|git\+https?:\/\/github\.com\/|github:)([^/\s]+)\/([^/\s]+)$/iu.exec(v);
        if (long) {
            return `${long[1]}/${long[2]}`;
        }
        if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/u.test(v)) {
            return v;
        }
        return null;
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
            const repoIn = body.repo ?? '';
            out.repo = ProjectsController._normaliseGithubRepo(repoIn) ?? repoIn;
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
     * Construct a live `Project` instance from the mutation body. The
     * shared `remoteCache` is the same one the loader hands out at
     * boot so freshly-added remote projects warm into the same cache
     * pocket without extra plumbing.
     */
    private static _instantiateProject(
        body: ApiProjectMutationRequest,
        projectRoot: string,
        remoteCache: JsonCache,
        configIndex: number
    ): Project {
        const hidden = body.hidden === true;
        const templates = Array.isArray(body.templates) ? body.templates : [];
        if (body.type === ConfigProjectType.local) {
            const absRoot = path.resolve(projectRoot, body.path!);
            return new ProjectLocal(absRoot, body.name, {
                hidden: hidden,
                configIndex: configIndex,
                templates: templates
            });
        }
        if (body.type === ConfigProjectType.github) {
            return new ProjectGithub(
                body.repo!,
                body.name ?? body.repo!,
                body.ref,
                ConfigLoader.expandEnv(body.token),
                remoteCache,
                {hidden: hidden, configIndex: configIndex, templates: templates}
            );
        }
        return new ProjectGitea(
            body.url!,
            body.name ?? body.url!,
            body.ref,
            ConfigLoader.expandEnv(body.token),
            remoteCache,
            {hidden: hidden, configIndex: configIndex, templates: templates}
        );
    }

    /**
     * Build the `ApiProject` summary for one project — mirrors what
     * `GET /api/projects` returns for that single entry. Pulls
     * packageCount + workspaceCount via the same loadManifests path so
     * the frontend's treeview row renders with real numbers
     * immediately.
     */
    private static async _toApiProject(unid: string, project: Project): Promise<ApiProject> {
        const root = project instanceof ProjectLocal ? project.getRoot() : undefined;
        try {
            const manifests = await project.loadManifests();
            const total = manifests.reduce((sum, m): number => sum + m.dependencies.length, 0);
            return {
                unid: unid,
                name: project.getName(),
                type: project.getType(),
                packageCount: total,
                workspaceCount: manifests.length - 1,
                root: root,
                hidden: project.isHidden()
            };
        } catch (e) {
            return {
                unid: unid,
                name: project.getName(),
                type: project.getType(),
                packageCount: 0,
                workspaceCount: 0,
                root: root,
                hidden: project.isHidden(),
                error: (e as Error).message
            };
        }
    }

}