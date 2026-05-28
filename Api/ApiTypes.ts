import {ConfigProjectType} from '../Config/Config.js';
import {DepGraphResponse} from '../DepGraph/DepGraphBuilder.js';
import {FingerprintDiff, PackageFingerprint} from '../Fingerprint/Fingerprint.js';
import {HistoryEntry} from '../History/History.js';
import {ProjectMatrixResponse} from '../Matrix/ProjectMatrixBuilder.js';
import {Lockfile} from '../Project/Lockfile.js';
import {PackageDependency} from '../Project/PackageManifest.js';
import {ReleasesResponse} from '../Releases/Releases.js';
import {HeuristicsBatchEntry, SecurityReport} from '../Security/SecurityScanner.js';
import {UnusedReport} from '../Unused/UnusedReport.js';

/**
 * One project as returned by `GET /api/projects`. `error` is populated
 * when the project failed to load (missing package.json, JSON parse
 * error, future: network failure for remote sources).
 */
export type ApiProject = {
    unid: string;
    name: string;
    type: ConfigProjectType;
    packageCount: number;
    workspaceCount: number;
    error?: string;
};

export type ApiProjectsResponse = {
    projects: ApiProject[];
};

/**
 * One manifest as returned by `GET /api/projects/:id/packages`. Workspace
 * is omitted for the root manifest.
 */
export type ApiManifest = {
    name: string;
    version: string;
    workspace?: string;
    dependencies: PackageDependency[];
};

export type ApiPackagesResponse = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    manifests: ApiManifest[];
};

/**
 * Response shape of `GET /api/projects/:id/lockfile`. `lockfile: null`
 * means the project has no committed `package-lock.json` (libraries
 * without a lock, remote projects we didn't pull, etc) — distinct from
 * a parse error, which surfaces as a non-2xx status.
 */
export type ApiLockfileResponse = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    lockfile: Lockfile|null;
};

/**
 * Response of `GET /api/projects/:id/history`. Entries are sorted
 * newest-first for direct rendering in the UI.
 */
export type ApiHistoryResponse = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    entries: HistoryEntry[];
};

/**
 * Per-project matrix view — wraps the builder's shape directly. The
 * declared-dependency view across one project's workspaces, with a
 * trailing Latest column.
 */
export type ApiProjectMatrixResponse = ProjectMatrixResponse;

/**
 * Flat dep-graph response. Wraps the builder's shape; the UI walks
 * it on-demand to assemble the D3 collapsible tree.
 */
export type ApiDepGraphResponse = DepGraphResponse;

/**
 * Response shape of `GET /api/releases?name=<name>`. `null` is
 * surfaced as a 404; otherwise the body is the full list of releases
 * (newest first, optionally enriched with GitHub release notes).
 */
export type ApiReleasesResponse = ReleasesResponse;

/**
 * Event payloads for the SSE stream `/api/projects/:id/lockfile/analyze`.
 * Frontend listens per event name; the order is roughly:
 *
 *   start (once) →
 *   [result, result, …, progress] × chunks →
 *   end | error
 */
export type ApiAnalyzeStartEvent = {
    total: number;
};

export type ApiAnalyzeResultEvent = {
    name: string;
    version: string;
    vulnIds: string[]|null;
    // Project sources where this exact `name@version` was found. Only
    // populated by the global stream; the per-project stream omits it
    // (the project is implicit there).
    projects?: string[];
};

export type ApiAnalyzeProgressEvent = {
    current: number;
    total: number;
    // Optional human-readable phase label ("Collecting packages from
    // kavula …", "Scanning CVEs …"). Used by the global scan, ignored
    // by the per-project one.
    phase?: string;
};

export type ApiAnalyzeEndEvent = {
    total: number;
};

export type ApiAnalyzeErrorEvent = {
    msg: string;
};

/**
 * Response shape of `GET /api/fingerprint`. `fingerprint: null` means
 * the registry returned 404 for that `pkg@version` (e.g. an unpublished
 * version) — distinct from an HTTP error, which surfaces as a non-2xx
 * status.
 */
export type ApiFingerprintResponse = {
    fingerprint: PackageFingerprint|null;
};

/**
 * Response shape of `GET /api/fingerprint/diff`. `diff` is null when
 * either side could not be fingerprinted (`before` and `after` always
 * echo the requested coordinates so the client can render a header
 * even on the null case).
 */
export type ApiFingerprintDiffResponse = {
    before: {name: string; version: string};
    after: {name: string; version: string};
    diff: FingerprintDiff|null;
};

/**
 * Response shape of `GET /api/security`. Mirrors `SecurityReport` 1:1
 * — kept as its own type so the API surface stays explicit in
 * `ApiTypes.ts` rather than hiding inside the scanner module.
 */
export type ApiSecurityResponse = SecurityReport;

/**
 * Batched lightweight vuln lookup used by the matrix badge. `vulnIds`
 * is what the OSV batch endpoint actually returns — just identifiers,
 * enough to count and link out. `null` means OSV could not be reached
 * for that specific package.
 */
export type ApiMatrixSecurityEntry = {
    name: string;
    version: string;
    vulnIds: string[]|null;
};

export type ApiMatrixSecurityRequest = {
    packages: {name: string; version: string}[];
};

export type ApiMatrixSecurityResponse = {
    results: ApiMatrixSecurityEntry[];
};

/**
 * Body and response of the bulk fingerprint-derived heuristics
 * endpoint — covers both lifecycle scripts and code-pattern matches
 * (extracted from the same fingerprint). Cold start downloads tarballs
 * (slow); warm runs hit the permanent fingerprint cache and return in
 * milliseconds.
 */
export type ApiMatrixHeuristicsRequest = {
    packages: {name: string; version: string}[];
};

export type ApiMatrixHeuristicsResponse = {
    results: HeuristicsBatchEntry[];
};

/**
 * Response shape of `GET /api/projects/:id/unused`. Mirrors
 * `UnusedReport` 1:1 — kept as its own type so the API surface stays
 * explicit in `ApiTypes.ts`. `supported: false` is the sentinel for
 * remote (GitHub/Gitea) projects which the v1 detector doesn't scan.
 */
export type ApiUnusedResponse = UnusedReport;