import {NextFunction, Request, Response} from 'express';
import {
    ApiRegistryClearResponse,
    ApiRegistryHistoryResponse,
    ApiRegistryLogEntry,
    ApiRegistryPackage,
    ApiRegistryPackagesResponse,
    ApiRegistryStatusResponse
} from '../../shared/Api/ApiTypes.js';
import {DiskTarballStore} from '../Registry/DiskTarballStore.js';
import {HttpUpstreamFetcher} from '../Registry/HttpUpstreamFetcher.js';
import {RegistryActivity} from '../Registry/RegistryActivity.js';
import {RegistryHistoryStore} from '../Registry/RegistryHistoryStore.js';
import {RegistryProxy} from '../Registry/RegistryProxy.js';
import {ServerContext} from './ServerContext.js';

/**
 * Resolution of the optional `/registry/<project>/…` leading segment.
 * `project` is the canonical configured project name a matched segment
 * resolved to (or `default` when the first segment isn't a known
 * project — the legacy bare-mount path). `segment` is the *original*
 * matched segment, reused verbatim when rewriting `dist.tarball` so the
 * tarball request routes back through the same project bucket; `null`
 * on the default path. `rest` is the package path with the project
 * segment stripped.
 */
type ProjectRoute = {project: string; segment: string|null; rest: string;};

/**
 * npm-compatible registry surface + its management API (steps 18.2/18.3
 * for serving, 18.6 for the UI-facing status / packages / live-log /
 * clear routes; per-project extension adds the `/registry/<project>/…`
 * bucket, persisted tallies, and the history route).
 *
 * The `/api/registry/*` management routes register **always** so the
 * RegistryView can render an "off" state and show whatever is already
 * mirrored on disk. The actual registry mount (`app.use(mountPath, …)`)
 * only attaches when `proxy.enabled` — that's the one that makes
 * `npm config set registry http://localhost:5190/registry` resolve
 * installs through nppm.
 *
 * Request shapes on the mount, distinguished by the `/-/` tarball
 * separator (hand-parsed, not `:param`, so scoped names work). An
 * optional leading segment matching a configured project name buckets
 * the request under that project (and is stripped before the package
 * split):
 *
 *   GET <mount>/<name>                       → packument (default bucket)
 *   GET <mount>/<name>/-/<unscoped>-<v>.tgz  → tarball   (default bucket)
 *   GET <mount>/<project>/<name>             → packument (project bucket)
 *   GET <mount>/<project>/<name>/-/<u>-<v>.tgz → tarball (project bucket)
 */
export class RegistryProxyController {

