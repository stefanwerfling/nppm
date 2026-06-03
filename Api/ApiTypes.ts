import {ConfigProjectType} from '../Config/Config.js';
import {DepGraphResponse} from '../DepGraph/DepGraphBuilder.js';
import {FingerprintDiff, PackageFingerprint} from '../Fingerprint/Fingerprint.js';
import {HistoryEntry} from '../History/History.js';
import {ProjectMatrixResponse} from '../Matrix/ProjectMatrixBuilder.js';
import {Lockfile} from '../Project/Lockfile.js';
import {PackageDependency} from '../Project/PackageManifest.js';
import {ReleasesResponse} from '../Releases/Releases.js';
import {IntegrityFinding, IntegritySeverity, IntegritySummary} from '../Security/IntegrityScanner.js';
import {DashboardCell, DashboardColumn, DashboardResponse, ScannerId} from '../Dashboard/DashboardBuilder.js';
import {ImpactReport} from '../Security/ImpactAnalyzer.js';
import {HeuristicsBatchEntry, SecurityReport} from '../Security/SecurityScanner.js';
import {PrReviewReport} from '../PrReview/PrReview.js';
import {UnusedReport} from '../Unused/UnusedReport.js';
import {VulnerabilityTimelineResponse} from '../Vulnerability/Timeline.js';

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
    /**
     * Absolute on-disk root for local projects. Used by the frontend
     * to build `vscode://file/<root>/node_modules/<pkg>` style URLs
     * for the "Open in IDE" affordance. Omitted for remote projects
     * (their files aren't on the user's machine).
     */
    root?: string;
    /**
     * `true` when the project is excluded from the cross-project
     * matrix (per-project drill-down still works). Toggled via
     * `PATCH /api/projects/:id/visibility`; persisted as
     * `hidden: true` in nppm.json.
     */
    hidden?: boolean;
    error?: string;
};

export type ApiProjectsResponse = {
    projects: ApiProject[];
    /**
     * `actions.editor` from `nppm.json` — see `Frontend/EditorUrl.ts`
     * for the supported keys. `undefined` when not configured;
     * frontend then hides every "Open in IDE" button.
     */
    editor?: string;
};

/**
 * Body shape for `POST /api/projects` and `PUT /api/projects/:id`.
 * The `type` discriminator decides which other fields are required;
 * unused-for-the-type fields are ignored by the backend so the
 * frontend can keep them in the form without consequence.
 */
export type ApiProjectMutationRequest = {
    type: ConfigProjectType;
    name?: string;
    hidden?: boolean;
    /**
     * Ordered list of template ids the project should be checked
     * against. Phase-1 Templates feature — empty / absent means no
     * compliance check.
     */
    templates?: string[];
    // local
    path?: string;
    // github
    repo?: string;
    // gitea
    url?: string;
    // remote-shared
    ref?: string;
    token?: string;
};

/**
 * Full raw config entry for one project — used by the edit modal
 * to pre-fill its fields. Type-specific keys are present per the
 * project's `type`; everything is optional so the wire shape is
 * stable across types.
 */
export type ApiProjectConfigResponse = ApiProjectMutationRequest;

export type ApiProjectMutationResponse = {
    success: boolean;
    project?: ApiProject;
    msg?: string;
};

/**
 * The non-`projects` sections of `nppm.json`, surfaced verbatim by
 * `GET /api/config` and accepted as a full replacement by
 * `PUT /api/config`. Everything is optional so omitting a section
 * (or a single field) clears it from `nppm.json` on write.
 */
export type ApiConfigSettings = {
    server?: {
        port?: number;
        limit?: string;
    };
    browser?: {
        open?: boolean;
    };
    registry?: {
        url?: string;
        auth?: string;
    };
    cache?: {
        dir?: string;
        ttlMinutes?: number;
    };
    actions?: {
        allowInstall?: boolean;
        editor?: string;
    };
    security?: {
        maintainer?: {
            quickHandoverDays?: number;
            suspiciousGapDays?: number;
            matureVersions?: number;
            trustWindow?: number;
        };
        license?: {
            allowlist?: string[];
            denylist?: string[];
            treatUnknownAs?: string;
        };
        unused?: {
            allowlist?: string[];
            devPathGlobs?: string[];
        };
    };
};

export type ApiConfigResponse = ApiConfigSettings;
export type ApiConfigMutationRequest = ApiConfigSettings;
export type ApiConfigMutationResponse = {
    success: boolean;
    msg?: string;
};

