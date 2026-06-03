# Changelog

All notable changes to nppm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from `v1.0.0` onwards.

## [Unreleased]

### Added
- Community-facing repository docs: `SECURITY.md` (private vulnerability
  reporting via GitHub Security Advisories), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), issue + PR
  templates, and this changelog itself.

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