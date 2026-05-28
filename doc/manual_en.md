<p align="center">
  <img src="logo.svg" width="64" height="64" alt="nppm" />
</p>

# nppm — User Manual

> 🇩🇪 Deutsche Version: [`manual_de.md`](manual_de.md)

This walkthrough mirrors what you see in nppm after pointing it at your
own `nppm.json`. All screenshots are generated against the *current*
configured projects via `npm run docs:screenshots` — re-run that any
time the UI changes.

## Table of contents

1. [The cross-project matrix](#1-the-cross-project-matrix)
2. [Drilling into one project](#2-drilling-into-one-project)
   - [Declared dependencies](#21-declared-dependencies)
   - [Installed dependencies](#22-installed-dependencies)
   - [Per-project matrix](#23-per-project-matrix)
   - [Dependency tree](#24-dependency-tree)
   - [History](#25-history)
   - [Unused dependencies](#26-unused-dependencies)
3. [Package detail panel](#3-package-detail-panel)
   - [Files](#31-files)
   - [Dependencies](#32-dependencies)
   - [Releases](#33-releases)
   - [Security](#34-security)
4. [Global CVE scan](#4-global-cve-scan)
5. [Headless CI mode](#5-headless-ci-mode)
6. [Switching language](#6-switching-language)

---

## 1. The cross-project matrix

This is the landing view. Rows are **packages**, columns are
**projects** plus a trailing **Latest** column from the npm registry.
Cell colour indicates the row status:

- 🟢 **aligned** — every project that pins this package uses the same
  range *and* the range resolves to the registry latest.
- 🟡 **outdated** — every project agrees, but the registry has a newer
  version.
- 🔴 **drift** — at least two projects disagree on the version.
- ⚪ **unknown** — registry lookup failed.

![Cross-project matrix](screenshots/01_matrix.png)

**Filters** at the top-left: `All / Issues / Drift / Outdated / Unsafe /
Licenses` (the last one shows only packages with strong-copyleft,
proprietary, or unknown licenses).
The **search box** does case-insensitive substring matching on the
package name. **Sort:** by name, by status (most urgent first), or by
aggregated security score.

**Badges in the name cell:**

- `CVE N` — N known OSV.dev vulnerabilities for the latest version.
- `SCRIPT` / `SCRIPT!` — lifecycle scripts at warn / risk level.
- `EVAL N` — N dynamic-code-execution patterns in the tarball.
- `BIN N` — N native binaries (`.exe / .dll / .so` …) in the tarball.
- `OWNER!` — quick owner handover on a mature package (classic
  account-takeover profile — see the maintainer scanner below).
- `GPL` / `UNLIC` / `LIC?` — license classification: strong-copyleft /
  proprietary / unknown (see the License tab below).
- `WS` — workspaces within one project disagreed.

**Git-pinned dependencies** show the *installed* version as the cell
value plus a small `git` chip; hovering reveals the original URL.

Clicking a cell opens the [package detail panel](#3-package-detail-panel).
Clicking a project column header drills into that project.

---

## 2. Drilling into one project

Picking a project in the left treeview lands you in a six-tab project
view: **Declared / Installed / History / Matrix / Tree / Unused**. The
toggle is the same in every tab so navigation is one click away
regardless of where you are.

### 2.1 Declared dependencies

Flat table of every dependency declared in the project's `package.json`
(root + workspaces).

![Declared deps](screenshots/02_declared.png)

### 2.2 Installed dependencies

What npm actually resolved on disk. The view shows the *source* used:

- **`package-lock.json v3`** — committed lockfile (best fidelity).
- **`node_modules/.package-lock.json v3`** — npm's hidden mirror,
  exactly the same data, written on every `npm install` — used when the
  committed lockfile is gitignored.
- **Generated from `node_modules`** — last-resort flat walk when no
  lockfile exists (no `dev` / `peer` / `optional` flags).

![Installed deps](screenshots/03_installed.png)

The **Start analysis** button kicks off a per-project SSE-streamed OSV
check; the CVE column fills row-by-row while the progress bar runs.

### 2.3 Per-project matrix

Same shape as the global matrix, but columns are the project's
*workspaces* instead of other projects. Use it when one project's own
workspaces drift.

![Per-project matrix](screenshots/04_project_matrix.png)

### 2.4 Dependency tree

D3 collapsible tree. Root = the project, children = top-level deps,
expanding any node loads its sub-dependencies on demand. Node colour
matches the status semantics; an outlined node has hidden children left
to expand.

![Dep tree](screenshots/05_tree.png)

### 2.5 History

Every time nppm loads this project's lockfile, it diffs against the
prior snapshot and appends an entry when anything changed. The reason
field is auto-generated from the semver bump type, with a CVE hint when
the outgoing version had known vulnerabilities in the OSV cache.

![History](screenshots/06_history.png)

History files live in `.nppm-history/` next to your `nppm.json` — safe
to commit if you want long-term audit trails.

### 2.6 Unused dependencies

A depcheck-style hygiene scan of the project's source tree. The tab
groups findings into three lists:

- **Unused** — declared in `package.json` but nothing under `src/`
  imports them. Severity is `risk` for genuine candidates and `info`
  for entries the scanner deliberately spared (allowlist / `scripts:`
  reference / `@types/X` whose `X` is imported).
- **Misplaced** — imported only from dev paths (`*.test.*`,
  `*.spec.*`, `tests/`, `*.config.*`) but listed in `dependencies`
  instead of `devDependencies`. Fix is a `package.json` edit.
- **Missing** — imported from source but not declared anywhere.
  Usually a transitive leak, sometimes a forgotten peer dep.

The scanner is regex-based (no AST parse). Dynamic specs like
`import(varName)` cannot be resolved; affected files are listed
separately so the unused list isn't mistaken for authoritative there.

A default allowlist covers the bin-tools that nearly every npm
project keeps in `devDependencies` (`vite`, `vitest`, `tsx`,
`typescript`, `eslint`, `prettier`, `husky`, `rimraf`, `cross-env`, …)
plus the well-known `tsc → typescript` bin alias. Add your project's
extras via `security.unused.allowlist` in `nppm.json` — the default
list is *unioned*, not replaced, so a one-line override doesn't
re-introduce a wall of false positives.

Remote projects (GitHub / Gitea) currently show "not supported here"
because the contents-API per-file fetch would blow the rate-limit
budget in v1.

---

## 3. Package detail panel

Clicking a matrix cell opens a modal with five tabs.

### 3.1 Files

Per-file SHA-256 + size of every file in the tarball. The header shows
total file count and total bytes.

![Detail: Files](screenshots/07_panel_files.png)

### 3.2 Dependencies

What the package itself declares as `dependencies`, `devDependencies`,
`peerDependencies`, `optionalDependencies`. Pulled directly from the
tarball's `package.json` (cached permanently).

![Detail: Dependencies](screenshots/08_panel_deps.png)

### 3.3 Diff

Compares the cell version against the registry latest, file-by-file:
added / removed / modified. Lazy-loaded the first time the tab opens.

### 3.4 Releases

Merged timeline:

- Registry publish dates (always available)
- Per-version publisher (`_npmUser`) — shown as `by <name>` next to the
  date so owner handovers are visible at a glance in the timeline.
- GitHub release titles + notes (when the package's `repository` field
  points at github.com)

The number on the right is a direct link to the GitHub release page.
Set `GH_TOKEN` in your `.env` to lift the 60 req/h anonymous rate
limit.

![Detail: Releases](screenshots/09_panel_releases.png)

### 3.5 Security

Aggregates six scanners (license has its own tab — see 3.6):

- **CVEs** from OSV.dev (single-version query, deep results)
- **Install-scripts** — lifecycle hooks classified info/warn/risk
- **Code patterns** — `eval(`, `new Function(`, `child_process`, base64
- **Binaries** — native code in the tarball
- **File churn** — comparison against the previous stable version
- **Maintainer / Publisher** — compares the `_npmUser` of the chosen
  version against the trust set of recent predecessors.

The maintainer scanner's severity is driven by **how quickly the owner
changed** on a mature package — the empirical attack pattern (event-
stream, ua-parser-js, coa, rc, @solana/web3.js) is "active project,
sudden new publisher", not "dormant project, new maintainer".

| Gap to previous version | Severity |
|-------------------------|----------|
| ≤ 30 days + ≥10 predecessors | `risk` — takeover profile |
| 31 – 180 days + ≥10 predecessors | `warn` — unusual, worth a look |
| > 180 days | `info` — likely a legitimate community takeover of an abandoned package |

Thresholds are tunable in `nppm.json` under
`security.maintainer.{quickHandoverDays,suspiciousGapDays,matureVersions,trustWindow}`.

When `Maintainer = risk` **and** `Churn = warn/risk` hit the same
release, the panel shows a red **"possible supply-chain attack"**
banner at the top — that is the pattern the real-world takeovers
listed above all shared.

A "git package" note appears for git-installed dependencies because OSV
only indexes registry versions — the other scanners still run normally.

![Detail: Security](screenshots/10_panel_security.png)

### 3.6 License

A dedicated tab for compliance questions. Classifies the package's
`license` field into five buckets:

| Bucket | Examples | Meaning |
|--------|----------|---------|
| `permissive` | MIT, Apache-2.0, BSD-*, ISC | No obligations |
| `weak-copyleft` | LGPL-*, MPL-2.0, EPL-2.0 | File-level boundary, mostly accepted |
| `strong-copyleft` | GPL-*, AGPL-* | Viral, derivatives must release source |
| `proprietary` | `UNLICENSED`, `SEE LICENSE IN …` | No redistribution without contract |
| `unknown` | not in the SPDX catalogue | Not classifiable — manual review |

A mini SPDX-expression parser handles compound forms like
`(MIT OR Apache-2.0)` (for OR the most permissive bucket wins — the
user gets to pick) and `MIT AND GPL-3.0` (for AND the most restrictive
— all obligations apply). `WITH` clauses
(`Apache-2.0 WITH Classpath-exception-2.0`) don't change the bucket.

The tab also lists the **actual `LICENSE*` / `COPYING*` files shipped
in the tarball** — a cross-check against the manifest's self-report.

**Policy in `nppm.json`:**

```json
"security": {
  "license": {
    "allowlist": ["MIT", "Apache-2.0", "BSD-*", "ISC"],
    "denylist": ["AGPL-*"],
    "treatUnknownAs": "proprietary"
  }
}
```

`allowlist` overrides the bucket to `permissive`, `denylist` to
`proprietary` (denylist wins on conflict). `treatUnknownAs:
"proprietary"` forces any package without a recognised license into
manual review.

---

## 4. Global CVE scan

The **Scan all** button in the topbar opens an SSE stream that walks
every configured project's lockfile, dedupes `name@version` across the
whole set, and queries OSV in chunks of 50. The topbar progress bar
shows both the collection phase and the OSV phase.

Results land in a fifth right-pane view: every unique `name@version`
across all projects, with vuln count and the list of projects that
pulled it in. The **Only issues** checkbox filters down to rows with
known CVEs.

A subsequent scan is instant for any `pkg@version` already in the OSV
cache — only new entries cost a network round-trip.

---

## 5. Headless CI mode

`nppm scan` is the same set of scanners as the dev server but
non-interactive — designed to drop into a CI pipeline.

```sh
nppm scan                              # everything, fail on risk
nppm scan --project=alpha --json       # one project, machine-readable
nppm scan --fail-on=warn               # tighter gate
nppm scan --no-osv --no-heuristics     # offline / lockfile-free
```

What the run does for each configured project (or the `--project=…`
subset):

1. Reads the lockfile and deduplicates `name@version`.
2. Hits OSV.dev for CVE IDs (unless `--no-osv`).
3. Walks the heuristic batch — scripts / patterns / binaries /
   maintainer / license — over the same fingerprint cache the dev
   server populates (unless `--no-heuristics`).
4. Runs the unused-deps detector (unless `--no-unused`).

Every per-scanner severity collapses onto an `info / warn / risk`
ladder; `--fail-on=<level>` sets the threshold for a non-zero exit.
License classifications fold in: `permissive` is silent, weak-copyleft
and unknown surface as `info`, strong-copyleft as `warn`, proprietary
as `risk`. OSV vulnerabilities are uniformly `risk` (matches `npm
audit --audit-level=high`).

Output is human-readable text by default; pass `--json` for a
machine-readable payload or `--sarif` for a SARIF 2.1.0 envelope that
GitHub Code Scanning ingests directly (`actions/upload-sarif`). The
CLI reuses `.nppm-cache/` and `.nppm-history/`, so a warm CI run is
fast: warm OSV + warm fingerprint = no network for already-seen
packages.

Exit codes:

- `0` — clean, or all findings below `--fail-on`
- `1` — at least one finding at or above `--fail-on`
- `2` — usage / config error (bad flag, missing `nppm.json`)

Example GitHub Actions step:

```yaml
- run: npx nppm scan --fail-on=risk --json > nppm-report.json
```

For Code-Scanning ingest:

```yaml
- run: npx nppm scan --fail-on=none --sarif > nppm.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: nppm.sarif
```

## 6. Switching language

The flags in the top-right corner switch the UI language. Default is
English, German is shipped. Adding a third language is a three-step
edit — see [`CLAUDE.md`](../CLAUDE.md) for the procedure.

Language choice is remembered in `localStorage` (`nppm.lang`) and
applies on the next page load.