/**
 * Response of `POST /api/cache/clear` — deletes every file in the
 * cache directory (registry / fingerprint / releases / security /
 * osv / bundlephobia / templates-remote / …) while preserving the
 * directory structure so the in-memory JsonCache instances keep
 * working. `.nppm-history/` lives outside the cache and is never
 * touched.
 */
export type ApiCacheClearResponse = {
    success: boolean;
    /** Number of files removed across all cache pockets. */
    removed: number;
    msg?: string;
};

/**
 * One directory entry returned by `GET /api/fs/browse`. The picker
 * navigates only into `dir` entries; `file` rows show up as
 * visual context (when `?withFiles=1`) and are not actionable.
 */
export type ApiFsBrowseEntry = {
    name: string;
    type: 'dir'|'file';
};

/**
 * Response shape of `GET /api/fs/browse?path=<absolute>[&showHidden=1]`.
 * `path` echoes the absolute directory we just listed; `parent` is its
 * absolute parent or `null` at the filesystem root. Entries are sorted
 * case-insensitively by name; per-entry EACCES errors are swallowed so
 * the row simply disappears rather than failing the whole request.
 */
export type ApiFsBrowseResponse = {
    path: string;
    parent: string|null;
    entries: ApiFsBrowseEntry[];
};

/**
 * Lightweight summary of one template as listed by `GET /api/templates`.
 * Carries just enough to render the Templates view header (id / name /
 * `extends`); the full rule set is only relevant once the user drills
 * into per-project compliance.
 */
export type ApiTemplateSummary = {
    id: string;
    name: string;
    extends: string[];
    mode: 'additive'|'strict';
    runtimeCount: number;
    devCount: number;
    peerCount: number;
    optionalCount: number;
    forbiddenCount: number;
    hasRoot: boolean;
    /**
     * Where the template was loaded from. `remote` templates are
     * read-only — the UI hides Edit/Delete and CRUD routes refuse
     * to mutate them. `sourceUrl` is the URL the loader fetched
     * the body from (only set when `source === 'remote'`).
     */
    source: 'local'|'remote';
    sourceUrl?: string;
};

export type ApiTemplatesResponse = {
    templates: ApiTemplateSummary[];
};

/**
 * One finding from the compliance check. Mirrors `ComplianceFinding`
 * 1:1 — kept as its own type so the API surface stays explicit.
 */
export type ApiComplianceFinding = {
    kind: 'missing'|'divergent'|'forbidden'|'extra'|'bucket-wrong'
        |'root-missing'|'root-divergent'
        |'file-missing'|'file-drift'|'workspace-missing';
    severity: 'info'|'warn'|'risk';
    target: string;
    expected?: string;
    actual?: string;
    sourceId: string;
};

/**
 * Response of `GET /api/projects/:id/compliance`. `templateIds` is the
 * resolved chain (after extends-flatten + per-project merge order);
 * `findings` is the flat list (UI groups by `kind` + `severity`).
 * `worst` collapses to a single matrix-badge tier.
 */
export type ApiComplianceResponse = {
    project: {unid: string; name: string};
    templateIds: string[];
    findings: ApiComplianceFinding[];
    worst: 'info'|'warn'|'risk'|null;
    /**
     * `true` when the project lists template ids that the catalogue
     * couldn't resolve (typo / template deleted on disk). The UI
     * renders an error banner; non-resolvable means the compliance
     * check ran with the empty template set.
     */
    unresolvedIds: string[];
};

/**
 * One cell of the Templates cross-project matrix. `projectUnid`
 * addresses one project; `worst` collapses the project's full
 * compliance findings to the matrix-cell badge (`null` = green).
 */
export type ApiTemplatesMatrixCell = {
    projectUnid: string;
    projectName: string;
    /** Template ids that ran against the project (may be subset of the row). */
    matchedTemplateIds: string[];
    worst: 'info'|'warn'|'risk'|null;
    findingCount: number;
};

/**
 * One row of the Templates cross-project matrix — a template plus
 * the per-project compliance outcome. Projects that don't list the
 * template id in their `templates` array show up with `worst: null`
 * and `findingCount: 0` (template not applicable to this project).
 */
export type ApiTemplatesMatrixRow = {
    template: ApiTemplateSummary;
    cells: ApiTemplatesMatrixCell[];
};

