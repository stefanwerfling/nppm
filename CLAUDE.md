# CLAUDE.md — architecture reference

This file orients a fresh Claude Code session (or a human) to the nppm
codebase. It is *not* user-facing documentation — that lives in
`README.md` and `doc/manual_*.md`.

## What nppm is

A Vite-hosted dev tool. Backend = Express middleware mounted inside
`vite.config.ts`. Frontend = plain TypeScript + DOM, no framework, no
build other than what Vite does. Mirrors the architecture of `vtseditor`
in the sibling repo.

## Top-level layout

```
nppm/
├── cli/nppm.js             top-level subcommand router (dev | scan | --help)
├── cli/dev.js              CLI shim: writes default config, starts Vite
├── cli/scan.js             CLI shim: uses Vite.ssrLoadModule to run Cli/Scan.ts
├── index.html              entry, contains topbar + main panes
├── main.ts                 mounts language picker + boots Nppm
├── main.css                all styling
├── vite.config.ts          Express middleware + every API route
│
├── Api/ApiTypes.ts         wire types shared between backend & frontend
├── Config/Config.ts        VTS schemas for nppm.json
├── Config/ConfigLoader.ts  buildLoadedConfig() — shared bootstrap used by vite.config.ts + Cli/Scan.ts
├── Cache/JsonCache.ts      one-file-per-key disk cache (TTL or permanent)
│
├── Project/                project sources (local + remote bases)
│   ├── Project.ts          common interface (loadManifests, loadLockfile, getKey, …)
│   ├── ProjectLocal.ts     local-dir reader, includes workspace expansion
│   ├── ProjectRemote.ts    abstract base for GitHub/Gitea
│   ├── ProjectGithub.ts    contents API
│   ├── ProjectGitea.ts     contents API (different URL shape, token format)
│   ├── PackageManifest.ts  flat DependencyType + PackageDependency types
│   └── Lockfile.ts         parsePackageLock v2/v3, scanNodeModules fallback
│
├── Registry/Registry.ts    npm-registry client with batched concurrency
│
├── Matrix/                 two matrix variants
│   ├── MatrixBuilder.ts    cross-project (rows = pkgs, cols = projects)
│   └── ProjectMatrixBuilder.ts  per-project (rows = pkgs, cols = workspaces)
│
├── Fingerprint/            tarball-level scanning
│   ├── TarballParser.ts    zlib + manual 512-byte tar walk (no `tar` dep)
│   ├── Fingerprint.ts      File / Package / Diff types
│   ├── FingerprintBuilder.ts  fetch+gunzip+hash, content cache for JS files
│   ├── FingerprintDiff.ts  added/removed/modified
│   └── GitResolver.ts      git URLs → codeload/gitlab/bitbucket tarball URLs
│
├── Security/               heuristic + CVE scanners
│   ├── OsvClient.ts        OSV.dev (single + batch), envelope-cached
│   ├── ScriptScanner.ts    lifecycle-script heuristic
│   ├── PatternScanner.ts   eval/Function/child_process/base64 regex
│   ├── ChurnScanner.ts     diff prev stable vs current, threshold by bump
│   ├── BinaryScanner.ts    extension- + bin/-path classification
│   ├── MaintainerScanner.ts  _npmUser handover detection, gap-based severity
│   ├── LicenseScanner.ts   SPDX classifier (permissive/weak/strong/proprietary/unknown) + mini expr parser
│   └── SecurityScanner.ts  aggregator + batched matrix-heuristics
│
├── Unused/                 depcheck-style per-project hygiene scan
│   ├── UnusedReport.ts     UnusedFinding/Misplaced/Missing/ScanLimit + severity
│   └── UnusedDetector.ts   regex-based file walk + bin-tool allowlist + scripts/`@types`/workspace heuristics
│
├── Cli/                    headless `nppm scan` (CI gate) + `nppm sbom`
│   ├── CliArgs.ts          CliArgsParser + FailOnLevel ladder + HELP_TEXT
│   ├── ScanReport.ts       ScanReportBuilder — per-scanner→unified severity
│   ├── ScanFormat.ts       ScanFormatter — text + JSON + SARIF + shouldFail
│   ├── ScanSarif.ts        SarifBuilder — SARIF 2.1.0 (rules + results + partialFingerprints)
│   ├── Scan.ts             runScan() orchestrator (OSV / heuristics / unused)
│   └── Sbom.ts             SbomRunner + SbomCliArgsParser — CycloneDX/SPDX CLI
│
├── Sbom/                   format-agnostic SBOM emitters
│   ├── Purl.ts             Purl.npm() — PURL encoder for npm packages
│   ├── SbomCollector.ts    SbomCollector — lockfile + registry → SbomData
│   ├── CycloneDxBuilder.ts CycloneDX 1.6 JSON converter
│   └── SpdxBuilder.ts      SPDX 2.3 JSON converter
│
├── Upgrade/                one-click dep upgrade pipeline
│   ├── PackageJsonEditor.ts  surgical range bump, preserves indent + trailing-newline
│   ├── BackupStore.ts        timestamped snapshots in .nppm-backups/
│   ├── LifecycleScriptScanner.ts  walks node_modules/* for install hooks
│   └── Upgrader.ts           orchestrator: preview / applyEdit / runInstall / runRebuild
│
├── Releases/               npm registry + GitHub Releases merge
│   ├── Releases.ts
│   └── ReleasesFetcher.ts
│
├── DepGraph/DepGraphBuilder.ts  flat-graph walker, npm hoisting algorithm
├── History/                per-project change log
│   ├── History.ts
│   └── HistoryStore.ts     atomic-write JSON in .nppm-history/
│
├── Frontend/               every browser-side module
│   ├── Nppm.ts             top-level orchestrator (panes, routing)
│   ├── Matrix.ts           global matrix view
│   ├── ProjectMatrixView.ts  per-project matrix
│   ├── PackageList.ts      declared-deps table
│   ├── InstalledView.ts    lockfile/node_modules table + analyze bar
│   ├── HistoryView.ts      timeline cards
│   ├── DepTreeView.ts      D3-collapsible tree
│   ├── UnusedView.ts       per-project depcheck-style report (unused/misplaced/missing)
│   ├── UpgradeModal.ts     overlay: preview → edit/install → lifecycle-scripts list + Run buttons
│   ├── GlobalScanView.ts   SSE-driven global scan results
│   ├── PackageDetailPanel.ts  modal w/ 5 tabs (Files/Deps/Diff/Releases/Security)
│   ├── Treeview.ts         left-pane project list
│   ├── Resizer.ts          splitter logic
│   ├── Api.ts              `fetch()` wrapper
│   ├── I18n.ts             public i18n API + LANGUAGES + LOCALES registry
│   ├── Locales/en.ts       English translations (source-of-truth identity map)
│   ├── Locales/de.ts       German translations
│   ├── Version.ts          shared cleanRange helper
│   └── logo.svg            32×32 brand mark
│
├── tests/                  vitest, all unit, no network
└── doc/                    user-facing manuals + screenshot script
```

