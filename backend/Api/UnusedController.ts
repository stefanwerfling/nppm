import {ApiUnusedResponse} from '../../shared/Api/ApiTypes.js';
import {ServerContext} from './ServerContext.js';

/**
 * Depcheck-style hygiene scan for one project. Returns three buckets
 * (unused / misplaced / missing) plus the list of files the regex
 * scanner couldn't fully resolve (dynamic specs). Remote projects
 * respond with `supported: false` rather than a 4xx, so the UI can
 * render an info banner instead of an error.
 */
export class UnusedController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/unused', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const report = await ctx.loaded.unusedDetector.scan(project);
                report.project.unid = req.params.id;
                const response: ApiUnusedResponse = report;
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }
}