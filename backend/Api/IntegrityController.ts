import {ApiIntegrityResponse} from '../../shared/Api/ApiTypes.js';
import {IntegrityScanner} from '../Security/IntegrityScanner.js';
import {ServerContext} from './ServerContext.js';

/**
 * Cross-checks the lockfile's pinned `resolved` + `integrity` per entry
 * against what the registry currently serves. Surfaces mirror-hijack /
 * dependency-confusion / lockfile-injection as risk-level findings.
 * Works on any project type — `loadLockfile()` returns null cleanly
 * for sources without one (signalled via `noLockfile`).
 */
export class IntegrityController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/integrity', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            try {
                const lockfile = await project.loadLockfile();
                if (!lockfile) {
                    const response: ApiIntegrityResponse = {
                        project: {
                            unid: req.params.id,
                            name: project.getName(),
                            type: project.getType()
                        },
                        findings: [],
                        summary: IntegrityScanner.summarize([], 0),
                        noLockfile: true
                    };
                    res.status(200).json(response);
                    return;
                }

                const findings = await ctx.integrityScanner.scan(lockfile.packages);
                const totalScanned = new Set(
                    lockfile.packages
                        .filter((p): boolean => Boolean(p.name) && Boolean(p.version))
                        .map((p): string => `${p.name}@${p.version}`)
                ).size;
                const summary = IntegrityScanner.summarize(findings, totalScanned);
                const response: ApiIntegrityResponse = {
                    project: {
                        unid: req.params.id,
                        name: project.getName(),
                        type: project.getType()
                    },
                    findings: findings,
                    summary: summary,
                    noLockfile: false
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }
}