import {JsonCache} from '../Cache/JsonCache.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {TarballParser} from '../Fingerprint/TarballParser.js';

/**
 * Result of asking a git host "what does HEAD look like right now?".
 * Both fields may be null when the URL was resolveable but the
 * tarball didn't expose the data — we still cache the negative so we
 * don't refetch on every panel open.
 */
export type GitHeadInfo = {
    /** `package.json.version` from the HEAD tree. */
    version: string|null;
    /** Full commit SHA when the host encodes it in the tarball top
     * folder (GitHub codeload), otherwise null. */
    sha: string|null;
    /** Short SHA convenience. `null` when `sha` is. */
    shortSha: string|null;
    /**
     * User-readable reason the HEAD lookup couldn't complete. Set on
     * transient (network unreachable) and concrete (repo not found)
     * failures so the UI can surface an info icon next to the "git"
     * pill. Unset on success and on cases we want to stay silent for
     * (e.g. unsupported host — caller returns `null` instead).
     */
    error?: string;
};

/**
 * Strategy for fetching the tarball bytes. Default uses `fetch`; tests
 * inject a stub keyed by the resolved tarball URL.
 */
export interface HeadTarballFetcher {
    fetch(url: string): Promise<Buffer|null>;
}

/**
 * Resolve a git-style dependency URL to its current HEAD `{version,
 * sha}`. The result feeds the matrix "git latest" column and the
 * PackageDetailPanel's diff-against-HEAD comparison.
 *
 * Cache is intentionally TTL'd (HEAD moves) — the JsonCache pocket
 * passed in should be the same one that backs `releases/`, not the
 * permanent fingerprint cache. The `{data: ...}` envelope mirrors the
 * other TTL pockets so a cached "no data" stays sticky for the
 * window.
 */
export class GitHeadFetcher {

    private readonly _cache: JsonCache|null;
    private readonly _fetcher: HeadTarballFetcher;
    private readonly _giteaHosts: string[];

    constructor(
        cache: JsonCache|null,
        opts: {giteaHosts?: string[]; fetcher?: HeadTarballFetcher} = {}
    ) {
        this._cache = cache;
        this._giteaHosts = opts.giteaHosts ?? [];
        this._fetcher = opts.fetcher ?? GitHeadFetcher._defaultFetcher();
    }

    public async fetch(gitUrl: string): Promise<GitHeadInfo|null> {
        const v = gitUrl.trim();
        const key = `githead_${v}`;
        type Wrap = {data: GitHeadInfo|null};

        if (this._cache) {
            const hit = this._cache.get<Wrap>(key);
            if (hit !== null) {
                return hit.data;
            }
        }

        const parsed = GitResolver.parse(v, this._giteaHosts);
        if (!parsed) {
            this._cache?.set<Wrap>(key, {data: null});
            return null;
        }
        // Force the HEAD ref regardless of what the user pinned —
        // we want "what's at the tip right now", not "what was at the
        // tip when this version was tagged". Reuse `resolveTarball`
        // with a synthetic URL that drops the user's `#ref` and so
        // collapses to the host's DEFAULT_REF (`HEAD`).
        const headUrl = `git+https://${parsed.hostname}/${parsed.owner}/${parsed.repo}.git`;
        const spec = GitResolver.resolveTarball(headUrl, this._giteaHosts);
        if (!spec) {
            this._cache?.set<Wrap>(key, {data: null});
            return null;
        }

        let tgz: Buffer|null;
        try {
            tgz = await this._fetcher.fetch(spec.url);
        } catch (e) {
            // Network / 5xx — surface the failure to the UI so the
            // user can tell "no info because host is down" apart
            // from "no info because we never looked", but skip the
            // cache so a next page load can transparently retry.
            return {
                version: null,
                sha: null,
                shortSha: null,
                error: `${GitHeadFetcher._hostLabel(parsed.host)} unreachable: ${(e as Error).message}`
            };
        }
        if (!tgz) {
            // 404 — repository really doesn't exist (or was made
            // private / renamed). Cache the negative so we don't
            // hammer the host on every paint; the user can clear the
            // cache pocket once they fix the URL.
            const info: GitHeadInfo = {
                version: null,
                sha: null,
                shortSha: null,
                error: `Repository not found on ${GitHeadFetcher._hostLabel(parsed.host)}`
            };
            this._cache?.set<Wrap>(key, {data: info});
            return info;
        }

        const {entries, prefix} = TarballParser.parseWithPrefix(tgz);
        const pkgJson = entries.find((e) => e.path === 'package.json');
        let version: string|null = null;
        if (pkgJson) {
            try {
                const parsedJson = JSON.parse(pkgJson.content.toString('utf-8')) as {version?: unknown};
                if (typeof parsedJson.version === 'string' && parsedJson.version.length > 0) {
                    version = parsedJson.version;
                }
            } catch {
                // Malformed package.json — keep version null, still
                // surface the SHA below.
            }
        }
        const sha = GitHeadFetcher._extractSha(prefix, parsed.repo);
        const info: GitHeadInfo = {
            version,
            sha,
            shortSha: sha ? sha.slice(0, 7) : null
        };
        this._cache?.set<Wrap>(key, {data: info});
        return info;
    }

    /**
     * Pull the commit SHA out of the tarball's top-level folder. Each
     * host names it differently:
     *  - GitHub codeload: `<repo>-<sha>` (40 hex chars) for SHA/HEAD
     *  - GitLab archive: `<repo>-<ref>-<sha>` (legacy) or `<repo>-<ref>`
     *  - Bitbucket: `<owner>-<repo>-<short-sha>`
     *  - Gitea archive: `<repo>` (no SHA encoded — falls through to null)
     *
     * We err on the side of "only return if it really looks like a hex
     * SHA" so we don't surface a branch name as a fake fingerprint.
     */
    private static _extractSha(prefix: string|null, repo: string): string|null {
        if (!prefix) {
            return null;
        }
        const repoPrefix = `${repo}-`;
        if (prefix.startsWith(repoPrefix)) {
            const tail = prefix.slice(repoPrefix.length);
            if (/^[0-9a-f]{40}$/i.test(tail)) {
                return tail.toLowerCase();
            }
            // Bitbucket-style trailing 12-char hex
            const m = /-([0-9a-f]{12,40})$/i.exec(tail);
            if (m) {
                return m[1].toLowerCase();
            }
        }
        return null;
    }

    /**
     * Human-readable label for the four known hosts. Pure cosmetic —
     * used to compose error messages like "GitHub unreachable" rather
     * than "github unreachable".
     */
    private static _hostLabel(host: 'github'|'gitlab'|'bitbucket'|'gitea'): string {
        switch (host) {
            case 'github': return 'GitHub';
            case 'gitlab': return 'GitLab';
            case 'bitbucket': return 'Bitbucket';
            case 'gitea': return 'Gitea';
        }
    }

    private static _defaultFetcher(): HeadTarballFetcher {
        return {
            async fetch(url: string): Promise<Buffer|null> {
                const res = await fetch(url, {headers: {'User-Agent': 'nppm'}});
                if (res.status === 404) {
                    return null;
                }
                if (!res.ok) {
                    throw new Error(`HEAD tarball ${url} → ${res.status} ${res.statusText}`);
                }
                return Buffer.from(await res.arrayBuffer());
            }
        };
    }
}