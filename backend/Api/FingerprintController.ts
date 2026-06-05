import {ApiFingerprintDiffResponse, ApiFingerprintResponse} from '../../shared/Api/ApiTypes.js';
import {FingerprintDiffer} from '../Fingerprint/FingerprintDiff.js';
import {ServerContext} from './ServerContext.js';

/**
 * Per-file SHA-256 fingerprints and version-to-version diffs over
 * published `pkg@version` tarballs. Name + version travel as query
 * params so scoped names (`@scope/foo`) don't break Express route
 * parsing.
 *
 * Git URLs ride the cache-less HEAD builder for non-SHA-pinned refs
 * (`ctx.pickFingerprintBuilder()`); the permanent cache is reserved
 * for immutable registry coordinates and 40-char SHA git refs.
 */
export class FingerprintController {

    public static register(ctx: ServerContext): void {
        FingerprintController._registerOne(ctx);
        FingerprintController._registerDiff(ctx);
    }

    private static _registerOne(ctx: ServerContext): void {
        ctx.app.get('/api/fingerprint', async(req, res): Promise<void> => {
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
                const fingerprint = await ctx.pickFingerprintBuilder(version).build(name, version);
                const response: ApiFingerprintResponse = {fingerprint: fingerprint};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerDiff(ctx: ServerContext): void {
        ctx.app.get('/api/fingerprint/diff', async(req, res): Promise<void> => {
            const name = typeof req.query.name === 'string' ? req.query.name : '';
            const before = typeof req.query.before === 'string' ? req.query.before : '';
            const after = typeof req.query.after === 'string' ? req.query.after : '';
            if (!name || !before || !after) {
                res.status(400).json({
                    success: false,
                    msg: 'name, before and after query params are required'
                });
                return;
            }
            try {
                const [fpBefore, fpAfter] = await Promise.all([
                    ctx.pickFingerprintBuilder(before).build(name, before),
                    ctx.pickFingerprintBuilder(after).build(name, after)
                ]);
                const response: ApiFingerprintDiffResponse = {
                    before: {name: name, version: before},
                    after: {name: name, version: after},
                    diff: fpBefore && fpAfter ? FingerprintDiffer.diff(fpBefore, fpAfter) : null
                };
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }
}