    public static register(ctx: ServerContext): void {
        const proxyCfg = ctx.loaded.proxy;
        const store = new DiskTarballStore(proxyCfg.storeDir);
        const history = new RegistryHistoryStore(proxyCfg.historyDir);
        const activity = new RegistryActivity(history);

        RegistryProxyController._registerStatus(ctx, store, activity);
        RegistryProxyController._registerPackages(ctx, store, activity);
        RegistryProxyController._registerLog(ctx, activity);
        RegistryProxyController._registerHistory(ctx, activity, history);
        RegistryProxyController._registerClear(ctx, store);

        if (!proxyCfg.enabled) {
            return;
        }
        const proxy = new RegistryProxy(new HttpUpstreamFetcher(proxyCfg.upstream, proxyCfg.token), store);
        const mountPath = proxyCfg.mountPath;
        const labels = RegistryProxyController._projectLabels(ctx);
        const allowAny = proxyCfg.allowAnyProject;

        ctx.app.use(mountPath, (req: Request, res: Response, next: NextFunction): void => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                next();
                return;
            }
            void RegistryProxyController._handle(proxy, activity, labels, allowAny, mountPath, req, res);
        });
    }

    /**
     * Lowercased-label → canonical-project-name lookup, built from every
     * configured project's display name and stable key. Lets a user
     * point a project's `.npmrc` at `/registry/<name>` (or `/registry/
     * <key>`) and have the request counted under that project.
     */
    private static _projectLabels(ctx: ServerContext): Map<string, string> {
        const labels = new Map<string, string>();
        for (const project of ctx.projects.values()) {
            const name = project.getName();
            labels.set(name.toLowerCase(), name);
            labels.set(project.getKey().toLowerCase(), name);
        }
        return labels;
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
                misses: misses,
                allowAnyProject: proxyCfg.allowAnyProject,
                projects: activity.perProject()
            };
            res.status(200).json(response);
        });
    }

    private static _registerPackages(ctx: ServerContext, store: DiskTarballStore, activity: RegistryActivity): void {
        ctx.app.get('/api/registry/packages', async(_req, res): Promise<void> => {
            const entries = await store.list();
            const pkgHits = activity.pkgHits();
            const byName = new Map<string, ApiRegistryPackage>();
            for (const e of entries) {
                let pkg = byName.get(e.name);
                if (!pkg) {
                    pkg = {name: e.name, versions: [], totalBytes: 0, hits: pkgHits.get(e.name) ?? 0};
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

    private static _registerHistory(
        ctx: ServerContext,
        activity: RegistryActivity,
        history: RegistryHistoryStore
    ): void {
        ctx.app.get('/api/registry/history', (req, res): void => {
            /*
             * Flush today's in-memory tallies first so the freshest day
             * is on disk before we read the range back — otherwise the
             * current (throttled) day would read stale.
             */
            activity.flush();
            const daysRaw = Number.parseInt(String(req.query.days ?? ''), 10);
            const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 3650) : 90;
            const response: ApiRegistryHistoryResponse = {days: history.readRange(days, Date.now())};
            res.status(200).json(response);
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
        labels: Map<string, string>,
        allowAny: boolean,
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
            activity.record({time: Date.now(), method: req.method, project: 'default', name: '/', kind: 'ping', result: 'hit'});
            res.status(200).json({});
            return;
        }

        const route = RegistryProxyController.resolveProject(labels, rel, allowAny);

        /*
         * `/registry/<project>` with nothing after it is that project's
         * registry ping (npm probes the configured registry root).
         */
        if (route.rest.length === 0) {
            activity.record({time: Date.now(), method: req.method, project: route.project, name: '/', kind: 'ping', result: 'hit'});
            res.status(200).json({});
            return;
        }

        const tarIdx = route.rest.indexOf('/-/');
        try {
            if (tarIdx >= 0) {
                await RegistryProxyController._serveTarball(proxy, activity, route, tarIdx, req, res);
            } else {
                await RegistryProxyController._servePackument(proxy, activity, mountPath, route, req, res);
            }
        } catch (e) {
            activity.record({time: Date.now(), method: req.method, project: route.project, name: route.rest, kind: 'tarball', result: 'error'});
            res.status(500).json({error: (e as Error).message});
        }
    }

    /**
     * Split an optional leading project segment off `rel`.
     *
     * A configured project name / key (case-insensitive) always
     * buckets and resolves to its *canonical* name. Beyond that, the
     * behaviour depends on `allowAny` (config `proxy.allowAnyProject`):
     *
     *  - `allowAny === false` (default) — only configured names bucket.
     *    A bare `/registry/lodash` resolves `lodash` as a package
     *    (default bucket), and an unknown `/registry/<x>/…` segment is
     *    left glued to the package path (typically 404s).
     *  - `allowAny === true` — any first segment buckets as an ad-hoc
     *    project, detected heuristically so bare package/tarball URLs
     *    still work: a single-segment path (bare packument), an
     *    `@scope` first segment (scoped packument / scoped tarball),
     *    and a remainder that begins with `-/` (bare unscoped tarball
     *    `lodash/-/…`) all stay in the default bucket. Everything else
     *    (2+ segments, non-`@` first, package path following) buckets
     *    under the literal first segment.
     *
     * Public for unit testing — the routing decision is the tricky part
     * (scoped names, legacy bare paths, the heuristic) and deserves
     * direct coverage.
     */
    public static resolveProject(labels: Map<string, string>, rel: string, allowAny = false): ProjectRoute {
        const slash = rel.indexOf('/');
        const firstRaw = slash >= 0 ? rel.slice(0, slash) : rel;
        const canonical = labels.get(decodeURIComponent(firstRaw).toLowerCase());
        if (canonical) {
            return {project: canonical, segment: firstRaw, rest: slash >= 0 ? rel.slice(slash + 1) : ''};
        }
        if (allowAny && slash >= 0 && !firstRaw.startsWith('@')) {
            const rest = rel.slice(slash + 1);
            if (!rest.startsWith('-/')) {
                return {project: decodeURIComponent(firstRaw), segment: firstRaw, rest: rest};
            }
        }
        return {project: 'default', segment: null, rest: rel};
    }

    private static async _servePackument(
        proxy: RegistryProxy,
        activity: RegistryActivity,
        mountPath: string,
        route: ProjectRoute,
        req: Request,
        res: Response
    ): Promise<void> {
        const name = decodeURIComponent(route.rest);
        /*
         * Keep the project segment in the rewritten tarball URLs so the
         * follow-up tarball fetch routes back through the same bucket
         * and is counted under the same project.
         */
        const seg = route.segment ? `/${route.segment}` : '';
        const publicBase = `${req.protocol}://${req.get('host') ?? 'localhost'}${mountPath}${seg}`;
        const {status, body} = await proxy.getPackument(name, publicBase);
        if (!body) {
            activity.record({time: Date.now(), method: req.method, project: route.project, name: name, kind: 'packument', result: 'not-found'});
            res.status(status).json({error: `package not found: ${name}`});
            return;
        }
        activity.record({time: Date.now(), method: req.method, project: route.project, name: name, kind: 'packument', result: 'hit'});
        res.status(200).json(body);
    }

    private static async _serveTarball(
        proxy: RegistryProxy,
        activity: RegistryActivity,
        route: ProjectRoute,
        tarIdx: number,
        req: Request,
        res: Response
    ): Promise<void> {
        const name = decodeURIComponent(route.rest.slice(0, tarIdx));
        const file = route.rest.slice(tarIdx + 3);
        const version = RegistryProxy.versionFromTarballFile(name, file);
        if (!version) {
            res.status(400).json({error: `malformed tarball path: ${file}`});
            return;
        }
        const {status, body, source} = await proxy.getTarball(name, version);
        if (!body) {
            activity.record({time: Date.now(), method: req.method, project: route.project, name: name, version: version, kind: 'tarball', result: 'not-found'});
            res.status(status).json({error: `tarball not found: ${name}@${version}`});
            return;
        }
        activity.record({
            time: Date.now(),
            method: req.method,
            project: route.project,
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