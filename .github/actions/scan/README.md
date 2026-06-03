# nppm scan action

A composite GitHub Action that runs the full
[nppm](https://github.com/stefanwerfling/nppm) scanner family over
your repository's npm dependencies on every push and pull request.
Two output channels:

- **SARIF** for GitHub Code Scanning — findings show up natively
  under the repo's **Security → Code scanning alerts** tab.
- **Sticky PR comment** with the CVE delta between base and head —
  one comment per PR, updated in place on every push.

## Quick start

```yaml
name: Supply-chain scan
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  security-events: write   # for the SARIF upload
  pull-requests: write     # for the sticky comment

jobs:
  nppm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # PrReview needs git history
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - id: nppm
        uses: stefanwerfling/nppm/.github/actions/scan@main
        with:
          fail-on: warn
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: ${{ steps.nppm.outputs.sarif-path }}
```

## Inputs

| Name | Default | Description |
|------|---------|-------------|
| `config-path` | `nppm.json` | Path to the project's `nppm.json` (relative to `working-directory`). |
| `fail-on` | `risk` | Severity threshold (`info` / `warn` / `risk` / `none`). |
| `sarif-output` | `nppm.sarif` | Where to write the SARIF report. |
| `pr-comment` | `true` | Set to `false` to suppress the PR comment. |
| `pr-base` | PR `base.ref` | Override base ref for the diff. |
| `pr-head` | PR `head.sha` | Override head ref for the diff. |
| `github-token` | `${{ github.token }}` | Token used to post the comment. |
| `working-directory` | `.` | Working directory of the scan. |

## Outputs

| Name | Description |
|------|-------------|
| `sarif-path` | Absolute path the SARIF file was written to (feed to `upload-sarif`). |
| `scan-exit-code` | Exit code of the underlying `nppm scan` (`0` = clean / below threshold, `1` = threshold breached, `2` = config error). |

## What the PR comment looks like

```
🩺 nppm PR scan

**3** dep changes · 1 added · 0 removed · 2 updated
🔴 +2 CVEs  ·  🟢 −1 CVE

### my-app

| Package | Change | Range | Resolved | CVE Δ |
|---|---|---|---|---|
| axios | 🟡 updated | `^0.21.0` → `^1.6.0` | `0.21.4` → `1.6.7` | 🟢 −1: `GHSA-wf5p-g6vw-rhxx` |
| lodash | 🟢 added | — → `^4.17.21` | — → `4.17.21` | — |
| ws | 🟡 updated | `^8.0.0` → `^8.16.0` | `8.0.0` → `8.16.0` | 🔴 +2: `GHSA-3h5v-q93c-6h6q`, `GHSA-gp9m-ppx7-94gp` |

<sub>nppm scan · owner/repo@`abc1234`</sub>
```

The comment is **sticky** — every subsequent push to the PR updates
the same comment instead of posting a new one.

## Permissions

The minimum the action needs:

- `contents: read` — for the `checkout` step (always required).
- `security-events: write` — for the SARIF upload step.
- `pull-requests: write` — for the sticky PR comment.

When the workflow runs on `pull_request_target` instead of
`pull_request` (e.g. to gain write access from forks), GitHub still
needs the same `pull-requests: write` permission.

## How the scanner reuses caches

The action runs `npm ci --omit=dev` inside its own checkout, which
pulls nppm's small runtime dependency tree (vite, vts, dotenv,
express). All cache pockets live under `.nppm-cache/` in the
consumer's working directory — register that path in the workflow's
`actions/cache@v4` step to keep warm OSV + registry responses across
runs.

```yaml
- uses: actions/cache@v4
  with:
    path: .nppm-cache
    key: nppm-cache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: nppm-cache-${{ runner.os }}-
```

## Local testing

Same code path runs locally:

```sh
npx nppm action     # reads INPUT_* env vars, writes nppm.sarif
```

Useful for iterating on the comment format without pushing
throwaway PRs.