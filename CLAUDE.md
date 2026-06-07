# CLAUDE.md — architecture reference

This file orients a fresh Claude Code session (or a human) to the nppm
codebase. It is *not* user-facing documentation — that lives in
`README.md` and `doc/manual_*.md`.

## What nppm is

A Vite-hosted dev tool. Backend = Express middleware mounted inside
`vite.config.ts`; every HTTP route lives in a `backend/Api/*Controller.ts`
class and is wired by `vite.config.ts` through a shared
`ServerContext`. Frontend = plain TypeScript + DOM, no framework, no
build other than what Vite does. Mirrors the architecture of `vtseditor`
in the sibling repo.

## Top-level layout

Top-level folders are lowercase (`backend`, `frontend`, `shared`, `cli`,
`tests`, `doc`). Everything below them keeps PascalCase. The four Vite
entries — `index.html`, `main.ts`, `main.css`, `vite.config.ts` — sit at
the repo root because Vite expects them there.

```
nppm/
├── index.html              entry, contains topbar + main panes
├── main.ts                 mounts language picker + boots Nppm
├── main.css                all styling
├── vite.config.ts          Express middleware + every API route
│
├── cli/                    user-facing CLI (shims + TS runners co-located)
│   ├── nppm.js             top-level subcommand router (dev | scan | sbom | action | --help)
│   ├── dev.js              shim: writes default config, starts Vite
│   ├── scan.js             shim: Vite.ssrLoadModule('./cli/Scan.ts')
│   ├── sbom.js             shim: Vite.ssrLoadModule('./cli/Sbom.ts')
│   ├── action.js           shim: GitHub Actions entry (Vite.ssrLoadModule('./cli/Action.ts'))
│   ├── CliArgs.ts          CliArgsParser + FailOnLevel ladder + HELP_TEXT
│   ├── ScanReport.ts       ScanReportBuilder — per-scanner→unified severity
│   ├── ScanFormat.ts       ScanFormatter — text + JSON + SARIF + shouldFail
│   ├── ScanSarif.ts        SarifBuilder — SARIF 2.1.0 (rules + results + partialFingerprints)
│   ├── Scan.ts             runScan() orchestrator (OSV / heuristics / unused)
│   ├── Sbom.ts             SbomRunner + SbomCliArgsParser — CycloneDX/SPDX CLI
│   ├── Action.ts           runAction() — GitHub Actions PR-comment + SARIF flow
│   ├── ActionFormat.ts     ActionFormatter — sticky PR-comment markdown body
│   └── GithubClient.ts     thin REST client for the issue-comment endpoints
│
├── shared/
│   └── Api/ApiTypes.ts     wire types shared between backend & frontend
│
├── backend/                Express side
│   ├── Api/                        HTTP-route Controllers + body schemas
│   │   ├── ServerContext.ts            shared state bag passed to every Controller (~20 fields + getProject/refreshTemplates/mutateConfig/pickFingerprintBuilder)
│   │   ├── ConfigController.ts         GET /api/config + PUT /api/config + POST /api/cache/clear
│   │   ├── FsController.ts             GET /api/fs/browse (directory picker)
│   │   ├── ProjectsController.ts       GET/POST/PUT/DELETE /api/projects + GET /api/projects/:id/config
│   │   ├── TemplatesController.ts      template CRUD + sources + cross-project matrix + per-project compliance + apply SSE
│   │   ├── UpgradeController.ts        per-project upgrade preview + apply SSE + lifecycle list/run SSE
│   │   ├── MatrixController.ts         per-project + cross-project matrix + batched security/heuristics/bundles + integrity + bulk-upgrade preview/apply SSE
│   │   ├── LockfileController.ts       per-project lockfile (with HistoryStore auto-snapshot) + depgraph + analyze SSE + cross-project analyze-all SSE
│   │   ├── DashboardController.ts      dashboard snapshot/history/growth + per-package trends + scanner × project sweep SSE (split into _scanProject/_runPerPackageScanners/_runPerProjectScanners/_packagesFromLockfile/_packagesFromManifest/_fetchDownloads/_persistSnapshot)
│   │   ├── HistoryController.ts        per-project change log + backfill SSE
│   │   ├── VulnerabilityController.ts  per-project vulnerability timeline + scan SSE
│   │   ├── PackagesController.ts       per-project manifest list
│   │   ├── ReleasesController.ts       npm + GitHub releases merged
│   │   ├── SecurityController.ts       aggregated SecurityReport for one pkg@version
│   │   ├── FingerprintController.ts    GET /api/fingerprint + /api/fingerprint/diff
│   │   ├── ImpactController.ts         cross-project blast-radius for a pkg@version
│   │   ├── PrReviewController.ts       branch-vs-branch dep delta + CVE delta
│   │   ├── IntegrityController.ts      per-project lockfile integrity cross-check
│   │   ├── UnusedController.ts         per-project depcheck-style report
│   │   ├── SbomController.ts           per-project SBOM emit (CycloneDX / SPDX)
│   │   └── Schemas/                    VTS body/query schemas used by the Controllers
│   │       ├── SchemaApiConfig.ts
│   │       ├── SchemaApiFsBrowse.ts
│   │       ├── SchemaApiProjects.ts
│   │       ├── SchemaApiTemplates.ts
│   │       ├── SchemaApiUpgrade.ts
│   │       └── SchemaApiMatrix.ts
│   │
│   ├── Config/Config.ts            VTS schemas for nppm.json
│   ├── Config/ConfigLoader.ts      buildLoadedConfig() — shared bootstrap used by vite.config.ts + cli/Scan.ts
│   ├── Config/NppmDirs.ts          single source of truth for `.nppm/{cache,history,backups}` + idempotent legacy-folder migration
│   ├── Cache/JsonCache.ts          one-file-per-key disk cache (TTL or permanent)
│   │
│   ├── Project/                    project sources (local + remote bases)
│   │   ├── Project.ts              common interface (loadManifests, loadLockfile, getKey, …)
│   │   ├── ProjectLocal.ts         local-dir reader, includes workspace expansion
│   │   ├── ProjectRemote.ts        abstract base for GitHub/Gitea
│   │   ├── ProjectGithub.ts        contents API; constructor normalises full URLs (https://, git@, github:, .git suffix) to owner/name
│   │   ├── ProjectGitea.ts         contents API (different URL shape, token format); exposes getHost()/getToken() for the Gitea-host allow-list in GitResolver/GitHeadFetcher
│   │   ├── PackageManifest.ts      flat DependencyType + PackageDependency types
│   │   ├── Lockfile.ts             parsePackageLock v2/v3, scanNodeModules fallback
│   │   └── SafePath.ts             join() containment helper — resolves a candidate against a root, refuses anything that isn't the root itself or a strict descendant of `${root}${sep}`. Used by Upgrader.resolvePackageJson + TemplateApplier._packageJsonFor/_fileAbs.
│   │
│   ├── Registry/Registry.ts        npm-registry client with batched concurrency
│   │
│   ├── Matrix/                     two matrix variants
│   │   ├── MatrixBuilder.ts        cross-project (rows = pkgs, cols = projects)
│   │   └── ProjectMatrixBuilder.ts per-project (rows = pkgs, cols = workspaces)
│   │
│   ├── Fingerprint/                tarball-level scanning
│   │   ├── TarballParser.ts        zlib + manual 512-byte tar walk (no `tar` dep); exposes the stripped top-level folder so GitHeadFetcher can lift the SHA out of GitHub codeload's `<repo>-<sha>` prefix
│   │   ├── Fingerprint.ts          File / Package / Diff types
│   │   ├── FingerprintBuilder.ts   fetch+gunzip+hash, content cache for JS files; cache-less variant for non-SHA-pinned git coordinates so HEAD content is never served stale
│   │   ├── FingerprintDiff.ts      added/removed/modified
│   │   └── GitResolver.ts          git URLs → codeload/gitlab/bitbucket/gitea tarball URLs. Host-agnostic `parse()` extracts host/owner/repo/ref; tarball resolver accepts a `giteaHosts` allow-list so any configured Gitea project routes through `/archive/<ref>.tar.gz`.
│   │
│   ├── Security/                   heuristic + CVE scanners
│   │   ├── OsvClient.ts            OSV.dev (single + batch), envelope-cached
│   │   ├── ScriptScanner.ts        lifecycle-script heuristic
│   │   ├── PatternScanner.ts       eval/Function/child_process/base64 regex
│   │   ├── ChurnScanner.ts         diff prev stable vs current, threshold by bump
│   │   ├── BinaryScanner.ts        extension- + bin/-path classification
│   │   ├── MaintainerScanner.ts    _npmUser handover detection, gap-based severity
│   │   ├── LicenseScanner.ts       SPDX classifier (permissive/weak/strong/proprietary/unknown) + mini expr parser
│   │   ├── IntegrityScanner.ts     lockfile `resolved+integrity` vs registry `dist` cross-check
│   │   ├── ImpactAnalyzer.ts       cross-project blast-radius: BFS shortest path from root deps to a queried name(+version)
│   │   ├── DeprecationScanner.ts   reads per-version `deprecated` from the packument — risk (installed) / warn (latest) / info (only older)
│   │   ├── ObfuscationScanner.ts   per-JS-file heuristic over the tarball fingerprint — eval(atob(...)) / _0x density / hex-string arrays / long lines, with `dist/`/min path classification so legit minification stays at info
│   │   ├── ManifestRedFlagsScanner.ts  pure heuristics over the fingerprint manifest — no README / no description / no files[] / many bins / native+postinstall combo / dated engines
│   │   ├── CapabilityScanner.ts    per-package capability inventory (fs read/write, network, raw socket, child_process, credential-shaped env, native bindings, eval); severity by *combination*
│   │   ├── MutableResolutionScanner.ts  per-project lockfile sweep — mutable git refs / missing integrity / file:/link: protocols
│   │   ├── ExternalSourcesScanner.ts  aggregator over three third-party reputation APIs (socket.dev + OpenSSF Scorecard + deps.dev), worst-of-three severity per package
│   │   ├── External/SocketDevFetcher.ts  per-package socket.dev score (needs API key)
│   │   ├── External/OpenSsfFetcher.ts   OpenSSF Scorecard fetch + npm `repository` → host/owner/repo parser
│   │   ├── External/DepsDevFetcher.ts   deps.dev v3 version metadata (free, no auth)
│   │   └── SecurityScanner.ts      aggregator + batched matrix-heuristics
│   │
│   ├── Unused/                     depcheck-style per-project hygiene scan
│   │   ├── UnusedReport.ts         UnusedFinding/Misplaced/Missing/ScanLimit + severity
│   │   └── UnusedDetector.ts       regex-based file walk + bin-tool allowlist + scripts/`@types`/workspace heuristics
│   │
│   ├── Sbom/                       format-agnostic SBOM emitters
│   │   ├── Purl.ts                 Purl.npm() — PURL encoder for npm packages
│   │   ├── SbomCollector.ts        SbomCollector — lockfile + registry → SbomData
│   │   ├── CycloneDxBuilder.ts     CycloneDX 1.6 JSON converter
│   │   └── SpdxBuilder.ts          SPDX 2.3 JSON converter
│   │
│   ├── Upgrade/                    one-click dep upgrade pipeline
│   │   ├── PackageJsonEditor.ts    surgical range bump, preserves indent + trailing-newline
│   │   ├── BackupStore.ts          timestamped snapshots in `.nppm/backups/`
│   │   ├── LifecycleScriptScanner.ts  walks node_modules/* for install hooks
│   │   └── Upgrader.ts             orchestrator: preview / applyEdit / runInstall / runRebuild
│   │
│   ├── Releases/                   npm registry + GitHub Releases merge
│   │   ├── Releases.ts
│   │   ├── ReleasesFetcher.ts
│   │   ├── GitHeadFetcher.ts       TTL-cached HEAD-tarball fetcher: resolves the upstream HEAD via GitResolver, lifts `package.json.version` + commit SHA out of the codeload prefix. Returns `GitHeadInfo` carrying an `error` field on failure (`GitHub unreachable: …` not cached, `Repository not found` cached). Per-instance Gitea token routing.
│   │   └── GitCommitsFetcher.ts    GitHub REST `/commits` + Gitea v1 `/repos/.../commits` (per-instance token); maps each row into the existing `Release` shape with `sha`, `subject`, `author`. TTL-cached against the releases pocket. Drives /api/releases for git-versions.
│   │
│   ├── Dashboard/
│   │   ├── DashboardBuilder.ts        per-(project, scanner) scoring helpers — unified info/warn/risk → 0–100 ring score; reused by /api/dashboard/scan
│   │   ├── DashboardHistoryStore.ts   per-UTC-day JSON in `.nppm/history/dashboard/YYYY-MM-DD.json` (last scan of day wins); summarize() + recordScan() + readRange() + readPrevious(). Drives the Trend tab + macro-donut "↑X pts vs last scan" delta.
│   │   ├── DashboardGrowthBuilder.ts  per-project package-count timeline replayed from HistoryStore (baseline = lastSnapshot.length − Σ(added − removed); walk forward emitting points). Carry-forward sum across non-aligned per-project timestamps for ecosystem total. Drives Trend tab "Packages" metric.
│   │   ├── InstalledSize.ts           sums `dist.unpackedSize` across a lockfile-derived package set via the packument cache; returns {totalBytes, coveredCount, totalCount} so the UI labels the number as a best-effort floor.
│   │   └── DownloadsAggregator.ts     two-layer dedupe: per-project sums distinct names once; ecosystem total dedupes across all projects. Gap = dep-tree-overlap signal.
│   │
│   ├── Downloads/NpmDownloadsFetcher.ts  `api.npmjs.org/downloads/point/last-week/<pkg>` with comma-bulk for unscoped (128-batch) + per-name fetch for scoped; 24h TTL cache; null-envelope for misses. `fetchRange()` for the per-package last-year daily downloads line, cached under a separate key.
│   │
│   ├── Package/PackageTrendsBuilder.ts  folds RegistryPackage → {versions: [{version, releasedAt, unpackedSize, fileCount, publisher, maintainerCount, depCount}], releasesByMonth: [{month, count}]}. Strips aux `created`/`modified` keys from `time` map. Versions without a date sort to the tail.
│   │
│   ├── DepGraph/DepGraphBuilder.ts  flat-graph walker, npm hoisting algorithm
│   ├── History/                    per-project change log
│   │   ├── History.ts
│   │   ├── HistoryStore.ts         atomic-write JSON in `.nppm/history/`
│   │   ├── BackfillCommon.ts       parseLockfile/parsePackageJson + snapshots → entries
│   │   ├── GitHistoryBackfill.ts   walks `git log -- package-lock.json`, falls back to package.json
│   │   └── RemoteGitHistoryBackfill.ts  GitHub/Gitea commits API → HistoryEntry[]
│   │
│   ├── Vulnerability/              retroactive CVE-exposure timeline
│   │   ├── Timeline.ts             VersionPresenceInterval / VulnerabilityExposure / ExposureClass
│   │   └── TimelineBuilder.ts      forward-replay history × OSV cache → exposure windows
│   │
│   ├── PrReview/                   branch-vs-branch dep delta with CVE delta
│   │   ├── PrReview.ts             PrDepChange / PrSummary / PrReviewReport
│   │   └── PrReviewBuilder.ts      diff package.json + lockfile at two refs + OSV batch
│   │
│   ├── Templates/                  project-standards / standards-enforcement
│   │   ├── Template.ts                       Vts schema + types (Template / ResolvedTemplate / ComplianceFinding)
│   │   ├── TemplateLoader.ts                 reads nppm-templates/<id>/template.json + files/ per folder
│   │   ├── TemplateResolver.ts               flattens `extends` graph + per-project chain (later wins)
│   │   ├── TemplateComplianceChecker.ts      diff resolved template × project → ComplianceReport (packages, root, files, workspaces)
│   │   └── TemplateApplier.ts                applies selected findings to disk (package.json edits + file copies + merge-json) with BackupStore snapshot
│   │
│   └── Bundle/BundlephobiaFetcher.ts  permanent-cache bundlephobia client
│
├── frontend/               every browser-side module, grouped by role
│   ├── Nppm.ts             top-level orchestrator (panes, routing)
│   ├── logo.svg            32×32 brand mark
│   │
│   ├── Util/                           framework-neutral helpers
│   │   ├── Api.ts                      `fetch()` wrapper
│   │   ├── I18n.ts                     public i18n API + LANGUAGES + LOCALES registry
│   │   ├── EditorUrl.ts                URL-handler templates for vscode/vscodium/cursor/phpstorm/webstorm/idea/subl
│   │   ├── Version.ts                  shared cleanRange helper
│   │   └── Locales/
│   │       ├── en.ts                   English translations (source-of-truth identity map)
│   │       └── de.ts                   German translations
│   │
│   ├── Pages/                          right-pane views
│   │   ├── Matrix.ts                   global matrix view
│   │   ├── ProjectMatrixView.ts        per-project matrix
│   │   ├── PackageList.ts              declared-deps table
│   │   ├── InstalledView.ts            lockfile/node_modules table + analyze bar
│   │   ├── HistoryView.ts              timeline cards
│   │   ├── DepTreeView.ts              D3-collapsible tree
│   │   ├── UnusedView.ts               per-project depcheck-style report (unused/misplaced/missing)
│   │   ├── VulnerabilityTimelineView.ts  retroactive CVE exposure window per name@version
│   │   ├── PrReviewView.ts             diffs package.json + lockfile between two git refs
│   │   ├── DashboardView.ts            cross-project scanner matrix (three tabs — Scanner Score / Overall Evaluation / Trend). Emits per-project averages on snapshot load + column-end + scan-end to drive the treeview ring (Dashboard-wins precedence; Matrix is fallback). Manifest-fallback projects render an orange ⓘ next to the column header carrying the `column.note` tooltip.
│   │   ├── TemplatesView.ts            cross-project compliance matrix (Templates treeview entry)
│   │   ├── TemplateView.ts             per-project right-pane tab showing the compliance diff
│   │   └── GlobalScanView.ts           SSE-driven global scan results
│   │
│   ├── Modals/                         overlays + slide-out panels
│   │   ├── PackageDetailPanel.ts       modal w/ 7 tabs (Files/Deps/Diff/Releases/Security/License/Trends). Trends tab renders 5 hand-rolled SVG sub-charts from `/api/packages/:name/trends`.
│   │   ├── EcosystemBoxModal.ts        detail modal for the Overall-Evaluation hero card boxes.
│   │   ├── FindingsModal.ts            drill-down modal on Dashboard cell click — scanner label + project + top-50 findings + "Open in <view>"
│   │   ├── ImpactModal.ts              cross-project blast-radius modal (topbar "Impact" button → /api/impact)
│   │   ├── UpgradeModal.ts             overlay: preview → edit/install → lifecycle-scripts list + Run buttons
│   │   ├── BulkUpgradeModal.ts         cross-project bulk wizard: grouped preview + per-project SSE install log
│   │   ├── SettingsModal.ts            tabbed editor for the non-projects sections of nppm.json
│   │   ├── DirectoryPickerModal.ts     backend-driven filesystem picker for the ProjectFormModal Path field
│   │   ├── ProjectFormModal.ts         add/edit project (local, github, gitea)
│   │   ├── TemplateApplyModal.ts       pick-checkbox modal + SSE log for `POST .../compliance/apply`
│   │   ├── TemplateFormModal.ts        tabbed editor (General/Packages/Forbidden/Root/Files) backing the CRUD endpoints
│   │   ├── WorkspaceDriftModal.ts      per-project breakdown for the matrix `WS` badge + "Open project matrix" jump
│   │   ├── BadgeFilterModal.ts         per-badge filter chooser for the cross-project matrix
│   │   └── WhyModal.ts                 inverted-dep-graph BFS (`npm why`-style) for one installed name
│   │
│   ├── Widgets/                        reusable chrome
│   │   ├── Treeview.ts                 left-pane project list
│   │   └── Resizer.ts                  splitter logic
│   │
│   └── Dashboard/          DashboardView extracted helpers (Formatters, ScannerMeta, ChartRenderer)
│
├── tests/                  vitest, all unit, no network
├── doc/                    user-facing manuals + screenshot script
└── nppm-templates/         shipped local template catalogue
```

