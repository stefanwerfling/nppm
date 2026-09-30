import {NextFunction, Request, Response} from 'express';
import {
    ApiRegistryClearResponse,
    ApiRegistryLogEntry,
    ApiRegistryPackage,
    ApiRegistryPackagesResponse,
    ApiRegistryStatusResponse
} from '../../shared/Api/ApiTypes.js';
import {DiskTarballStore} from '../Registry/DiskTarballStore.js';
import {HttpUpstreamFetcher} from '../Registry/HttpUpstreamFetcher.js';
import {RegistryActivity} from '../Registry/RegistryActivity.js';
import {RegistryProxy} from '../Registry/RegistryProxy.js';
import {ServerContext} from './ServerContext.js';

/**
 * npm-compatible registry surface + its management API (steps 18.2/18.3
 * for serving, 18.6 for the UI-facing status / packages / live-log /
 * clear routes).
 *
 * The `/api/registry/*` management routes register **always** so the
 * RegistryView can render an "off" state and show whatever is already
 * mirrored on disk. The actual registry mount (`app.use(mountPath, …)`)
 * only attaches when `proxy.enabled` — that's the one that makes
 * `npm config set registry http://localhost:5190/registry` resolve
 * installs through nppm.
 *
 * Request shapes on the mount, distinguished by the `/-/` tarball
 * separator (hand-parsed, not `:param`, so scoped names work):
 *
 *   GET <mount>/<name>                       → packument metadata
 *   GET <mount>/<name>/-/<unscoped>-<v>.tgz  → tarball bytes
 */
export class RegistryProxyController {

