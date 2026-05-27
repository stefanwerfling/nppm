/**
 * Detect whether a dependency `version` string points at a git ref
 * rather than a published-to-registry semver. Covers the four shapes
 * npm understands natively:
 *
 *  - `git+https://host/owner/repo.git[#ref]`
 *  - `git+ssh://git@host/owner/repo.git[#ref]`
 *  - `git@host:owner/repo.git[#ref]`
 *  - `github:owner/repo[#ref]` (and the `gitlab:` / `bitbucket:` cousins)
 *
 * `git://` (plain) is also accepted for completeness — npm still
 * resolves it, even though most hosts have moved on.
 */
export function isGitVersion(version: string): boolean {
    const v = version.trim();
    return /^(git\+|git:\/\/|git@|github:|gitlab:|bitbucket:)/i.test(v);
}

export type GitTarballSpec = {
    /** Direct tarball URL we can `fetch()` from. */
    url: string;
    /** Hint for diagnostics — the URL the user wrote. */
    source: string;
};

/**
 * Resolve a git-style dependency string to a downloadable tarball URL.
 * Returns `null` when the URL belongs to a host we don't (yet) know
 * how to fetch from — caller treats that the same as "tarball
 * unavailable".
 *
 * Currently supported: github.com (codeload), gitlab.com (archive
 * endpoint), bitbucket.org (`/get/` endpoint). All three serve public
 * repos without auth and without a User-Agent header.
 */
export function resolveGitTarball(version: string): GitTarballSpec|null {
    const v = version.trim();

    for (const host of HOSTS) {
        for (const pat of host.patterns) {
            const m = pat.regex.exec(v);
            if (m) {
                return host.tarball(m[1], m[2], m[3], v);
            }
        }
    }

    return null;
}

type HostHandler = {
    patterns: {regex: RegExp}[];
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
            source
        })
    },
    // GitLab — archive endpoint. Filename has to be `<repo>-<ref>.tar.gz`;
    // GitLab will redirect a wrong filename, but to keep things tidy we
    // build the expected one.
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
                source
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
            source
        })
    }
];