## API routes (in `vite.config.ts`)

| Method | Path                                                  | Purpose |
|--------|-------------------------------------------------------|---------|
| GET    | `/api/projects`                                       | list configured projects + counts |
| GET    | `/api/config`                                         | non-`projects` sections of nppm.json (drives SettingsModal) |
| PUT    | `/api/config`                                         | full replacement of non-`projects` sections (validated vs `SchemaConfig`) |
| POST   | `/api/cache/clear`                                    | wipe every file under `cacheDir`; preserves dirs so in-memory JsonCache instances keep writing |
| GET    | `/api/fs/browse?path=&showHidden=`                    | directory listing for the DirectoryPickerModal (absolute paths only) |
| GET    | `/api/templates`                                      | catalogue summary (drives the Templates view header) |
| GET    | `/api/templates/:id`                                  | one template (guarded against `:id === "matrix"`, since /matrix is registered after) |
| POST   | `/api/templates`                                      | create a new local template (id format `[a-z0-9][a-z0-9-]{0,63}`) |
| PUT    | `/api/templates/:id`                                  | full-replace local template (body id must match URL; 403 if id is remote) |
| DELETE | `/api/templates/:id`                                  | remove local template dir (403 if id is remote) |
| POST   | `/api/templates/sources`                              | append URL to `templateSources` in nppm.json + refresh remote cache |
| GET    | `/api/templates/matrix`                               | cross-project compliance matrix |
| GET    | `/api/projects/:id/compliance`                        | per-project compliance findings (packages + root + files + workspaces) |
| POST   | `/api/projects/:id/compliance/apply`                  | SSE: apply selected finding targets to disk (one backup snapshot before any write) |
| GET    | `/api/projects/:id/packages`                          | flat manifest list of one project |
| GET    | `/api/projects/:id/lockfile`                          | parsed lockfile (or `node_modules` fallback) |
| GET    | `/api/projects/:id/lockfile/analyze`                  | SSE per-project OSV scan |
| GET    | `/api/projects/:id/history`                           | per-project change log |
| GET    | `/api/projects/:id/history/backfill`                  | SSE: git-backfill only (no OSV) — drives History-view button |
| GET    | `/api/projects/:id/matrix`                            | per-project matrix |
| GET    | `/api/projects/:id/depgraph`                          | flat resolved dep graph |
| GET    | `/api/impact?name=&version=`                          | cross-project blast-radius: every reachable instance of `name`, direct + transitive, with shortest dep path |
| GET    | `/api/dashboard/scan`                                 | SSE: per-(project, scanner) score matrix — emits `start` / `column-start` / `progress` / `cell` / `column-end` / `end`, drives the Dashboard view's progress bar (cold cache ≈ 1 min). Post-loop fetches per-package downloads and attaches per-project `downloadsLastWeek` + ecosystem-deduped total to the response. |
| GET    | `/api/dashboard/snapshot`                             | last persisted scan result (`.nppm/cache/dashboard-snapshot.json`), or `{snapshot:null,timestamp:null}` when none — drives the Dashboard view's first-paint |
| GET    | `/api/dashboard/history?days=`                        | rolling daily history `{entries, previous}` from `.nppm/history/dashboard/YYYY-MM-DD.json`; entries clipped to `days` (default 90, clamp 1..3650); `previous` is the entry immediately before the most-recent regardless of range. Drives the Trend tab (Score metric) + macro-donut delta. |
| GET    | `/api/dashboard/growth?days=`                        | per-project package-count timelines `{series, total}` reconstructed from per-project HistoryStore replays; carry-forward ecosystem total. Drives the Trend tab (Packages metric). |
| GET    | `/api/packages/:name/trends`                          | per-version timeline (size/files/publisher/maintainer/dep counts) from the packument cache + releases-by-month + last-year daily downloads. Drives the PackageDetailPanel Trends tab. |
| GET    | `/api/projects/:id/unused`                            | depcheck-style hygiene scan (unused / misplaced / missing) |
| GET    | `/api/projects/:id/sbom?format=cyclonedx\|spdx`       | Software Bill of Materials (default: cyclonedx) |
| GET    | `/api/projects/:id/vulnerability-timeline`            | retroactive CVE-exposure timeline (cache-only read) |
| GET    | `/api/projects/:id/vulnerability-timeline/scan`       | SSE: git-backfill history + OSV catch-up |
| GET    | `/api/projects/:id/pr-review?base=&head=`             | dep diff + CVE delta between two git refs |
| GET    | `/api/projects/:id/integrity`                         | lockfile `integrity` cross-check vs registry `dist` |
| POST   | `/api/projects/:id/upgrade/preview`                   | plan a single dep range bump (returns before/after + SecurityReport) |
| POST   | `/api/projects/:id/upgrade/apply`                     | SSE: write backup + edit; if `mode=install`, also stream `npm install --ignore-scripts` |
| POST   | `/api/matrix/upgrade/preview`                         | bulk preview for the cross-project Bulk-Upgrade Wizard |
| POST   | `/api/matrix/upgrade/apply`                           | SSE: group picks by project, one backup + (optional) `npm install` per project |
| GET    | `/api/projects/:id/lifecycle-scripts`                 | install/postinstall/prepare hooks across `node_modules/*` |
| POST   | `/api/projects/:id/lifecycle-scripts/run`             | SSE: `npm rebuild <pkg>` — gated by `actions.allowInstall` |

