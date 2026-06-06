import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {
    ApiCacheClearResponse,
    ApiConfigMutationRequest,
    ApiConfigMutationResponse,
    ApiConfigResponse
} from '../../shared/Api/ApiTypes.js';
import {SchemaConfig} from '../Config/Config.js';
import {SchemaApiConfigMutation} from './Schemas/SchemaApiConfig.js';
import {ServerContext} from './ServerContext.js';

/**
 * Routes that touch `nppm.json` directly (read + replace) plus the
 * "clear cache" sweep. The `projects` array is *never* mutated here —
 * those edits go through `ProjectsController` so the runtime project
 * map and the on-disk array stay in sync.
 */
export class ConfigController {

    private static readonly _SECTIONS: readonly string[] = [
        'server', 'browser', 'registry', 'cache', 'actions', 'security', 'ui'
    ];

    public static register(ctx: ServerContext): void {
        ConfigController._registerGetConfig(ctx);
        ConfigController._registerPutConfig(ctx);
        ConfigController._registerClearCache(ctx);
    }

    private static _registerGetConfig(ctx: ServerContext): void {
        ctx.app.get('/api/config', async(_req, res): Promise<void> => {
            try {
                if (!ctx.configFile || !fs.existsSync(ctx.configFile)) {
                    res.status(404).json({success: false, msg: 'nppm.json not found'});
                    return;
                }
                const cfg = JSON.parse(fs.readFileSync(ctx.configFile, 'utf-8')) as Record<string, unknown>;
                const {projects: _ignored, ...rest} = cfg;
                const response: ApiConfigResponse = rest as ApiConfigResponse;
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerPutConfig(ctx: ServerContext): void {
        ctx.app.put('/api/config', async(req, res): Promise<void> => {
            const bodyErrors: SchemaErrors = [];
            if (!SchemaApiConfigMutation.validate(req.body, bodyErrors)) {
                res.status(400).json({
                    success: false,
                    msg: `invalid request body: ${JSON.stringify(bodyErrors)}`
                });
                return;
            }
            const body = req.body as ApiConfigMutationRequest;
            try {
                ctx.mutateConfig((cfg): void => {
                    /*
                     * Replace every known section explicitly; absent
                     * keys in `body` drop the section entirely so the
                     * on-disk shape stays clean.
                     */
                    for (const key of ConfigController._SECTIONS) {
                        delete cfg[key];
                    }
                    for (const [key, value] of Object.entries(body)) {
                        cfg[key] = value;
                    }
                    const errors: SchemaErrors = [];
                    if (!SchemaConfig.validate(cfg, errors)) {
                        throw new Error(`Invalid config: ${JSON.stringify(errors)}`);
                    }
                });
                const response: ApiConfigMutationResponse = {success: true};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerClearCache(ctx: ServerContext): void {
        ctx.app.post('/api/cache/clear', async(_req, res): Promise<void> => {
            try {
                const cacheDir = ctx.loaded.cacheDir;
                let removed = 0;
                if (fs.existsSync(cacheDir)) {
                    const walk = (dir: string): void => {
                        for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
                            const full = path.join(dir, e.name);
                            if (e.isDirectory()) {
                                walk(full);
                            } else {
                                fs.unlinkSync(full);
                                removed++;
                            }
                        }
                    };
                    walk(cacheDir);
                }
                const response: ApiCacheClearResponse = {success: true, removed: removed};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

}