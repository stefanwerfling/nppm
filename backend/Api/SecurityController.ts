import {
    ApiSecurityIgnoredListResponse,
    ApiSecurityIgnoredMutationRequest,
    ApiSecurityIgnoredMutationResponse,
    ApiSecurityResponse
} from '../../shared/Api/ApiTypes.js';
import {IgnoredFinding, IgnoredKind} from '../Security/IgnoredFindings.js';
import {ServerContext} from './ServerContext.js';

/**
 * Aggregated security report for one `pkg@version` — OSV.dev vuln
 * list plus the lifecycle-script heuristic plus everything the
 * SecurityScanner pulls together. Same query-param convention as the
 * fingerprint routes so scoped names survive.
 */
export class SecurityController {

    private static readonly _KNOWN_KINDS: ReadonlySet<IgnoredKind> = new Set<IgnoredKind>([
        'cve', 'script', 'pattern', 'binary', 'obfuscation',
        'maintainer', 'license', 'provenance', 'cadence', 'freshness',
        'churn', 'typosquat', 'capability', 'deprecation',
        'manifest-red-flag', 'ignore-scripts', 'external', 'integrity'
    ]);

    public static register(ctx: ServerContext): void {
        SecurityController._registerReport(ctx);
        SecurityController._registerIgnoredList(ctx);
        SecurityController._registerIgnoredAdd(ctx);
        SecurityController._registerIgnoredRemove(ctx);
    }

    private static _registerReport(ctx: ServerContext): void {
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
                const ignored = ctx.getIgnoredFindings().forPackage(name, version);
                const response: ApiSecurityResponse = {...report, ignored: ignored};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerIgnoredList(ctx: ServerContext): void {
        ctx.app.get('/api/security/ignored', (_req, res): void => {
            const response: ApiSecurityIgnoredListResponse = {
                entries: ctx.getIgnoredFindings().list()
            };
            res.status(200).json(response);
        });
    }

    private static _registerIgnoredAdd(ctx: ServerContext): void {
        ctx.app.post('/api/security/ignored', (req, res): void => {
            const entry = SecurityController._validateMutation(req.body);
            if (!entry) {
                res.status(400).json({
                    success: false,
                    msg: 'body must carry { name, version, kind, identifier?, reason? }'
                });
                return;
            }
            try {
                const next = SecurityController._upsert(ctx.getIgnoredFindings().list(), entry);
                SecurityController._persist(ctx, next);
                const response: ApiSecurityIgnoredMutationResponse = {success: true, entries: next};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    /*
     * DELETE bodies are spec-compliant but Express's body-parser
     * doesn't decode them by default — we accept the same JSON shape
     * via `POST /api/security/ignored/remove` instead, which keeps the
     * client code simple and avoids per-route middleware.
     */
    private static _registerIgnoredRemove(ctx: ServerContext): void {
        ctx.app.post('/api/security/ignored/remove', (req, res): void => {
            const entry = SecurityController._validateMutation(req.body);
            if (!entry) {
                res.status(400).json({
                    success: false,
                    msg: 'body must carry { name, version, kind, identifier? }'
                });
                return;
            }
            try {
                const current = ctx.getIgnoredFindings().list();
                const next = current.filter((e) => !SecurityController._sameEntry(e, entry));
                SecurityController._persist(ctx, next);
                const response: ApiSecurityIgnoredMutationResponse = {success: true, entries: next};
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _validateMutation(body: unknown): ApiSecurityIgnoredMutationRequest|null {
        if (typeof body !== 'object' || body === null) {
            return null;
        }
        const o = body as Record<string, unknown>;
        const name = typeof o.name === 'string' ? o.name : null;
        const version = typeof o.version === 'string' ? o.version : null;
        const kind = typeof o.kind === 'string' ? o.kind : null;
        if (!name || !version || !kind) {
            return null;
        }
        if (!SecurityController._KNOWN_KINDS.has(kind as IgnoredKind)) {
            return null;
        }
        return {
            name: name,
            version: version,
            kind: kind,
            identifier: typeof o.identifier === 'string' ? o.identifier : undefined,
            reason: typeof o.reason === 'string' ? o.reason : undefined
        };
    }

    /**
     * Two entries collide when they target the same `(name, version,
     * kind, identifier?)` quadruple — `addedAt` and `reason` are
     * metadata that doesn't enter the key, otherwise a re-ignore (e.g.
     * to update the reason) would silently insert a duplicate.
     */
    private static _sameEntry(
        a: IgnoredFinding,
        b: {name: string; version: string; kind: string; identifier?: string;}
    ): boolean {
        return a.name === b.name
            && a.version === b.version
            && a.kind === b.kind
            && (a.identifier ?? null) === (b.identifier ?? null);
    }

    private static _upsert(
        current: IgnoredFinding[],
        req: ApiSecurityIgnoredMutationRequest
    ): IgnoredFinding[] {
        const filtered = current.filter((e) => !SecurityController._sameEntry(e, req));
        const entry: IgnoredFinding = {
            name: req.name,
            version: req.version,
            kind: req.kind as IgnoredKind,
            identifier: req.identifier,
            reason: req.reason,
            addedAt: Date.now()
        };
        filtered.push(entry);
        return filtered;
    }

    private static _persist(ctx: ServerContext, entries: IgnoredFinding[]): void {
        ctx.mutateConfig((cfg) => {
            const security = (cfg as {security?: Record<string, unknown>;}).security ?? {};
            security.ignored = entries;
            (cfg as {security?: Record<string, unknown>;}).security = security;
        });
        ctx.setIgnoredFindings(entries);
    }

}