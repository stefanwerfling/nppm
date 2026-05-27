/**
 * One row in the releases tab. Always carries `version` and (when the
 * registry knows) `publishedAt`. The richer fields (`name`, `body`,
 * `url`) come from the GitHub Releases API and are only populated for
 * packages whose `repository` resolves to a github.com repo. For
 * gitlab/bitbucket/other hosts they stay `undefined` — the UI still
 * renders the row, just without notes.
 */
export type Release = {
    version: string;
    publishedAt: string|null;
    name?: string;
    body?: string;
    url?: string;
};

export type ReleasesResponse = {
    name: string;
    description?: string;
    homepage?: string;
    repository?: string;
    /** Sorted newest-first by `publishedAt`. */
    releases: Release[];
};