## API routes (in `vite.config.ts`)

| Method | Path                                                  | Purpose |
|--------|-------------------------------------------------------|---------|
| GET    | `/api/projects`                                       | list configured projects + counts |
| GET    | `/api/projects/:id/packages`                          | flat manifest list of one project |
| GET    | `/api/projects/:id/lockfile`                          | parsed lockfile (or `node_modules` fallback) |
| GET    | `/api/projects/:id/lockfile/analyze`                  | SSE per-project OSV scan |
| GET    | `/api/projects/:id/history`                           | per-project change log |
| GET    | `/api/projects/:id/matrix`                            | per-project matrix |
| GET    | `/api/projects/:id/depgraph`                          | flat resolved dep graph |
| GET    | `/api/projects/:id/unused`                            | depcheck-style hygiene scan (unused / misplaced / missing) |
| GET    | `/api/projects/:id/sbom?format=cyclonedx\|spdx`       | Software Bill of Materials (default: cyclonedx) |
| POST   | `/api/projects/:id/upgrade/preview`                   | plan a single dep range bump (returns before/after + SecurityReport) |
| POST   | `/api/projects/:id/upgrade/apply`                     | SSE: write backup + edit; if `mode=install`, also stream `npm install --ignore-scripts` |
| GET    | `/api/projects/:id/lifecycle-scripts`                 | install/postinstall/prepare hooks across `node_modules/*` |
| POST   | `/api/projects/:id/lifecycle-scripts/run`             | SSE: `npm rebuild <pkg>` — gated by `actions.allowInstall` |

## Headless CLI

`nppm scan` reuses the same `nppm.json`, `.nppm-cache/`, and scanner
classes as the dev server. It does *not* serve HTTP — `cli/scan.js`
spins up a Vite dev server in `middlewareMode:true, appType:'custom'`
purely to call `ssrLoadModule('./Cli/Scan.ts')`, then closes it. No
new dependency: Vite is already a runtime dep.

The runner pipeline per project:
1. `Project.loadLockfile()` → flat package list, deduplicated by
   `name@version`.
2. `OsvClient.queryBatch(...)` for CVE IDs (skipped on `--no-osv`).
3. `SecurityScanner.scanHeuristicsBatch(...)` for scripts / patterns /
   binaries / maintainer / license (skipped on `--no-heuristics`).
4. `UnusedDetector.scan(project)` for the depcheck-style buckets
   (skipped on `--no-unused`).

The per-scanner severity enums are mapped to a unified
`UnifiedSeverity` (`info|warn|risk`) in `Cli/ScanReport.ts`. License
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
| GET    | `/api/releases`                                       | registry + GitHub-merged release list |

## Storage

- `.nppm-cache/` — TTL caches (registry, remote, security, releases) and a
  permanent fingerprint cache. Safe to delete; auto-rebuilt.
- `.nppm-history/` — append-only per-project history JSON. **Do not** put
  in `.nppm-cache/` because the user wants to keep / commit it.

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
  `t()`. Add new strings to `Frontend/Locales/en.ts` AND `de.ts` (or
  rely on the en-fallback for a while).
- **No new framework dependency.** D3 is the only client lib; everything
  else is hand-rolled DOM.

## Tests

`vitest`. Tarballs are built in-memory with synthetic tar blocks (see
`tests/TarballParser.test.ts` for the builder). No fixture files live in
the repo, no network mocks via msw/nock — fetch is stubbed via DI
(`TarballFetcher`, `OsvFetcher`, `GithubReleasesFetcher`).

## Phases (historical)

The roadmap in `~/.claude/projects/.../memory/project_roadmap.md`
captures the sequence of work that built the system; this file replaces
that as the durable reference once the project ships.