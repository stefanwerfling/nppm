import {ApiSourceGraphResponse} from '../../shared/Api/ApiTypes.js';
import {ServerContext} from './ServerContext.js';

/**
 * Walks the project's source tree and returns a directed file-level
 * import graph. Remote projects respond with `supported: false`
 * rather than a 4xx so the UI can render an info banner.
 */
export class SourceGraphController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/source-graph', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const data = await ctx.sourceGraphBuilder.build(project);
                data.project.unid = req.params.id;
                const response: ApiSourceGraphResponse = data;
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

}