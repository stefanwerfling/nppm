import {ApiSelfCodeResponse} from '../../shared/Api/ApiTypes.js';
import {ServerContext} from './ServerContext.js';

/**
 * Walks the project's own source files and reports per-file
 * dynamic-execution / exfil-URL / secret-env findings. Remote
 * projects respond with `supported: false`, same shape as the
 * source-graph endpoint, so the UI can render an info banner instead
 * of an error.
 */
export class SelfCodeController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/self-code', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const data = await ctx.selfCodeScanner.scan(project);
                data.project.unid = req.params.id;
                const response: ApiSelfCodeResponse = data;
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

}