## Headless CLI

`nppm scan` reuses the same `nppm.json`, `.nppm/cache/`, and scanner
classes as the dev server. It does *not* serve HTTP — `cli/scan.js`
spins up a Vite dev server in `middlewareMode:true, appType:'custom'`
purely to call `ssrLoadModule('./cli/Scan.ts')`, then closes it. No
new dependency: Vite is already a runtime dep.

The runner pipeline per project:
1. `Project.loadLockfile()` → flat package list, deduplicated by
   `name@version`.
2. `OsvClient.queryBatch(...)` for CVE IDs (skipped on `--no-osv`).
3. `SecurityScanner.scanHeuristicsBatch(...)` for scripts / patterns /
   binaries / maintainer / license + the bundled
   `ExternalSourcesScanner` pass (skipped on `--no-heuristics`; the
   external pass can be additionally turned off via `--no-external`).
4. `UnusedDetector.scan(project)` for the depcheck-style buckets
   (skipped on `--no-unused`).

The per-scanner severity enums are mapped to a unified
`UnifiedSeverity` (`info|warn|risk`) in `cli/ScanReport.ts`. License
classifications collapse via `licenseToUnified`: `permissive` drops
out, `weak-copyleft`/`unknown` → info, `strong-copyleft` → warn,
`proprietary` → risk. OSV vulns are uniformly risk (the batch endpoint
returns IDs only, no per-vuln severity — matches `npm audit`'s
`--audit-level=high` semantics).
| GET    | `/api/matrix`                                         | cross-project matrix |
| POST   | `/api/matrix/security`                                | batched CVE lookup |
| POST   | `/api/matrix/heuristics`                              | batched scripts + patterns + binaries |
| GET    | `/api/lockfile/analyze-all`                           | SSE global scan |
| GET    | `/api/fingerprint`                                    | one `pkg@version` fingerprint |
| GET    | `/api/fingerprint/diff`                               | file-level diff between two versions |
| GET    | `/api/security`                                       | aggregated SecurityReport for one `pkg@version` |
| GET    | `/api/releases?name=&version=`                        | registry + GitHub-merged release list; `version` triggers git-skip (empty timeline for git URLs) |

