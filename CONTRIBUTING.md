# Contributing to nppm

Thanks for considering a contribution. nppm is a one-maintainer project
right now, so the bar for accepting outside PRs is high but not impossibly
so — read this guide before opening one and we'll have a chance of
landing your change quickly.

## Before you start

- **Bug reports and feature requests:** open an issue first using the
  templates under [`.github/ISSUE_TEMPLATE`](./.github/ISSUE_TEMPLATE).
  Drive-by PRs for unconfirmed bugs / undiscussed features tend to
  stall.
- **Security issues:** never via a public PR. See [`SECURITY.md`](./SECURITY.md).
- **Architecture orientation:** [`CLAUDE.md`](./CLAUDE.md) is the
  authoritative module map + design-decision reference. Skim it before
  proposing a structural change.

## Local setup

```sh
git clone https://github.com/stefanwerfling/nppm
cd nppm
npm install
npm test            # 641+ tests, no network, runs in ~5 s
npm run dev         # dev server on http://localhost:5190
```

Node ≥ 22 is required (see `package.json` `engines`).

## What we accept

- **Bug fixes** with a regression test that pins the fix in place.
- **New scanners** that follow the existing pattern (pure static
  classifier + summary type + integration into `SecurityScanner` +
  Dashboard + Matrix badge + tests). Look at
  `Security/DeprecationScanner.ts` or `Security/ObfuscationScanner.ts`
  for the shape — they're the smallest working examples.
- **Bug fixes in the docs / manual** — typos, broken links, outdated
  screenshots.
- **Translations** — new languages drop in as `Frontend/Locales/<id>.ts`
  + registration in `I18n.ts`. See `de.ts` for the reference.
- **Performance improvements** when backed by a measurement (`vitest
  bench` welcome).

## What we typically don't accept

- Adding new framework dependencies on the client side (D3 is the
  only one allowed — everything else is hand-rolled DOM).
- Adding heavyweight server-side dependencies. Reuse the existing
  `vts`, `vite`, `express` surface.
- Renaming exports / refactoring layouts purely for style.
- Vendored / pre-built `dist/` files.

## PR process

1. **Branch naming:** `<kind>/<short-desc>` where `<kind>` ∈
   `fix`, `feat`, `docs`, `refactor`, `test`, `chore`. Examples:
   `fix/matrix-badge-overlap`, `feat/socket-dev-cache-warmup`.
2. **Commits:** keep them small and focused. Subject in imperative
   mood, ≤ 72 chars. Body wraps at 72 chars. We don't (yet) enforce
   Conventional Commits but appreciate the discipline.
3. **Tests:** every new module ships with unit tests. `npm test` and
   `npx tsc --noEmit` must be green before opening the PR.
4. **Screenshots:** UI changes need at least one screenshot in the PR
   description. Re-generate the manual screenshots with `npm run
   docs:screenshots` when applicable.
5. **i18n:** every new user-visible string lands in both
   `Frontend/Locales/en.ts` *and* `Frontend/Locales/de.ts`. The
   English string is also the cache key, so don't change existing
   keys without a migration.
6. **PR description:** what + why + how-to-test. Link the related
   issue. The PR template will walk you through it.

## Coding conventions

- TypeScript strict mode. `any` is reserved for VTS-union narrowing —
  see the CLAUDE.md "VTS-union pitfall" note.
- All logic in classes. Avoid module-level free functions; the
  exceptions are the CLI entry points (`runScan`, `runAction`, ...).
- Backend stays English: source, comments, error messages, log lines.
  German lives in `Frontend/Locales/de.ts` exclusively.
- Cache pockets live under `.nppm-cache/<pocket>/`. Use the
  `JsonCache` class; don't roll your own.
- Don't break the "git-version skip" convention. Every name-keyed
  scanner returns null for `GitResolver.isGitVersion(version)`.
- New configuration goes through the `SchemaConfig` VTS schema and
  the `ConfigLoader` — never read `nppm.json` directly elsewhere.

## Tests

- Framework: `vitest`.
- No network — fetchers are stubbed via DI (`TarballFetcher`,
  `OsvFetcher`, …).
- No filesystem fixtures — tarballs are built from in-memory tar
  blocks (see `tests/TarballParser.test.ts`).
- Aim for one happy-path test + edge cases. The current suite
  averages ~10 tests per scanner.

## Regenerating manual screenshots

```sh
npm run docs:screenshots
```

The script reuses a running dev server if one is up on port 5190,
otherwise it boots a fresh one. PNGs land in `doc/screenshots/`. Both
English and German versions are produced in one pass.

## Releasing (maintainers only)

1. Update `CHANGELOG.md` under the next `[Unreleased]` heading.
2. Bump `package.json` version + commit (`chore: release v1.x.y`).
3. Tag: `git tag v1.x.y && git push --tags`.
4. Draft a GitHub release from the tag with the changelog excerpt.

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).
Be kind. Ask before assuming malice. We don't have time for drama.

## Licensing

By contributing, you agree that your contribution will be licensed
under the project's [MIT license](./LICENSE).