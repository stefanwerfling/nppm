<!--
Thanks for the PR! Filling this in is the quickest path to a merge.
Sections you can drop entirely if they don't apply — but leave a line
explaining why.
-->

## What this changes

<!-- One-sentence summary. The verb should match the commit subject. -->

## Why

<!--
Link the related issue (`Closes #123`) or describe the motivation
inline. "Saw the gap, fixed it" is fine if there's no issue, but the
*why* should be obvious to a reviewer who didn't see the discussion.
-->

## How

<!--
The reviewer's roadmap. 3–6 bullets describing the structural moves
— "added a new XxxScanner pure-static class", "wired it into
SecurityScanner.scan + scanHeuristicsBatch", "added the Dashboard
column" — not a line-by-line diff. Skip if the PR is one-file
trivial.
-->

## Tests

- [ ] `npm test` is green
- [ ] `npx tsc --noEmit` is clean
- [ ] New code paths have at least one unit test
- [ ] If UI changed: at least one screenshot below

## Screenshots (UI changes only)

<!-- Drop PNGs here. Before / after pairs welcome. -->

## i18n (frontend changes only)

- [ ] Every new string lives in BOTH `Frontend/Locales/en.ts` and `Frontend/Locales/de.ts`
- [ ] No existing translation keys were renamed (they double as cache keys)

## Checklist

- [ ] Branch follows the `kind/short-desc` convention
- [ ] Commits are focused and use imperative subject lines (≤ 72 chars)
- [ ] No new framework dependencies on the client side (D3 only)
- [ ] Followed the patterns in [`CLAUDE.md`](../CLAUDE.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md)
- [ ] For new scanners: matched the shape of `Security/DeprecationScanner.ts` or `Security/ObfuscationScanner.ts`