## Storage

Everything nppm writes into a project root lives under one `.nppm/`
parent so the consumer sees one folder instead of three (the legacy
`.nppm-cache/`, `.nppm-history/`, `.nppm-backups/`). `backend/Config/
NppmDirs.ts` is the single source of truth for these paths and runs an
idempotent migration on first access — when an old sibling folder
exists and the new bucket is empty, it `rename()`s into place. Partial
migrations leave both sides alone rather than merging.

- `.nppm/cache/` — TTL caches (registry, remote, security, releases,
  downloads) and a permanent fingerprint cache. Safe to delete;
  auto-rebuilt.
- `.nppm/history/` — append-only per-project history JSON + per-day
  dashboard rolling history. **Do not** put under `cache/` because the
  user wants to keep / commit it.
- `.nppm/backups/` — pre-write snapshots from Upgrade / Template-Apply
  flows. Lives next to history for the same reason: it's audit trail,
  not throwaway state.

## Conventions Claude should not break

- **Vts.or unions** don't narrow on a discriminator in TS — always cast
  inside an `if (entry.type === ...)` branch in `vite.config.ts`'s project
  loop.
- **`{data: ...}` envelope** in caches that can legitimately store
  `null`. A bare `null` from `JsonCache.get` means "miss", an envelope's
  `data: null` means "we asked, got nothing".
