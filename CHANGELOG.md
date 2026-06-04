# Changelog

All notable changes to nppm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from `v1.0.0` onwards.

## [Unreleased]

### Added
- **Dashboard: Scanner Score + Overall Evaluation tabs.** The
  cross-project scanner matrix is now under the Scanner Score tab;
  the new Overall Evaluation tab renders an ecosystem hero card —
  a 3:2 forest-themed scene with ten translucent metric boxes
  (projects, ecosystem health, healthy / at-risk counts, total
  risk findings, CVE / deprecation / maintainer / typosquat flags)
  laid out around a central tree, each connected to its visual
  anchor by a glowing SVG line. Boxes carry hover tooltips and
  click into a detail modal (`EcosystemBoxModal`) with the
  matching breakdown (project lists, per-scanner averages, per-
  package roll-ups). Both tabs render from the same `_columns`
  map, so a live scan fills them in parallel.
- **Dashboard: per-package progress detail.** The progress bar's
  status line now reads sub-phases verbatim ("Querying OSV.dev
  for 84 package(s)", "Fingerprinting lodash@4.17.21 (32/84) —
  kavula", "Churn for axios@1.6.0 (18/84) — kavula") instead of
  freezing on a "0/84" counter while parallel batches run.
- **Dashboard: persistent SSE across tab switches.** Leaving and
  returning to Dashboard no longer kills the running scan — the
  stream survives view switches and the DOM is reused.
- **Dashboard: manifest fallback for lockfile-less projects.**
  Projects without a committed `package-lock.json` (browser
  extensions, many libraries) used to collapse every cell to
  N/A. They're now scanned against the registry's `latest` for
  each declared dep; cells light up the same way, and a small ⓘ
  next to the project name carries a "no lockfile — scanned
  against registry latest" tooltip. Integrity and
  MutableResolution stay N/A because they need a lockfile to
  walk.
- **Treeview rings driven by the Dashboard score.** The
  per-project health ring is now fed by the Dashboard's
  21-scanner score with a Matrix fallback for projects the
  Dashboard hasn't scored yet, so the treeview number matches
  what the Dashboard cell says.
- **Matrix: git HEAD info.** The Latest column for git-only rows
  now shows `1.0.28 · 7d3f12a` (version + short SHA from upstream
  HEAD) instead of the bare `git` pill. Works for GitHub and
  Gitea hosts; unsupported hosts stay silent. HEAD-lookup
  failures surface an orange ⓘ next to the pill with the raw
  error in the tooltip. The same path runs in the per-project
  matrix.
- **Releases tab for git deps.** Git-installed packages now
  show their upstream commits (GitHub REST + Gitea v1) in the
  same `Release`-card shape as registry publishes, with SHA,
  subject and author.
- **Releases tab: collapsed to 5 with "Load all".** Both git
  commit timelines and long npm release histories (lodash is
  60+ versions) now collapse to the five newest with an "Alle
  laden (N)" button. Reopening a different package starts
  collapsed again. Cap at 50 entries.
- **Diff tab for git deps.** Packages installed via `git+…#ref`
  now have a working Diff tab — the pinned tarball is compared
  against HEAD. Non-SHA-pinned coordinates skip the permanent
  fingerprint cache so HEAD content is never served stale.
- **DepTree manifest fallback.** Projects without a lockfile
  used to 404 the Tree view; it now synthesises a shallow first-
  level tree from the declared root deps (range as version,
  registry `latest`, empty `deps[]`) with a banner explaining
  why no transitive deps are visible.
- **PR Review: friendly remote banner.** Remote projects no
  longer surface the raw 400 — the view short-circuits with a
  one-liner pointing at the remediation ("clone locally").
- **Read-only banners for remote projects.** ProjectMatrixView
  and TemplateView hide the write affordances (upgrade `↑`,
  "Apply selected") on GitHub / Gitea projects and render a
  small "Read-only: remote project — upgrades and template apply
  are disabled." banner so the missing button doesn't look like
  a bug.
- **Start-view sentinel selected on first paint.** Booting on
  Dashboard or Matrix now highlights the matching treeview row,
  matching the behaviour of every later view switch.
- **`npm run typecheck`** — wired up so the tsc gap stays
  visible going forward. `moduleResolution` switched to
  `bundler` so Vite's exports-map types resolve.

### Changed
- **GitHub URL normalisation in project create / edit.** The
  form's "Repo (owner/name)" field now accepts the full
  address-bar URL too (`https://github.com/owner/repo`,
  `git@github.com:owner/repo.git`, `github:owner/repo`); the
  entry writer collapses it to the canonical `owner/name` shape
  before writing `nppm.json`. Already-broken entries from
  earlier boots keep working silently.
- **Background matrix fetch on Dashboard-first landings.**
  `startView=dashboard` used to leave the treeview rings at "…"
  until the user clicked Matrix manually. The matrix now fires
  alongside the Dashboard show so the score side-effect runs
  without rendering anything.
- **Treeview rings stay at "…" until the first severity batch
  lands** instead of flashing 100 % for a frame while the
  badge loaders are still in flight.
- **`Api._json` surfaces the backend's `msg` field on non-OK
  responses** instead of hardcoding `${url} → 404 Not Found`,
  so e.g. the DepTree view on a lockfile-less remote project
  shows the actual remediation text. Two stray German backend
  error strings flipped back to English for consistency with
  the backend-strings-stay-English rule.
- **Bumped minimum Node version from 20 to 22.** Node 20 went EOL on
  2026-04-30; current LTS is Node 22. The CI workflow already runs
  Node 22, and `puppeteer@25` (used by the screenshot generator)
  requires Node 22.12+.

### Fixed
- **Git-only Latest collision in the per-project matrix.** The
  per-project matrix used to surface a foreign npm package's
  `0.0.0` as the registry `latest` for a row where every
  workspace declared the dep via a git URL. Same `latest=null`
  + `gitLatest` HEAD-stamp pipeline as the cross-project matrix
  is now applied to the per-project one.
- **Name-keyed data leaks for git-sourced deps.** License,
  provenance and typosquat checks used to take the foreign
  packument at face value for git-installed deps that happened
  to share a name with an unrelated npm package. The Dashboard
  pipeline now feeds the git URL through as the scanner version
  so the existing `isGitVersion` guards fire; License falls
  back to silence, Provenance and Typosquat to null.

### Security
- **SafePath containment for project-rooted writes.** Two
  endpoints used to join user-supplied path segments with the
  project root unchecked. `POST /api/projects/:id/upgrade/apply`
  trusted the `workspace` field (`../../etc/cron.d/evil`
  collapsed to an out-of-root write), and
  `POST /api/projects/:id/compliance/apply` trusted the `path`
  of every template file entry (a malicious remote template
  could ship a finding that escapes the root). Both endpoints
  now route through `SafePath.join`, which resolves the
  candidate against the root and refuses anything that isn't
  either the root itself or a strict descendant of
  `${root}${sep}` — the trailing-separator check stops a
  sibling like `/srv/project-evil` from squeaking past a plain
  `startsWith(root)`. Tests cover trailing `..`, deep `../..`
  chains, absolute segments, and sibling-with-shared-prefix.

## [1.0.0] — initial public release

The baseline shipped surface — everything reachable from the current
`main` branch.

### Scanners (21, surfaced as Dashboard rows)

- **CVE / OSV.dev** — single + batched vulnerability lookups, cached
  per `name@version`.
- **License** — five-bucket SPDX classifier (permissive /
  weak-copyleft / strong-copyleft / proprietary / unknown) with a
  mini SPDX-expression parser plus configurable allow / deny lists
  and `treatUnknownAs` policy.
- **Install scripts** — lifecycle-hook heuristic (info / warn / risk)
  reading the tarball manifest.
- **Code patterns** — regex scan of JS for risky constructs
  (`eval(`, `new Function(`, `child_process`, base64-decoded eval,
  Discord / Slack / Telegram webhook URLs, pastebin / ngrok / raw-IP
  endpoints, AWS credential env reads, generic credential-shaped
  env reads, the `_0x[a-f0-9]+` obfuscator.io fingerprint).
- **Binaries** — extension-based + bin/-path-aware classification of
  native files inside the tarball.
- **Obfuscation** — per-JS-file heuristic combining
  `eval(atob(...))` / `new Function(atob(...))` chains, `_0x`
  identifier density, hex-string arrays, and pathologically long
  lines. Build-artifact paths (`dist/`, `*.min.js`, …) are
  recognised and capped at info-grade so legitimate minification
  doesn't pollute the result.
- **Manifest red-flags** — pure heuristics over `package.json`:
  missing README / description / `files[]` allowlist, many `bin`
  entries, the native-build + postinstall combo, dated
  `engines.node` range. Severity stacks (1 flag = info, 2 = warn,
  3 or the malicious combo = risk).
- **Capability inventory** — per-package set of platform APIs the
  JS files touch (`fs.read/write`, `http`/`fetch`, raw sockets,
  `child_process`, credential-shaped env reads, native bindings,
  `eval`). Severity is by *combination* (spawn + network = risk,
  single capability = info).
- **Maintainer / publisher** — compares each version's `_npmUser`
  against the trust set of recent predecessors. Short gap + new
  publisher on a mature package = risk (event-stream / ua-parser-js
  takeover profile); long-silence handovers stay info (likely
  community takeover). Pulls 2FA flag + account-creation date from
  the npm user endpoint when available.
- **Churn** — tarball-level diff against the previous stable
  release; outsized add / remove / modify counts for a patch or
  minor bump are flagged.
- **Cadence** — release-frequency analysis (days since last release
  + median gap). Flags abandoned-looking and unusually bursty
  packages.
- **Freshness** — combines package age (`time.created`) with
  publisher account age. The worst-of-two is rendered as `risk`
  (< 7 d), `warn` (< 30 d), or `info`.
- **Ignore-scripts recommendation** — per-package verdict on
  whether `npm install --ignore-scripts` is safe / needed / risky.
- **Typosquat / homoglyph** — Levenshtein-distance to a curated
  150-entry popular-package list plus Unicode confusables check.
  Distance 1 OR confusable = risk; distance 2 = warn.
- **Provenance** — reads `dist.attestations` + `dist.signatures`
  from the packument; classifies each version as `provenance`
  (Sigstore-attested), `signed` (registry-only) or `unsigned`.
  Surfaced as a positive `PROV ✓` matrix badge for the rare
  attested ones.
- **External sources aggregator** — bundles socket.dev (supply-
  chain risk score, needs API key), OpenSSF Scorecard (repo
  development practices, free), deps.dev (Google package index,
  free). Worst-of-three severity per package, configurable per
  source.
- **Deprecation** — reads per-version `deprecated` from the
  packument. Shows the maintainer's reason verbatim. Risk for the
  installed version, warn for `latest`.
- **Integrity** — cross-checks lockfile `resolved + integrity`
  against the registry; detects mirror-hijack / dependency-
  confusion / lockfile-injection.
- **Mutable resolution** — per-project lockfile sweep for entries
  that can't be reproduced deterministically: mutable git refs,
  missing integrity hashes, `file:` / `link:` protocols.
- **Unused** — depcheck-style per-project hygiene scan (unused /
  misplaced / missing).
- **Template compliance** — diffs the project against the templates
  it declares.

### Views

- **Cross-project matrix** — packages as rows, projects as columns;
  with the **Badge filter** modal for hiding individual badge
  families. Toolbar carries filters (all / issues / drift /
  outdated / unsafe / licenses), search, sort by name / status /
  severity. Workspaces collapse to one column per project with a
  `WS` badge surfacing per-workspace drift on click.
- **Cross-project Dashboard** — per-(project × scanner) score
  matrix with a 0–100 % score per cell, identical formula as the
  per-project health ring. SSE-streamed rescan + cached snapshot
  for instant first paint. Click drills into a findings modal with
  top-50 contributors.
- **Cross-project Impact Analysis** — topbar button; BFS over every
  project's resolved dep graph to answer "which projects pull in
  `<name>` directly or transitively, via which shortest path?".
- **Per-project matrix** — workspaces as columns instead of other
  projects.
- **Per-project sub-views** — Declared, Installed, History,
  Matrix, Tree (D3 collapsible), Unused, Vulns (retroactive
  vulnerability timeline), PR (PR-Review-Mode).
- **Package detail panel** — five tabs (Files, Dependencies,
  Releases, Security, License) with collapsible Security cards
  that auto-expand on warn / risk findings.
- **Health ring per project** — small 0–100 % SVG ring on every
  project entry in the treeview, fed by the same aggregate score
  the Dashboard uses.
- **Templates** view + per-project Template tab — cross-project
  compliance matrix + grouped findings + Apply-selected workflow
  with timestamped backups.
- **Settings dialog** — tabbed editor over the non-`projects`
  sections of `nppm.json` with a "Clear cache now" button that
  warms the registry + OSV pockets afterwards.
- **Vulnerability Timeline** — forward-replays per-project history
  against the OSV cache; classifies each (CVE, name@version,
  interval) as `known-at-install` / `disclosed-during-use` /
  `pre-tracking`. Git backfill button reconstructs history from
  `git log -- package-lock.json`.
- **PR Review** — diffs `package.json` + `package-lock.json`
  between two git refs (default `main` vs `HEAD`) with CVE
  delta pills per changed dep.

### CLI

- `nppm dev` — start the Vite-hosted dev server (default).
- `nppm scan` — headless CI scan; emits text, `--json`, or
  `--sarif` for GitHub Code Scanning. `--fail-on=info|warn|risk|
  none` gate.
- `nppm sbom` — emits CycloneDX 1.6 or SPDX 2.3 JSON.
- `nppm action` — GitHub Actions entry: runs scan + writes SARIF +
  posts sticky PR comment with the CVE delta.

### GitHub Action

- Composite action under `.github/actions/scan/` wrapping `nppm
  scan --sarif` for native Code Scanning upload plus an upsert-
  in-place sticky PR comment built from the same `PrReviewBuilder`
  the dev UI uses. Disabled-by-default for PRs from forks unless
  the workflow grants `pull-requests: write`.

### Cache pockets

- `registry/` — npm packuments (TTL)
- `remote/` — GitHub / Gitea contents API responses (TTL,
  `{data: null}` envelope for cached 404s)
- `fingerprint/` — permanent tarball fingerprints incl. per-JS
  source content (cache-version key `fp_v6_*`)
- `security/` — OSV.dev (TTL)
- `releases/` — GitHub Releases API (TTL)
- `bundlephobia/` — bundle-size / transitive-count (permanent)
- `npm-user/` — npm user-doc enrichment, 2FA flag + account
  creation date (TTL)
- `external-socket/` — socket.dev per-package score (TTL)
- `external-openssf/` — OpenSSF Scorecard (TTL)
- `external-depsdev/` — deps.dev v3 version metadata (TTL)
- `templates-remote/` — remote template bodies
- `dashboard-snapshot.json` — last Dashboard scan result (instant
  first paint)

### History (separate from cache)

- `.nppm-history/` — append-only per-project change log next to
  `nppm.json` so it's safe to commit / inspect / audit
  independently of the caches.

### i18n

- English (default) + German.

### Tests

- 641 unit tests, no network. Tarballs built in-memory from
  synthetic tar blocks; fetchers stubbed via DI.

[Unreleased]: https://github.com/stefanwerfling/nppm/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/stefanwerfling/nppm/releases/tag/v1.0.0