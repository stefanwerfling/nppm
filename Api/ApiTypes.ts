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

/**
 * One cell coordinate the Upgrade modal acts on. Identifies a single
 * (`workspace` or root), single dep bump. The frontend passes back
 * the dep type so the backend doesn't have to disambiguate when the
 * same name lives in both `dependencies` and `devDependencies`.
 */
export type ApiUpgradeRequest = {
    /** Workspace-relative path; empty string / undefined = root. */
    workspace?: string;
    name: string;
    /** Which bucket to mutate. Matches `DependencyType` string values. */
    depType: 'dependency'|'dev'|'peer'|'optional';
    /** Current range as the workspace declares it (sanity check). */
    fromRange: string;
    /** Target range to write (typically `^<latest>`). */
    toRange: string;
};

/**
 * Response of `POST /api/projects/:id/upgrade/preview`. The body is
 * the change-we-would-make, plus a security heads-up on the target
 * `name@latestResolved` so the user sees CVEs / fresh maintainer /
 * install scripts before clicking apply.
 */
export type ApiUpgradePreviewResponse = {
    project: {unid: string; name: string};
    /** Echoed back so the frontend can render the modal heading. */
    request: ApiUpgradeRequest;
    /**
     * Absolute path of the `package.json` we would edit. Surfaced so
     * the frontend can show it in the modal — and so a future "copy
     * shell command" hint can be specific.
     */
    packageJsonPath: string;
    /**
     * Workspace-relative path of the `package.json` (e.g.
     * `packages/api/package.json`). Empty for the root.
     */
    packageJsonRel: string;
    /** Verbatim `package.json` before/after the surgical edit. */
    before: string;
    after: string;
    /** Concrete version we resolved against `dist-tags.latest`. */
    latestResolvedVersion: string|null;
    /** Security report for the target version. `null` when registry data unavailable. */
    securityHeadsUp: SecurityReport|null;
    /** Mirrors `actions.allowInstall` so the modal can decide whether to render the install button. */
    allowInstall: boolean;
};

/**
 * SSE events for `POST /api/projects/:id/upgrade/apply` and
 * `POST /api/projects/:id/lifecycle-scripts/run`. Both streams share
 * the same shape so the frontend can use one consumer.
 *
 *   start (once) → stdout|stderr (many) → end | error
 */
export type ApiStreamStartEvent = {
    /** Human-readable command label, e.g. `npm install --ignore-scripts`. */
    command: string;
    /** Working directory the command ran in. Useful for the UI log header. */
    cwd: string;
};

export type ApiStreamChunkEvent = {
    /** UTF-8 chunk of process output. May contain partial lines. */
    chunk: string;
};

export type ApiStreamEndEvent = {
    exitCode: number|null;
};

export type ApiStreamErrorEvent = {
    msg: string;
};

/**
 * One install-time lifecycle hook that *would* run on a normal `npm
 * install`. Surfaced by `GET /api/projects/:id/lifecycle-scripts`
 * so the user knows which scripts `--ignore-scripts` skipped.
 */
export type ApiLifecycleScript = {
    name: string;
    version: string;
    /** preinstall | install | postinstall | prepare */
    hook: string;
    /** Verbatim script body so the user can decide whether it looks safe. */
    script: string;
};

export type ApiLifecycleScriptsResponse = {
    project: {unid: string; name: string};
    /** All install-lifecycle hooks across `node_modules/*`. Empty when none. */
    scripts: ApiLifecycleScript[];
    /** Whether the per-script "Run" button is enabled (mirrors `actions.allowInstall`). */
    allowInstall: boolean;
};

export type ApiLifecycleRunRequest = {
    name: string;
};