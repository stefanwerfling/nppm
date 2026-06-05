import {ApiSecurityResponse} from '../../shared/Api/ApiTypes.js';
import {ServerContext} from './ServerContext.js';

/**
 * Aggregated security report for one `pkg@version` — OSV.dev vuln
 * list plus the lifecycle-script heuristic plus everything the
 * SecurityScanner pulls together. Same query-param convention as the
 * fingerprint routes so scoped names survive.
 */
export class SecurityController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/security', async(req, res): Promise<void> => {
            const name = typeof req.query.name === 'string' ? req.query.name : '';
            const version = typeof req.query.version === 'string' ? req.query.version : '';
            if (!name || !version) {
                res.status(400).json({
                    success: false,
                    msg: 'name and version query params are required'
                });
                return;
            }
            try {
                const report = await ctx.loaded.securityScanner.scan(name, version);
                const response: ApiSecurityResponse = report;
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }
}