- **Permanent fingerprint cache** — versions are immutable on npm. Bump
  the cache-key prefix (`fp_v4_*` → `fp_v5_*`) when the cached shape
  changes.
- **Maintainer-handover severity is gap-INVERSE.** Short gap + new
  publisher on a mature package = `risk` (event-stream / ua-parser-js
  profile). Long gap = usually a legitimate community takeover and
  drops to `info`. Don't "fix" this back to "long-silence-is-scary"
  without re-reading the incident reports — the empirical pattern is
  the other way round. Thresholds are tunable via
  `security.maintainer.{quickHandoverDays,suspiciousGapDays}` in
  `nppm.json`.
- **i18n** — every user-visible string in the frontend goes through
  `t()`. Add new strings to `frontend/Util/Locales/en.ts` AND `de.ts` (or
  rely on the en-fallback for a while).
- **No new framework dependency.** D3 is the only client lib; everything
  else is hand-rolled DOM.
- **Templates: local-overrides-remote.** `templateSources: string[]` in
  nppm.json fetches `template.json` files into
  `.nppm/cache/templates-remote/<id>/`. On id conflict the local
  `nppm-templates/<id>/` wins. CRUD endpoints (`POST`/`PUT`/`DELETE
  /api/templates/:id`) refuse with `403` for ids whose source is
  remote — remote templates are read-only mirrors.