export type ApiTemplatesMatrixResponse = {
    rows: ApiTemplatesMatrixRow[];
};

/**
 * Body of `POST /api/projects/:id/compliance/apply`. The frontend
 * picks a subset of `ComplianceFinding.target` strings via checkbox;
 * the backend re-derives the action from the target shape.
 */
export type ApiComplianceApplyRequest = {
    targets: string[];
};

/**
 * SSE event payloads for `POST /api/projects/:id/compliance/apply`.
 * Sequence:
 *   start    { count, backupDir? }
 *   progress { current, total, target, status, msg? }   (× count)
 *   end      { applied, skipped, errored }
 *   | error  { msg }
 */
export type ApiComplianceApplyStartEvent = {
    count: number;
    backupDir: string|null;
};

export type ApiComplianceApplyProgressEvent = {
    current: number;
    total: number;
    target: string;
    status: 'applied'|'skipped'|'error';
    msg?: string;
};

export type ApiComplianceApplyEndEvent = {
    applied: number;
    skipped: number;
    errored: number;
};

export type ApiComplianceApplyErrorEvent = {
    msg: string;
};

/**
 * Full template body — the wire shape mirrors the on-disk
 * `template.json` 1:1 so the form modal can round-trip it without
 * lossy translation. `files` content stays on disk per
 * `nppm-templates/<id>/files/<path>`; the form lets the user edit
 * metadata (path + mode) only.
 */
export type ApiTemplateBody = {
    id: string;
    name?: string;
    extends?: string[];
    mode?: 'additive'|'strict';
    packages?: {
        runtime?: Record<string, {version?: string; required?: boolean}>;
        dev?: Record<string, {version?: string; required?: boolean}>;
        peer?: Record<string, {version?: string; required?: boolean}>;
        optional?: Record<string, {version?: string; required?: boolean}>;
    };
    forbidden?: string[];
    root?: {
        engines?: Record<string, string>;
        scripts?: Record<string, string>;
        private?: boolean;
        type?: string;
        packageManager?: string;
    };
    files?: {path: string; mode?: 'create'|'merge-json'|'report-only'}[];
    workspaces?: {
        path: string;
        packages?: ApiTemplateBody['packages'];
        forbidden?: string[];
        root?: ApiTemplateBody['root'];
        files?: ApiTemplateBody['files'];
    }[];
};

export type ApiTemplateMutationRequest = ApiTemplateBody;

export type ApiTemplateMutationResponse = {
    success: boolean;
    template?: ApiTemplateSummary;
    msg?: string;
};

export type ApiTemplateDeleteResponse = {
    success: boolean;
    msg?: string;
};

/**
 * Body of `POST /api/templates/sources` — append a URL to the
 * `templateSources` array in nppm.json and trigger a refresh. The
 * URL must point at a raw `template.json` file (http(s)).
 */
export type ApiAddTemplateSourceRequest = {
    url: string;
};

/**
 * Response of `POST /api/templates/sources`. `templateId` is the id
 * the loader resolved from the fetched body — `null` when the URL
 * was stored but the body didn't validate against `SchemaTemplate`
 * (the source stays in nppm.json so the user can fix the upstream
 * file without re-typing the URL).
 */
export type ApiAddTemplateSourceResponse = {
    success: boolean;
    templateId?: string|null;
    msg?: string;
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
 * newest-first for direct rendering in the UI. `gitAvailable` +
 * `gitBackfilledHead` mirror the Vulnerability-Timeline response so
 * the History view can render the same scan-bar UX.
 */
export type ApiHistoryResponse = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    entries: HistoryEntry[];
    gitAvailable: boolean;
    gitBackfilledHead: string|null;
};

/**
 * Server-sent events on `/api/projects/:id/history/backfill`.
 * Mirrors the backfill phase of the Vulnerability-Timeline scan
 * stream — same payloads, but no OSV catch-up.
 */
export type ApiHistoryBackfillStartEvent = {
    gitAvailable: boolean;
    backfillRequired: boolean;
};

export type ApiHistoryBackfillProgressEvent = {
    current: number;
    total: number;
};

export type ApiHistoryBackfillEndEvent = {
    entries: HistoryEntry[];
    gitBackfilledHead: string|null;
    mergedCount: number;
};

