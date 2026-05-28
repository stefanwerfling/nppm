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
    }
  }
}
```

The `security.maintainer` block is optional and tunes the publisher-
handover detector. Defaults reflect the empirical attack patterns:
handovers ≤ 30 d on a mature package land as `risk`, ≤ 180 d as
`warn`, longer gaps as `info` (likely community takeover of an
abandoned package). Strict projects can drop `quickHandoverDays`.

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