- **Git-version skip for name-keyed lookups.** When a dep version
  matches `GitResolver.isGitVersion()` (`git+`, `git://`, `git@`,
  `github:`, `gitlab:`, `bitbucket:`), every scanner that fetches
  data by *name* from the npm registry must return `null` for that
  package — OSV / Maintainer / Churn / Integrity / License /
  Provenance / Typosquat all do (see `SecurityScanner._reportOne`'s
  `isGit` hoist + the gated `reg.license` fallback), plus
  `SecurityScanner._cadence/_freshnessSummary` and
  `/api/releases?version=`. The reason is collision: a user's
  private git dep (`git+https://.../figtree.git#claude`) shares a
  name with an unrelated public `figtree@0.0.0` from someone else.
  `MatrixBuilder.build` and `ProjectMatrixBuilder.build` both force
  `latest = null` for rows where every cell is a git URL, and stamp
  `gitLatest` (carrying the stripped origin + per-row HEAD info from
  `GitHeadFetcher`) so the frontend can render `1.0.28 · 7d3f12a`.
  `frontend/Pages/Matrix.setData` excludes git-only rows from the
  `/api/matrix/heuristics` batch entirely. The dashboard SSE +
  per-/cross-project OSV scans in `vite.config.ts` use
  `pkg.resolved` as the scanner-version when it's a git URL, keeping
  the semver as `displayVersion` for the user-facing label so the
  name-keyed guards in SecurityScanner fire on the right input. The
  fingerprint path still works because `FingerprintBuilder` resolves
  git URLs via `GitResolver.resolveTarball` instead of the registry;
  non-SHA-pinned coordinates go through the cache-less variant so
  HEAD content is never served stale.
