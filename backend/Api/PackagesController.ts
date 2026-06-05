import {ApiManifest, ApiPackagesResponse} from '../../shared/Api/ApiTypes.js';
import {ServerContext} from './ServerContext.js';

/**
 * Full manifest list (root + every workspace) for one project. 404
 * on unknown UUID — the frontend can resync via `/api/projects`. This
 * is the per-project sibling of `/api/projects` (which carries one
 * row per project, not per workspace).
 */
export class PackagesController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/packages', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const manifests = await project.loadManifests();
                const apiManifests: ApiManifest[] = manifests.map((m): ApiManifest => ({
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
    }
}