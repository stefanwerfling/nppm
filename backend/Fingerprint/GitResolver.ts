export type GitTarballSpec = {
    /** Direct tarball URL we can `fetch()` from. */
    url: string;
    /** Hint for diagnostics — the URL the user wrote. */
    source: string;
};

/**
 * Generic, host-agnostic shape of a parsed git dependency string. The
 * HEAD-info + commits fetchers consume this instead of re-parsing the
 * URL themselves so adding a new host adds one match below, not three
 * regexes spread across files.
 */
export type GitDepInfo = {
    host: 'github'|'gitlab'|'bitbucket'|'gitea';
    /** Bare host name (`github.com`, `gitea.example.com`, …). */
    hostname: string;
    owner: string;
    repo: string;
    /** Fragment after `#`, or `null` when the user pinned no ref. */
    ref: string|null;
};

type HostHandler = {
    patterns: {regex: RegExp;}[];
    tarball: (owner: string, repo: string, ref: string|undefined, source: string) => GitTarballSpec;
};

/**
 * Default ref when the dependency string didn't carry one. All three
 * hosts accept `HEAD` as a literal ref in their archive endpoints, so
 * we don't need to know the project's default branch up-front.
 */
const DEFAULT_REF = 'HEAD';

const HOSTS: HostHandler[] = [
    // GitHub — codeload backend.
    {
        patterns: [
            {regex: /^git\+https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^git\+ssh:\/\/git@github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^git@github\.com:([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^github:([^/]+)\/([^/#]+?)(?:#(.+))?$/i}
        ],
        tarball: (owner, repo, ref, source) => ({
            url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref || DEFAULT_REF}`,
            source: source
        })
    },
    /*
     * GitLab — archive endpoint. Filename has to be `<repo>-<ref>.tar.gz`;
     * GitLab will redirect a wrong filename, but to keep things tidy we
     * build the expected one.
     */
    {
        patterns: [
            {regex: /^git\+https?:\/\/gitlab\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^git\+ssh:\/\/git@gitlab\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^git@gitlab\.com:([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^gitlab:([^/]+)\/([^/#]+?)(?:#(.+))?$/i}
        ],
        tarball: (owner, repo, ref, source) => {
            const target = ref || DEFAULT_REF;
            return {
                url: `https://gitlab.com/${owner}/${repo}/-/archive/${target}/${repo}-${target}.tar.gz`,
                source: source
            };
        }
    },
    // Bitbucket — `/get/<ref>.tar.gz` endpoint.
    {
        patterns: [
            {regex: /^git\+https?:\/\/bitbucket\.org\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^git\+ssh:\/\/git@bitbucket\.org\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^git@bitbucket\.org:([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i},
            {regex: /^bitbucket:([^/]+)\/([^/#]+?)(?:#(.+))?$/i}
        ],
        tarball: (owner, repo, ref, source) => ({
            url: `https://bitbucket.org/${owner}/${repo}/get/${ref || DEFAULT_REF}.tar.gz`,
            source: source
        })
    }
];

/**
 * Resolver for the four git-style dependency strings npm understands
 * (`git+https://…`, `git+ssh://…`, `git@host:…`, `github:owner/repo`).
 * Pure static — there is no per-resolver state.
 */
export class GitResolver {

    /**
     * Detect whether a dependency `version` string points at a git ref
     * rather than a published-to-registry semver. Covers all four npm
     * shapes; `git://` (plain) is accepted too even though most hosts
     * have moved on.
     */
    public static isGitVersion(version: string): boolean {
        const v = version.trim();
        return /^(git\+|git:\/\/|git@|github:|gitlab:|bitbucket:)/i.test(v);
    }

    /**
     * Resolve a git-style dependency string to a downloadable tarball
     * URL. Returns `null` when the URL belongs to a host we don't
     * (yet) know how to fetch from — caller treats that the same as
     * "tarball unavailable".
     *
     * Currently supported: github.com (codeload), gitlab.com (archive
     * endpoint), bitbucket.org (`/get/` endpoint). Any host listed in
     * `giteaHosts` resolves via Gitea's `/<owner>/<repo>/archive/<ref>.tar.gz`
     * endpoint.
     */
    public static resolveTarball(version: string, giteaHosts: string[] = []): GitTarballSpec|null {
        const v = version.trim();

        for (const host of HOSTS) {
            for (const pat of host.patterns) {
                const m = pat.regex.exec(v);
                if (m) {
                    return host.tarball(m[1], m[2], m[3], v);
                }
            }
        }

        const giteaInfo = GitResolver._parseGitea(v, giteaHosts);
        if (giteaInfo) {
            const ref = giteaInfo.ref ?? DEFAULT_REF;
            return {
                url: `https://${giteaInfo.hostname}/${giteaInfo.owner}/${giteaInfo.repo}/archive/${ref}.tar.gz`,
                source: v
            };
        }

        return null;
    }

    /**
     * Host-agnostic parse. Returns `null` for shapes we don't know how
     * to dispatch on. Same set of recognised hosts as
     * {@link resolveTarball}; both methods stay in sync so a URL the
     * tarball resolver succeeds on also produces a `GitDepInfo`.
     */
    public static parse(version: string, giteaHosts: string[] = []): GitDepInfo|null {
        const v = version.trim();
        const known = GitResolver._parseKnown(v);
        if (known) {
            return known;
        }
        return GitResolver._parseGitea(v, giteaHosts);
    }

    private static _parseKnown(v: string): GitDepInfo|null {
        /*
         * Each host's patterns capture (owner, repo, ref?). The shape
         * mirrors `HOSTS` above — we don't reuse the entries directly
         * because they're keyed on tarball construction, not on the
         * host name we need to report.
         */
        const matchers: {host: GitDepInfo['host']; hostname: string; res: RegExp[];}[] = [
            {host: 'github', hostname: 'github.com', res: [
                /^git\+https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^git\+ssh:\/\/git@github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^git@github\.com:([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^github:([^/]+)\/([^/#]+?)(?:#(.+))?$/i
            ]},
            {host: 'gitlab', hostname: 'gitlab.com', res: [
                /^git\+https?:\/\/gitlab\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^git\+ssh:\/\/git@gitlab\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^git@gitlab\.com:([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^gitlab:([^/]+)\/([^/#]+?)(?:#(.+))?$/i
            ]},
            {host: 'bitbucket', hostname: 'bitbucket.org', res: [
                /^git\+https?:\/\/bitbucket\.org\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^git\+ssh:\/\/git@bitbucket\.org\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^git@bitbucket\.org:([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i,
                /^bitbucket:([^/]+)\/([^/#]+?)(?:#(.+))?$/i
            ]}
        ];
        for (const m of matchers) {
            for (const re of m.res) {
                const r = re.exec(v);
                if (r) {
                    return {host: m.host, hostname: m.hostname, owner: r[1], repo: r[2], ref: r[3] ?? null};
                }
            }
        }
        return null;
    }

    private static _parseGitea(v: string, giteaHosts: string[]): GitDepInfo|null {
        if (giteaHosts.length === 0) {
            return null;
        }
        /*
         * Accept the same four shapes as the known hosts, but with the
         * hostname pinned by the caller's allow-list. The leading
         * host-shorthand (`gitea:owner/repo`) is intentionally out —
         * there is no single Gitea instance to map it to.
         */
        for (const host of giteaHosts) {
            const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const patterns = [
                new RegExp(`^git\\+https?:\\/\\/${escaped}\\/([^/]+)\\/([^/#]+?)(?:\\.git)?(?:#(.+))?$`, 'i'),
                new RegExp(`^git\\+ssh:\\/\\/git@${escaped}\\/([^/]+)\\/([^/#]+?)(?:\\.git)?(?:#(.+))?$`, 'i'),
                new RegExp(`^git@${escaped}:([^/]+)\\/([^/#]+?)(?:\\.git)?(?:#(.+))?$`, 'i')
            ];
            for (const re of patterns) {
                const r = re.exec(v);
                if (r) {
                    return {host: 'gitea', hostname: host, owner: r[1], repo: r[2], ref: r[3] ?? null};
                }
            }
        }
        return null;
    }

}