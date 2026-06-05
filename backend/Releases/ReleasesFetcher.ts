import {JsonCache} from '../Cache/JsonCache.js';
import {Registry} from '../Registry/Registry.js';
import {Release, ReleasesResponse} from './Releases.js';

/**
 * Strategy the fetcher uses to ask GitHub for releases. Default goes
 * straight to api.github.com; tests stub this.
 */
export type GithubReleasesFetcher = (
    owner: string,
    repo: string,
    token: string|undefined
) => Promise<GithubRelease[]>;

export type GithubRelease = {
    tag_name: string;
    name?: string|null;
    body?: string|null;
    html_url?: string;
    published_at?: string|null;
};

/**
 * Glue between the npm registry (version list + publish times) and
 * the GitHub Releases API (changelog body + release titles). Caching
 * is intentional: GitHub's anonymous rate limit is 60/hour and a
 * busy user can blow through that browsing one project's deps. The
 * cache pocket is plain TTL — releases for old versions are
 * append-only, so a stale cache miss-renders one or two newest
 * entries at worst.
 *
 * `{data: null}` envelope on cache hits/misses follows the same
 * convention as the OSV and remote pockets so failed fetches don't
 * retry on every page load.
 */
export class ReleasesFetcher {

    private readonly _registry: Registry;
    private readonly _cache: JsonCache|null;
    private readonly _ghFetcher: GithubReleasesFetcher;
    private readonly _ghToken: string|undefined;

    constructor(
        registry: Registry,
        cache: JsonCache|null,
        opts: {token?: string; ghFetcher?: GithubReleasesFetcher;} = {}
    ) {
        this._registry = registry;
        this._cache = cache;
        this._ghFetcher = opts.ghFetcher ?? ReleasesFetcher._defaultGithubFetcher();
        this._ghToken = opts.token;
    }

    public async fetch(name: string): Promise<ReleasesResponse|null> {
        const key = `releases_${name}`;
        type Wrap = {data: ReleasesResponse|null;};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(key);
            if (hit !== null) {
                return hit.data;
            }
        }

        const reg = await this._registry.fetchOne(name);
        if (!reg) {
            this._cache?.set<Wrap>(key, {data: null});
            return null;
        }

        const releases: Release[] = reg.versions.map((v) => ({
            version: v,
            publishedAt: reg.time?.[v] ?? null,
            publisher: reg.publishers?.[v]?.name
        }));

        // Enrich with GitHub release notes where possible.
        const gh = ReleasesFetcher.parseGithubRepo(reg.repository);
        if (gh) {
            try {
                const ghReleases = await this._ghFetcher(gh.owner, gh.repo, this._ghToken);
                const byTag = new Map<string, GithubRelease>();
                for (const r of ghReleases) {
                    byTag.set(ReleasesFetcher._normaliseTag(r.tag_name), r);
                }
                for (const rel of releases) {
                    const match = byTag.get(ReleasesFetcher._normaliseTag(rel.version));
                    if (!match) {
                        continue;
                    }
                    rel.name = match.name ?? undefined;
                    rel.body = match.body ?? undefined;
                    rel.url = match.html_url ?? undefined;
                    /*
                     * Prefer the GitHub publish timestamp when present —
                     * it's more accurate than `npm publish` time for
                     * pre-release tag dances.
                     */
                    if (!rel.publishedAt && match.published_at) {
                        rel.publishedAt = match.published_at;
                    }
                }
            } catch {
                /*
                 * GitHub failed (rate limit / network / private repo) —
                 * fall through and serve the registry-only data. Not
                 * an error from the user's perspective.
                 */
            }
        }

        /*
         * Newest publish first; entries without a timestamp slot in at
         * the bottom (their version string still gives a sort order
         * visually).
         */
        releases.sort((a, b) => {
            if (a.publishedAt && b.publishedAt) {
                return b.publishedAt.localeCompare(a.publishedAt);
            }
            if (a.publishedAt) {
                return -1;
            }
            if (b.publishedAt) {
                return 1;
            }
            return b.version.localeCompare(a.version);
        });

        const response: ReleasesResponse = {
            name: reg.name,
            description: reg.description,
            homepage: reg.homepage,
            repository: reg.repository,
            releases: releases
        };

        this._cache?.set<Wrap>(key, {data: response});
        return response;
    }

    /**
     * Default GitHub Releases transport. Anonymous unless `token` is
     * given; one paginated request, capped at 100 entries to keep the
     * rate-limit budget tight.
     */
    private static _defaultGithubFetcher(): GithubReleasesFetcher {
        return async(owner, repo, token) => {
            const headers: Record<string, string> = {
                'User-Agent': 'nppm',
                'Accept': 'application/vnd.github.v3+json'
            };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const res = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
                {headers: headers}
            );
            if (!res.ok) {
                throw new Error(`GitHub releases ${owner}/${repo} → ${res.status} ${res.statusText}`);
            }
            return (await res.json()) as GithubRelease[];
        };
    }

    /**
     * Extract `{owner, repo}` from a registry-style repository field.
     * Same shape variants as `Registry._extractRepository` — `string`
     * is either an SCP/SSH/HTTPS git URL or the npm shorthand
     * `owner/repo`. Returns `null` for anything not pointing at
     * github.com. Public so tests can exercise it without going
     * through the full fetcher.
     */
    public static parseGithubRepo(value: string|undefined): {owner: string; repo: string;}|null {
        if (!value) {
            return null;
        }
        const v = value.trim();

        // git+https:// / git://, with optional .git suffix and #fragment
        let m = /^git\+?(?:ssh|https?):\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/i.exec(v);
        if (m) {
            return {owner: m[1], repo: m[2]};
        }

        m = /^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/i.exec(v);
        if (m) {
            return {owner: m[1], repo: m[2]};
        }

        m = /^git@github\.com:([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/i.exec(v);
        if (m) {
            return {owner: m[1], repo: m[2]};
        }

        m = /^([^/\s:@]+)\/([^/\s:@]+)$/i.exec(v);
        if (m) {
            return {owner: m[1], repo: m[2]};
        }

        return null;
    }

    /**
     * Strip the leading `v` from tag names and trim — GitHub tags are
     * often `v1.2.3` while npm versions are bare `1.2.3`. Used as the
     * join key when merging GH releases onto registry versions.
     */
    private static _normaliseTag(tag: string): string {
        return tag.trim().replace(/^v/, '');
    }

}