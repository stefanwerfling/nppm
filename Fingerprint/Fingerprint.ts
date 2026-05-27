/**
 * One file inside a package tarball. `path` is the entry's name *with*
 * the package's top-level prefix stripped (`package/`, `cookie-parser/`,
 * …), so the same logical file in two tarballs has the same `path`
 * regardless of how the tarball framed it.
 *
 * `content` is populated only for files the Phase-5 heuristic scanner
 * needs to read: JS source (`.js`/`.mjs`/`.cjs`), non-binary, under a
 * size cap. Everything else (TypeScript declarations, READMEs, large
 * minified bundles) gets only the hash + size to keep cache size
 * bounded — the diff still works since identity is keyed off `sha256`.
 */
export type FileFingerprint = {
    path: string;
    sha256: string;
    size: number;
    content?: string;
};

/**
 * Slice of a tarball's `package.json` that the rest of the app cares
 * about. Pulled out at fingerprint time so neither the deps tab nor
 * (later) the Phase-5 scanner needs to re-download the tarball just to
 * read a few fields. `null` means the tarball had no parseable
 * `package.json` — exotic, but we don't want to crash on it.
 */
export type PackageFingerprintManifest = {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
    scripts: Record<string, string>;
};

/**
 * Hash-level fingerprint of one published `pkg@version`. Files are
 * sorted by `path` so the JSON representation is stable and two
 * fingerprints can be diffed positionally if desired (the diff
 * implementation here uses a map, so order is informational only).
 *
 * `fetchedAt` is the unix-ms timestamp the tarball was downloaded —
 * useful when reporting fingerprints, since the package contents are
 * immutable but the *registry* state at fetch time is not (e.g. an
 * unpublish).
 */
export type PackageFingerprint = {
    name: string;
    version: string;
    files: FileFingerprint[];
    manifest: PackageFingerprintManifest|null;
    fetchedAt: number;
};

/**
 * Difference between two fingerprints. `modified` lists files that
 * exist in both but whose sha256 changed. The lists are sorted by
 * `path` for deterministic output.
 */
export type FingerprintDiff = {
    added: FileFingerprint[];
    removed: FileFingerprint[];
    modified: {
        path: string;
        before: FileFingerprint;
        after: FileFingerprint;
    }[];
};