- **Dashboard manifest-fallback emits `column.note`, not
  `column.error`.** Projects without a committed
  `package-lock.json` build a best-effort package list from the
  root manifest (each declared dep resolved to registry `latest`)
  and feed it through the existing scanner pipeline. The dashboard
  handler stamps `DashboardColumn.note = "no lockfile — scanned
  against registry latest"` for the soft annotation — the frontend
  paints an orange ⓘ next to the column header, *not* the red
  `column.error` styling. IntegrityScanner and MutableResolutionScanner
  stay `N/A` on this path because both need a lockfile to walk.
  Don't add a `column.error` here on the assumption "missing
  lockfile is an error" — most browser-extension and library repos
  legitimately don't commit one.
- **SafePath for every project-rooted write.** Two endpoints
  (`POST /api/projects/:id/upgrade/apply` accepting `workspace`,
  `POST /api/projects/:id/compliance/apply` accepting per-file
  `path`) used to join user-supplied segments with the project
  root unchecked. Every new endpoint that writes inside a project
  must route through `backend/Project/SafePath.ts`'s `join(root,
  ...segments)` — it resolves the candidate, then refuses
  anything that isn't either the root itself or a strict
  descendant of `${root}${sep}`. The trailing-separator boundary
  is load-bearing: a plain `startsWith(root)` would let
  `/srv/project-evil` squeak past on a sibling project called
  `/srv/project`. Tests cover trailing `..`, deep `../..` chains,
  absolute segments, sibling-with-shared-prefix.

## Tests

`vitest`. Tarballs are built in-memory with synthetic tar blocks (see
`tests/TarballParser.test.ts` for the builder). No fixture files live in
the repo, no network mocks via msw/nock — fetch is stubbed via DI
(`TarballFetcher`, `OsvFetcher`, `GithubReleasesFetcher`).

## Phases (historical)

The roadmap in `~/.claude/projects/.../memory/project_roadmap.md`
captures the sequence of work that built the system; this file replaces
that as the durable reference once the project ships.