export type ApiHistoryBackfillErrorEvent = {
    msg: string;
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
 * Aggregated integrity status per package name for the cross-project
 * matrix badge. Walks every configured project's lockfile, runs the
 * `IntegrityScanner` per project, then collapses the findings per
 * package name: `severity` is the worst across all versions any
 * project pinned, `riskCount` counts only the `risk`-tier hits.
 *
 * `severity: null` means every lockfile entry checked clean (or no
 * findings could be produced — cold registry cache, no lockfiles).
 */
export type ApiMatrixIntegrityEntry = {
    name: string;
    severity: IntegritySeverity|null;
    riskCount: number;
};

export type ApiMatrixIntegrityResponse = {
    results: ApiMatrixIntegrityEntry[];
};

/**
 * One bundlephobia lookup result for the matrix size badge.
 * `size`/`gzip` carry bytes; the matrix renders them in human
 * units. `null` means bundlephobia returned nothing usable for
 * that coordinate (404 / unbuildable / network error).
 */
export type ApiBundleEntry = {
    name: string;
    version: string;
    size: number|null;
    gzip: number|null;
    dependencyCount: number|null;
};

export type ApiBundlesRequest = {
    packages: {name: string; version: string}[];
};

export type ApiBundlesResponse = {
    results: ApiBundleEntry[];
};

/**
 * Response shape of `GET /api/projects/:id/unused`. Mirrors
 * `UnusedReport` 1:1 — kept as its own type so the API surface stays
 * explicit in `ApiTypes.ts`. `supported: false` is the sentinel for
 * remote (GitHub/Gitea) projects which the v1 detector doesn't scan.
 */
export type ApiUnusedResponse = UnusedReport;

/**
 * Response shape of `GET /api/projects/:id/vulnerability-timeline`.
 * Mirrors `VulnerabilityTimelineResponse` 1:1 — kept as its own type
 * so the API surface stays explicit in `ApiTypes.ts`.
 */
export type ApiVulnerabilityTimelineResponse = VulnerabilityTimelineResponse;

/**
 * Response shape of `GET /api/projects/:id/pr-review`. Mirrors
 * `PrReviewReport` 1:1 — kept as its own type so the API surface
 * stays explicit in `ApiTypes.ts`.
 */
export type ApiPrReviewResponse = PrReviewReport;

/**
 * Response shape of `GET /api/impact?name=<name>[&version=<pattern>]`.
 * Cross-project blast-radius answer for a single package name. Wraps
 * `ImpactReport` 1:1 — kept as its own type so the API surface stays
 * explicit in `ApiTypes.ts`.
 */
export type ApiImpactResponse = ImpactReport;

/**
 * Response shape of `GET /api/dashboard/scan` (final `end` event).
 * Project × scanner matrix with one `DashboardCell` per intersection
 * — score (0..100 or null = N/A), severity-bucket counts, and the
 * package denominator that the score formula normalised against.
 *
 * The endpoint is SSE because cold caches require fingerprinting +
 * OSV across every package of every project; the events drive a
 * progress bar with project + scanner labels.
 */
export type ApiDashboardResponse = DashboardResponse;

/**
 * Response shape of `GET /api/dashboard/snapshot`. Returns the most
 * recent scan result persisted to `.nppm-cache/dashboard-snapshot.json`
 * — used by the Dashboard view to render an immediate first-paint
 * while the user decides whether to trigger a fresh SSE scan.
 *
 * Both fields are `null` until the first scan completes.
 */
export type ApiDashboardSnapshotResponse = {
    snapshot: ApiDashboardResponse|null;
    /** ISO-8601 timestamp of the persisted scan, or `null` when missing. */
    timestamp: string|null;
};

/**
 * SSE event payloads for `GET /api/dashboard/scan`. Sequence:
 *
 *   start          { scanners, totalProjects }
 *   column-start   { projectIndex, projectUnid, projectName }
 *   progress       { current, total, projectName, scanner }   (×scanner-per-project)
 *   cell           { projectUnid, scanner, cell }            (×scanner-per-project)
 *   column-end     { column }
 *   end            { dashboard }
 *   | error        { msg }
 *
 * Progress emits one event per (project, scanner) pair so the
 * progress bar can show "kavula — Maintainer (4/45)".
 */
export type ApiDashboardScanStartEvent = {
    scanners: ScannerId[];
    totalProjects: number;
};

export type ApiDashboardScanColumnStartEvent = {
    projectIndex: number;
    projectUnid: string;
    projectName: string;
};

export type ApiDashboardScanProgressEvent = {
    current: number;
    total: number;
    projectName: string;
    scanner: ScannerId|null;
};

export type ApiDashboardScanCellEvent = {
    projectUnid: string;
    scanner: ScannerId;
    cell: DashboardCell;
};

export type ApiDashboardScanColumnEndEvent = {
    column: DashboardColumn;
};

export type ApiDashboardScanEndEvent = {
    dashboard: ApiDashboardResponse;
};

export type ApiDashboardScanErrorEvent = {
    msg: string;
};

/**
 * Response shape of `GET /api/projects/:id/integrity`. Lockfile-
 * resolved + integrity cross-check against the registry's current
 * `dist` metadata.
 */
export type ApiIntegrityResponse = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    findings: IntegrityFinding[];
    summary: IntegritySummary;
    /**
     * `true` when no lockfile was readable for this project — the
     * scan returns empty findings + zero counts and the UI surfaces
     * a "no data" banner. Distinct from "lockfile present, nothing
     * found" (which leaves the field `false`).
     */
    noLockfile: boolean;
};

