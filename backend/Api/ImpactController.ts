import {ApiImpactResponse} from '../../shared/Api/ApiTypes.js';
import {DepGraphBuilder} from '../DepGraph/DepGraphBuilder.js';
import {ImpactAnalyzer, ImpactProjectReport} from '../Security/ImpactAnalyzer.js';
import {ServerContext} from './ServerContext.js';

/**
 * Cross-project blast-radius lookup. `name` is required; `version` is
 * the permissive shape documented on `ImpactAnalyzer.versionMatches`
 * (empty / missing = match every version). Hidden projects are
 * scanned too — incident response cares about the full ecosystem, not
 * just the matrix-visible repos.
 */
export class ImpactController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/impact', async(req, res): Promise<void> => {
            const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
            if (name === '') {
                res.status(400).json({success: false, msg: 'name query param required'});
                return;
            }
            const rawVersion = typeof req.query.version === 'string' ? req.query.version.trim() : '';
            const versionPattern = rawVersion === '' ? null : rawVersion;

            const perProject: ImpactProjectReport[] = [];
            const skipped: {unid: string; name: string; type: string; reason: string;}[] = [];

            for (const [unid, project] of ctx.projects.entries()) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const graph = await DepGraphBuilder.build(unid, project, ctx.loaded.registry, ctx.loaded.securityCache);
                    if (!graph) {
                        skipped.push({
                            unid: unid,
                            name: project.getName(),
                            type: project.getType(),
                            reason: 'no lockfile'
                        });
                        continue;
                    }
                    perProject.push(ImpactAnalyzer.analyzeGraph(graph, name, versionPattern));
                } catch (e) {
                    skipped.push({
                        unid: unid,
                        name: project.getName(),
                        type: project.getType(),
                        reason: (e as Error).message
                    });
                }
            }

            const report: ApiImpactResponse = ImpactAnalyzer.buildReport(
                {name: name, versionPattern: versionPattern},
                perProject,
                skipped
            );
            res.status(200).json(report);
        });
    }
}