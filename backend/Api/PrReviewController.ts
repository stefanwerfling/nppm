import {ProjectLocal} from '../Project/ProjectLocal.js';
import {ServerContext} from './ServerContext.js';

/**
 * Diff `package.json` + `package-lock.json` between two git refs
 * (defaults `main` vs `HEAD`), surface every changed dep with its CVE
 * delta from the cached OSV pocket. Local projects only in v1 —
 * remote would need API-driven `git show`.
 */
export class PrReviewController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/pr-review', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            if (!(project instanceof ProjectLocal)) {
                res.status(400).json({success: false, msg: 'PR review only supported for local projects'});
                return;
            }

            const base = typeof req.query.base === 'string' && req.query.base.length > 0
                ? req.query.base
                : 'main';
            const head = typeof req.query.head === 'string' && req.query.head.length > 0
                ? req.query.head
                : 'HEAD';

            try {
                const report = await ctx.prReviewBuilder.build(project.getRoot(), base, head, {
                    unid: req.params.id,
                    name: project.getName(),
                    type: project.getType()
                });
                res.status(200).json(report);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

}