/**
 * SSE event payloads for `GET /api/projects/:id/vulnerability-timeline/scan`.
 * The stream runs two phases (git backfill then OSV catch-up), and
 * `phase` lets the frontend route the progress bar between them.
 *
 * Sequence:
 *   start            { gitAvailable, backfillRequired }
 *   phase            { name: 'backfill', total }
 *   progress         { current, total, phase: 'backfill' }   (×commits)
 *   backfill-done    { mergedCount, headSha }
 *   phase            { name: 'osv', total }
 *   progress         { current, total, phase: 'osv' }        (×chunks)
 *   end              { timeline: ApiVulnerabilityTimelineResponse }
 *   | error          { msg }
 */
export type ApiTimelineScanStartEvent = {
    gitAvailable: boolean;
    backfillRequired: boolean;
};

export type ApiTimelineScanPhaseEvent = {
    name: 'backfill'|'osv';
    total: number;
};

export type ApiTimelineScanProgressEvent = {
    current: number;
    total: number;
    phase: 'backfill'|'osv';
};

export type ApiTimelineScanBackfillDoneEvent = {
    mergedCount: number;
    headSha: string|null;
};

export type ApiTimelineScanEndEvent = {
    timeline: ApiVulnerabilityTimelineResponse;
};

export type ApiTimelineScanErrorEvent = {
    msg: string;
};

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

/**
 * One row in the cross-project Bulk-Upgrade Wizard. Identifies the
 * single dep bump in one project's `package.json` (root or a named
 * workspace). The frontend collects these by checkbox in the global
 * Matrix; the backend groups them by `projectUnid` so a project gets
 * one shared backup + one install run regardless of how many of its
 * deps were ticked.
 */
export type ApiBulkUpgradePick = {
    projectUnid: string;
    workspace?: string;
    name: string;
    depType: 'dependency'|'dev'|'peer'|'optional';
    fromRange: string;
    toRange: string;
};

/**
 * Why a pick wasn't actionable. `not-local` is the most common — the
 * Upgrader only mutates local-disk projects. `unknown-project` covers
 * a stale UUID (server restart). `not-found` means the dep isn't in
 * the named bucket of the target `package.json` (e.g. the row aggregated
 * across workspaces and the dep only lives in a non-root one).
 */
export type ApiBulkUpgradeSkipReason =
    'not-local'
    |'unknown-project'
    |'not-found'
    |'no-change';

/**
 * One outcome from `POST /api/matrix/upgrade/preview`. Either a
 * full single-pick preview (when planable) or a `skipped` envelope
 * with a reason, so the modal can list both buckets at once.
 */
export type ApiBulkUpgradePreviewResult =
    {pick: ApiBulkUpgradePick; preview: ApiUpgradePreviewResponse}
    |{pick: ApiBulkUpgradePick; skipped: ApiBulkUpgradeSkipReason; msg?: string};

export type ApiBulkUpgradePreviewRequest = {
    picks: ApiBulkUpgradePick[];
};

export type ApiBulkUpgradePreviewResponse = {
    results: ApiBulkUpgradePreviewResult[];
    allowInstall: boolean;
};

export type ApiBulkUpgradeApplyRequest = {
    picks: ApiBulkUpgradePick[];
    mode: 'edit'|'install';
};