<p align="center">
  <img src="doc/logo.svg" width="96" height="96" alt="nppm logo" />
</p>

# nppm — Node Project Package Manager

A local-first dashboard that compares npm dependency versions across many
projects at once and surfaces drift, outdated packages, CVEs, install-time
risks, and binary file presence in a single view. Backend lives inside a
Vite dev server, frontend is plain TypeScript + DOM (no framework).

![Matrix view](doc/screenshots/01_matrix.png)

## Features

- **Cross-project matrix** — packages as rows, projects as columns, traffic
  lights for `aligned / outdated / drift / unknown`. Workspaces collapse to
  one column per project (with a `WS` badge when the project's own
  workspaces disagree).
- **Per-project matrix** — workspaces split into individual columns so you
  see drift inside one project at a glance.
- **Project sub-views** for each configured project: `Declared`
  (`package.json`), `Installed` (resolved from lockfile or `node_modules`),
  `History`, `Matrix`, `Tree`.
- **Dependency tree** — D3-based collapsible tree of every resolved package
  with status colouring (green / yellow / red / grey).
- **Security scan**
  - OSV.dev CVE lookups (single + batched)
  - Install-script heuristic (`curl | bash`, `node -e`, `eval`, …)
  - Code-pattern heuristic (`eval(`, `new Function(`, `child_process`, base64)
  - Binary-file detection (`.exe / .dll / .so / .node / .wasm` + bare
    binaries under `bin/`)
  - File-churn detection (suspiciously large patch bumps)
  - Maintainer-handover detection — compares each version's `_npmUser`
    against the publishers of the recent predecessors. Short gap + new
    publisher on a mature package raises `risk` (event-stream /
    ua-parser-js profile); long-silence handovers stay `info` (usually
    a legitimate community takeover). Risk + churn together surface a
    "possible supply-chain attack" banner.
  - License classification — five-bucket SPDX classifier (permissive /
    weak-copyleft / strong-copyleft / proprietary / unknown) with a
    mini SPDX-expression parser (`OR` / `AND` / `WITH` / parens). Own
    tab in the detail panel + `GPL` / `UNLIC` / `LIC?` matrix badges +
    a "Licenses" matrix filter. Compliance teams can plug in allow- /
    denylists via `security.license` in `nppm.json`.
- **One-click upgrade** — outdated cells in the per-project matrix
  show a small `↑` button. The Upgrade modal previews the planned
  `package.json` edit, surfaces a security heads-up on the target
  version (CVEs, install scripts, maintainer switch, churn), and
  offers two paths: "Edit only" (always available, just writes the
  file + suggests a manual `npm install`) or "Edit + install
  `--ignore-scripts`" (gated by `actions.allowInstall=true` in
  `nppm.json`). After install, the modal lists every install
  lifecycle hook in `node_modules` with a per-package "Run" button
  (`npm rebuild <pkg>`) so the user can re-fire only the scripts
  they've reviewed. Backups land in `.nppm-backups/<timestamp>/`.
- **SBOM export** — `nppm sbom --format=cyclonedx|spdx` (or the
  `GET /api/projects/:id/sbom?format=…` endpoint) emits a Software
  Bill of Materials for one project. CycloneDX 1.6 and SPDX 2.3 JSON.
  Walks the lockfile + registry for licenses/hashes — no fingerprint
  downloads. Drops into Trivy, Dependency-Track, FOSSA, npm audit
  signatures, anything that consumes the standards.
- **Headless CLI / CI mode** — `nppm scan` runs every scanner (OSV CVEs,
  scripts, patterns, binaries, maintainer, license, unused-deps) over
  every configured project, prints a compact text report or `--json`
  for pipelines, and exits non-zero when any finding meets the
  `--fail-on=info|warn|risk` threshold. Same caches as the dev server,
  so a warm second run is fast.
- **Unused-deps detector** — depcheck-style per-project hygiene scan.
  Three buckets: unused (declared but never imported), misplaced
  (imported only from dev paths but listed as a regular dep), missing
  (imported but undeclared). Built-in allowlist covers the usual
  bin-tools (`vite`, `vitest`, `tsx`, `typescript`, `eslint`, `prettier`,
  `husky`, …); `scripts:` references are recognised too. Pure regex +
  filesystem walk — no AST parse, no network. Remote projects are
  not in scope for v1. Own `Unused` tab in every per-project view.
- **History** per project — every lockfile call snapshots the package state
  and appends an entry for adds/removes/version changes (with CVE-hint
  reason when applicable). Stored next to `nppm.json` in `.nppm-history/`.
- **Releases tab** — registry timeline merged with GitHub release notes.
- **Global scan** — SSE-streamed CVE check across every project's lockfile,
  with progress bar in the topbar.
- **Git dependencies** — `git+https://`, `git@host:`, `github:` / `gitlab:`
  / `bitbucket:` shorthand all fetch tarballs from the right host and feed
  the same scanners.
- **i18n** — English by default, German included. Add a third language by
  dropping `Frontend/Locales/<id>.ts` and registering it in `I18n.ts`.

## Requirements

- Node ≥ 20
- A `nppm.json` in the directory you launch `nppm` from
- Projects either locally checked out or reachable via GitHub/Gitea contents
  API

## Setup

```sh
git clone https://github.com/stefanwerfling/nppm
cd nppm
npm install
```

## Configuration

Create a `nppm.json` next to where you run `nppm`. Minimal example:

```json
{
  "projects": [
    {"type": "local", "name": "kavula",       "path": "/home/me/code/kavula"},
    {"type": "local", "name": "swipemeister", "path": "/home/me/code/swipemeister"},
    {
      "type": "github",
      "name": "vts",
      "repo": "OpenSourcePKG/vts",
      "ref": "main",
      "token": "$GH_TOKEN"
    },
    {
      "type": "gitea",
      "name": "internal-app",
      "url": "https://git.example.com/team/internal-app",
      "token": "$GITEA_TOKEN"
    }
  ],
  "server": {"port": 5190},
  "browser": {"open": false},
  "registry": {"url": "https://registry.npmjs.org"},
  "cache": {"dir": ".nppm-cache", "ttlMinutes": 60},
  "security": {
    "maintainer": {
      "quickHandoverDays": 30,
      "suspiciousGapDays": 180,
      "matureVersions": 10,
      "trustWindow": 20
    },
    "license": {
      "allowlist": ["MIT", "Apache-2.0", "BSD-*", "ISC"],
      "denylist": ["AGPL-*"],
      "treatUnknownAs": "unknown"
    },
    "unused": {
      "allowlist": ["my-internal-cli"],
      "devPathGlobs": ["**/cypress/**", "**/*.bench.*"]
    }
  },
  "actions": {
    "allowInstall": false
  }
}
```

The `actions.allowInstall` flag is off by default; while off the
Upgrade modal can only write `package.json` (a backup is taken first;
`npm install` is left for the user to run by hand). Setting it to
`true` unlocks both the "Edit + install (--ignore-scripts)" button
and the per-package "Run" button on the lifecycle-scripts list.
Always runs with `--ignore-scripts` — re-firing hooks is explicit and
per-package, never automatic.

The `security.maintainer` block is optional and tunes the publisher-
handover detector. Defaults reflect the empirical attack patterns:
handovers ≤ 30 d on a mature package land as `risk`, ≤ 180 d as
`warn`, longer gaps as `info` (likely community takeover of an
abandoned package). Strict projects can drop `quickHandoverDays`.

The `security.license` block is also optional. Without it the scanner
uses its built-in SPDX classification (MIT / Apache / BSD → permissive,
LGPL / MPL → weak-copyleft, GPL / AGPL → strong-copyleft, UNLICENSED /
free-text → proprietary). Patterns support a trailing `*` wildcard;
denylist wins over allowlist when both match. Set `treatUnknownAs:
"proprietary"` to force a manual review for any package without a
recognised license.

The `security.unused` block is optional. `allowlist` is *added* to the
built-in bin-tool list (vite/tsx/eslint/…), so you only need to name
your project-specific extras — losing the defaults would re-introduce
a wall of false positives. `devPathGlobs` *replaces* the default
(`**/*.test.*`, `**/*.spec.*`, `**/tests/**`, `**/*.config.*`, …) when
non-empty so opinionated teams can shrink the dev-path set; leave it
out to keep the defaults.

`$VAR_NAME` references are expanded from the environment / `.env` at load
time, so secrets never live in the config file.

Optional `.env` next to `nppm.json`:

```
GH_TOKEN=ghp_xxx
GITEA_TOKEN=xxx
```

The GitHub token lifts the 60 req/h anonymous limit on the Releases API.

## Run

```sh
npm run dev
# 🚀 NPPM running at http://localhost:5190
```

Open the URL in a browser. The default port is `5190` (Vite's `5173`
would collide with `vtseditor` running alongside).

## CI mode

```sh
nppm scan                            # default: scan all, fail on risk
nppm scan --project=kavula --json    # one project, machine-readable
nppm scan --fail-on=warn             # tighter gate
nppm scan --no-osv --no-heuristics   # offline / lockfile-free fast run
nppm scan --sarif > nppm.sarif       # SARIF 2.1.0 for GitHub Code Scanning
nppm scan --help                     # full flag list
```

## SBOM export

```sh
nppm sbom --project=kavula                       # CycloneDX to stdout
nppm sbom --project=kavula --format=spdx         # SPDX 2.3 JSON
nppm sbom --project=kavula --output=bom.json     # write to file
nppm sbom --help                                 # full flag list
```

Same data via REST:
`GET /api/projects/:id/sbom?format=cyclonedx` (default) or `?format=spdx`.
Content-Type is set to `application/vnd.cyclonedx+json` /
`application/spdx+json` so MIME-aware tooling can route the payload.

`nppm scan` reuses the same `nppm.json` and `.nppm-cache/` as the dev
server, so a warm CI run skips network calls that have already been
made locally. Exit codes: `0` clean (or below threshold), `1` threshold
breached, `2` usage error (bad flag, missing config). Drop it into any
pipeline that understands non-zero exits.

## Usage

Read the screenshot-driven walkthrough:

- 🇬🇧 [`doc/manual_en.md`](doc/manual_en.md)
- 🇩🇪 [`doc/manual_de.md`](doc/manual_de.md)

## Caches

Cache pockets under `.nppm-cache/` (configurable):

- `registry/` — npm registry metadata (TTL)
- `remote/` — GitHub/Gitea contents API responses (TTL, `{data: null}`
  envelope for cached 404s)
- `fingerprint/` — full tarball fingerprints incl. per-JS file content
  (permanent — published `pkg@version` is immutable)
- `security/` — OSV.dev responses (TTL)
- `releases/` — GitHub Releases API responses (TTL)

History is **not** in the cache — it lives in `.nppm-history/` next to
`nppm.json` so you can commit / inspect it independently.

## Tests

```sh
npm test
```

Vitest, no network. Each scanner has unit tests; tarballs are built
in-memory from synthetic tar blobs.

## Generate screenshots for the manuals

```sh
npm run docs:screenshots
```

Spawns the dev server, drives a headless Chromium through every view via
Puppeteer, and writes PNGs to `doc/screenshots/`. Requires `npm install`
to have brought in puppeteer.

## Architecture pointer

For the module map and design decisions, see
[`CLAUDE.md`](CLAUDE.md).

## License

MIT — see [`LICENSE`](LICENSE).