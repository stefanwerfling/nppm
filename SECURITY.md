# Security Policy

nppm is a supply-chain-security tool, so we hold ourselves to the same
disclosure discipline we expect of the packages nppm scans. If you
believe you have found a vulnerability in nppm itself, please follow
the process below — please do **not** open a public GitHub issue.

## Reporting a vulnerability

The preferred channel is **GitHub's private vulnerability reporting**:

1. Go to [the Security tab](https://github.com/stefanwerfling/nppm/security/advisories)
2. Click **"Report a vulnerability"**
3. Fill in the form — your report is visible only to the maintainers
   and a small group of GitHub-side responders.

This routes through GitHub Security Advisories so we can collaborate
on a fix, request a CVE if needed, and coordinate disclosure without
involving public channels.

### What to include

- A clear description of the issue and the impact you observed.
- Step-by-step reproduction (a tiny project / command line example
  beats a paragraph of prose every time).
- The nppm version (`nppm --help` prints it; or the commit SHA).
- The Node.js version (`node -v`).
- Optional but appreciated: a suggested fix, a PoC payload, or a
  pointer to the affected file.

## Response timeline

We aim for:

| Phase | Target |
|-------|--------|
| Acknowledge receipt | 72 hours |
| Triage + initial assessment | 7 days |
| Fix candidate | 30 days for high / critical severity |
| Coordinated disclosure | 90 days from first report (sooner if a fix lands earlier) |

For lower-severity issues we will agree a timeline with you before
disclosure.

## Scope

In scope:
- The nppm CLI (`nppm`, `nppm scan`, `nppm sbom`, `nppm action`)
- The nppm dev server and its API routes
- The nppm scanner modules and the per-scanner verdicts they emit
- The composite GitHub Action under `.github/actions/scan`
- The `Cli/GithubClient.ts` Issues Comments API client

Out of scope (please report upstream):
- Vulnerabilities in `vite`, `express`, `vts`, or any other third-party
  dependency — file with the respective maintainer.
- npm registry / OSV.dev / socket.dev / OpenSSF Scorecard /
  deps.dev outages or correctness issues — please file with the
  service provider.
- Findings nppm correctly surfaces in scanned packages (that's the
  product working — open a GitHub issue if a verdict feels wrong).

## Supported versions

While nppm is at `0.x` / pre-1.0 maturity, security fixes ship only
on the `main` branch. Once `v1.0.0` is tagged, security fixes will
backport to the most recent minor (`v1.N.x`) as well.

| Version | Status | Security fixes |
|---------|--------|----------------|
| `main` (current) | active development | ✅ all reported issues |
| any pre-1.0 tag | superseded | ❌ — upgrade to `main` |

## Acknowledgements

We thank the following reporters for responsibly disclosing
vulnerabilities (latest first). PRs to add yourself here are welcome
once an advisory is published.

_(No advisories yet — be the first.)_

## Public key (optional)

If you prefer encrypted email over GitHub Security Advisories, you
can request the maintainer's PGP key by opening a *non-sensitive*
discussion (e.g. "PGP key please") in the project's GitHub
Discussions. The actual report should still flow through Security
Advisories once contact is established.