    public static register(ctx: ServerContext): void {
        const proxyCfg = ctx.loaded.proxy;
        const store = new DiskTarballStore(proxyCfg.storeDir);
        const activity = new RegistryActivity();

        RegistryProxyController._registerStatus(ctx, store, activity);
        RegistryProxyController._registerPackages(ctx, store);
        RegistryProxyController._registerLog(ctx, activity);
        RegistryProxyController._registerClear(ctx, store);

        if (!proxyCfg.enabled) {
            return;
        }
        const proxy = new RegistryProxy(new HttpUpstreamFetcher(proxyCfg.upstream, proxyCfg.token), store);
        const mountPath = proxyCfg.mountPath;

        ctx.app.use(mountPath, (req: Request, res: Response, next: NextFunction): void => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                next();
                return;
            }
            void RegistryProxyController._handle(proxy, activity, mountPath, req, res);
        });
    }

    // ---- management API (always registered) ----------------------------

    private static _registerStatus(ctx: ServerContext, store: DiskTarballStore, activity: RegistryActivity): void {
        ctx.app.get('/api/registry/status', async(_req, res): Promise<void> => {
            const proxyCfg = ctx.loaded.proxy;
            const entries = await store.list();
            const names = new Set(entries.map((e) => e.name));
            const {hits, misses} = activity.counters();
            const response: ApiRegistryStatusResponse = {
                enabled: proxyCfg.enabled,
                upstream: proxyCfg.upstream,
                mountPath: proxyCfg.mountPath,
                packages: names.size,
                versions: entries.length,
                totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
                hits: hits,
                misses: misses
            };
            res.status(200).json(response);
        });
    }

    private static _registerPackages(ctx: ServerContext, store: DiskTarballStore): void {
        ctx.app.get('/api/registry/packages', async(_req, res): Promise<void> => {
            const entries = await store.list();
            const byName = new Map<string, ApiRegistryPackage>();
            for (const e of entries) {
                let pkg = byName.get(e.name);
                if (!pkg) {
                    pkg = {name: e.name, versions: [], totalBytes: 0};
                    byName.set(e.name, pkg);
                }
                pkg.versions.push({version: e.version, bytes: e.bytes, mtime: e.mtime});
                pkg.totalBytes += e.bytes;
            }
            const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
            for (const p of packages) {
                p.versions.sort((a, b) => b.mtime - a.mtime);
            }
            const response: ApiRegistryPackagesResponse = {packages: packages};
            res.status(200).json(response);
        });
    }

    private static _registerLog(ctx: ServerContext, activity: RegistryActivity): void {
        ctx.app.get('/api/registry/log', (req, res): void => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            res.flushHeaders();
            const send = (event: string, data: object): void => {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };
            for (const entry of activity.recent()) {
                send('entry', entry);
            }
            send('ready', {});
            const unsubscribe = activity.subscribe((entry: ApiRegistryLogEntry) => send('entry', entry));
            const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
            req.on('close', (): void => {
                clearInterval(heartbeat);
                unsubscribe();
            });
        });
    }

    private static _registerClear(ctx: ServerContext, store: DiskTarballStore): void {
        ctx.app.post('/api/registry/clear', async(_req, res): Promise<void> => {
            try {
                const removed = await store.clear();
                const response: ApiRegistryClearResponse = {success: true, removed: removed};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, removed: 0, msg: (e as Error).message});
            }
        });
    }

    // ---- registry mount ------------------------------------------------

    private static async _handle(
        proxy: RegistryProxy,
        activity: RegistryActivity,
        mountPath: string,
        req: Request,
        res: Response
    ): Promise<void> {
        const rel = req.path.replace(/^\/+/u, '');

        /*
         * A bare mount hit (`GET /registry`) is npm's registry ping —
         * answer with an empty document so tooling that probes the
         * endpoint sees a live JSON registry.
         */
        if (rel.length === 0) {
            activity.record({time: Date.now(), method: req.method, name: '/', kind: 'ping', result: 'hit'});
            res.status(200).json({});
            return;
        }

        const tarIdx = rel.indexOf('/-/');
        try {
            if (tarIdx >= 0) {
                await RegistryProxyController._serveTarball(proxy, activity, rel, tarIdx, req, res);
            } else {
                await RegistryProxyController._servePackument(proxy, activity, mountPath, rel, req, res);
            }
        } catch (e) {
            activity.record({time: Date.now(), method: req.method, name: rel, kind: 'tarball', result: 'error'});
            res.status(500).json({error: (e as Error).message});
        }
    }

    private static async _servePackument(
        proxy: RegistryProxy,
        activity: RegistryActivity,
        mountPath: string,
        rel: string,
        req: Request,
        res: Response
    ): Promise<void> {
        const name = decodeURIComponent(rel);
        const publicBase = `${req.protocol}://${req.get('host') ?? 'localhost'}${mountPath}`;
        const {status, body} = await proxy.getPackument(name, publicBase);
        if (!body) {
            activity.record({time: Date.now(), method: req.method, name: name, kind: 'packument', result: 'not-found'});
            res.status(status).json({error: `package not found: ${name}`});
            return;
        }
        activity.record({time: Date.now(), method: req.method, name: name, kind: 'packument', result: 'hit'});
        res.status(200).json(body);
    }

    private static async _serveTarball(
        proxy: RegistryProxy,
        activity: RegistryActivity,
        rel: string,
        tarIdx: number,
        req: Request,
        res: Response
    ): Promise<void> {
        const name = decodeURIComponent(rel.slice(0, tarIdx));
        const file = rel.slice(tarIdx + 3);
        const version = RegistryProxy.versionFromTarballFile(name, file);
        if (!version) {
            res.status(400).json({error: `malformed tarball path: ${file}`});
            return;
        }
        const {status, body, source} = await proxy.getTarball(name, version);
        if (!body) {
            activity.record({time: Date.now(), method: req.method, name: name, version: version, kind: 'tarball', result: 'not-found'});
            res.status(status).json({error: `tarball not found: ${name}@${version}`});
            return;
        }
        activity.record({
            time: Date.now(),
            method: req.method,
            name: name,
            version: version,
            kind: 'tarball',
            result: source === 'store' ? 'hit' : 'miss',
            bytes: body.length
        });
        res.status(200);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(body.length));
        res.end(body);
    }

}