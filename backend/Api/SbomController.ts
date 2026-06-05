import {CycloneDxBuilder} from '../Sbom/CycloneDxBuilder.js';
import {SbomCollector} from '../Sbom/SbomCollector.js';
import {SpdxBuilder} from '../Sbom/SpdxBuilder.js';
import {ServerContext} from './ServerContext.js';

/**
 * Per-project Software Bill of Materials. Walks the lockfile +
 * registry (no fingerprint downloads) and emits the requested format —
 * `cyclonedx` (default) or `spdx`. Content-Type is set so downstream
 * tooling can route the response by MIME instead of by query string.
 */
export class SbomController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/projects/:id/sbom', async(req, res): Promise<void> => {
            const project = ctx.getProject(req.params.id);
            if (!project) {
                res.status(404).json({success: false, msg: `Unknown project ${req.params.id}`});
                return;
            }
            const format = typeof req.query.format === 'string' ? req.query.format : 'cyclonedx';
            if (format !== 'cyclonedx' && format !== 'spdx') {
                res.status(400).json({
                    success: false,
                    msg: `Unsupported format "${format}" — expected cyclonedx | spdx`
                });
                return;
            }
            try {
                const collector = new SbomCollector(ctx.loaded.registry);
                const data = await collector.collect(project);
                if (format === 'cyclonedx') {
                    res.set('Content-Type', 'application/vnd.cyclonedx+json');
                    res.status(200).json(CycloneDxBuilder.build(data, '1'));
                } else {
                    res.set('Content-Type', 'application/spdx+json');
                    res.status(200).json(SpdxBuilder.build(data, '1'));
                }
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }
}