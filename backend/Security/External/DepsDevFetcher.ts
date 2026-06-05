import {JsonCache} from '../../Cache/JsonCache.js';

/**
 * Subset of the deps.dev v3 version response we surface. The full API
 * carries dependency graphs, license SPDX, and advisory keys — we keep
 * the descriptive fields only because deps.dev's advisory feed
 * overlaps OSV (which we already query) and the dep-graph view
 * overlaps the local DepGraphBuilder.
 *
 *  - `defaultVersion` — the upstream's own "latest" pointer; flagged
 *    when the queried version is older (info-only — `Registry.latest`
 *    already drives the cross-project outdated badge).
 *  - `licenses[]` — SPDX ids as deps.dev parsed them. Useful as a
 *    cross-check against the LicenseScanner's verdict.
 *  - `projects[]` — known upstream project pages (GitHub URL, etc.) —
 *    handy for the PackageDetailPanel "external links" line.
 *  - `advisoryKeys[]` — OSV ids; folded into the panel for reference
 *    even though OsvClient is the primary source.
 */
export type DepsDevVersion = {
    versionKey: {system: string; name: string; version: string;};
    defaultVersion: string|null;
    isDefault: boolean;
    licenses: string[];
    projects: {type: string; name: string;}[];
    advisoryKeys: string[];
    publishedAt: string|null;
};

type Wrap = {data: DepsDevVersion|null;};

/**
 * Fetches package-version metadata from deps.dev (Google's open-source
 * package index). No auth, rate-limited per IP. Lookups that 404
 * cache as the `null` envelope.
 */
export class DepsDevFetcher {

    private readonly _cache: JsonCache;
    private readonly _baseUrl: string;

    constructor(cache: JsonCache, baseUrl = 'https://api.deps.dev') {
        this._cache = cache;
        this._baseUrl = baseUrl.replace(/\/$/, '');
    }

    public async fetch(name: string, version: string): Promise<DepsDevVersion|null> {
        if (!name || !version) {
            return null;
        }
        const key = DepsDevFetcher._cacheKey(name, version);
        const cached = this._cache.get<Wrap>(key);
        if (cached) {
            return cached.data;
        }

        const result = await this._fetchLive(name, version);
        this._cache.set<Wrap>(key, {data: result});
        return result;
    }

    private async _fetchLive(name: string, version: string): Promise<DepsDevVersion|null> {
        try {
            const url = `${this._baseUrl}/v3/systems/npm/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
            const res = await fetch(url, {headers: {Accept: 'application/json'}});
            if (!res.ok) {
                return null;
            }
            const raw = await res.json() as unknown;
            return DepsDevFetcher.parseVersion(raw);
        } catch {
            return null;
        }
    }

    /**
     * Parse the v3 version response. Public for tests. deps.dev returns
     * a wide envelope — we narrow it to the half-dozen fields the
     * scanner consumes. Anything missing falls back to a permissive
     * empty value so partial responses still yield a usable record.
     */
    public static parseVersion(raw: unknown): DepsDevVersion|null {
        if (!raw || typeof raw !== 'object') {
            return null;
        }
        const obj = raw as Record<string, unknown>;
        const vk = obj.versionKey as Record<string, unknown>|undefined;
        if (!vk || typeof vk.name !== 'string' || typeof vk.version !== 'string') {
            return null;
        }
        const projectsRaw = Array.isArray(obj.relatedProjects) ? obj.relatedProjects : [];
        const projects: DepsDevVersion['projects'] = [];
        for (const p of projectsRaw) {
            if (!p || typeof p !== 'object') {
                continue;
            }
            const pp = p as Record<string, unknown>;
            const name = typeof pp.projectKey === 'object' && pp.projectKey !== null
                ? (pp.projectKey as Record<string, unknown>).name
                : pp.name;
            const type = typeof pp.relationType === 'string' ? pp.relationType : 'related';
            if (typeof name === 'string') {
                projects.push({type: type, name: name});
            }
        }
        const licenses: string[] = Array.isArray(obj.licenses)
            ? (obj.licenses as unknown[]).filter((l): l is string => typeof l === 'string')
            : [];
        const advisoryKeysRaw = Array.isArray(obj.advisoryKeys) ? obj.advisoryKeys : [];
        const advisoryKeys: string[] = [];
        for (const a of advisoryKeysRaw) {
            if (a && typeof a === 'object') {
                const id = (a as Record<string, unknown>).id;
                if (typeof id === 'string') {
                    advisoryKeys.push(id);
                }
            } else if (typeof a === 'string') {
                advisoryKeys.push(a);
            }
        }
        const publishedAt = typeof obj.publishedAt === 'string' ? obj.publishedAt : null;
        const defaultVersionRaw = obj.defaultVersion;
        const defaultVersion = typeof defaultVersionRaw === 'string' && defaultVersionRaw.length > 0
            ? defaultVersionRaw
            : null;
        const isDefault = obj.isDefault === true || defaultVersion === vk.version;
        return {
            versionKey: {
                system: typeof vk.system === 'string' ? vk.system as string : 'NPM',
                name: vk.name as string,
                version: vk.version as string
            },
            defaultVersion: defaultVersion,
            isDefault: isDefault,
            licenses: licenses,
            projects: projects,
            advisoryKeys: advisoryKeys,
            publishedAt: publishedAt
        };
    }

    private static _cacheKey(name: string, version: string): string {
        return `depsdev_${name}@${version}`;
    }

}