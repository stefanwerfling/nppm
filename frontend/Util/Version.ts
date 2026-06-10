/**
 * Concrete version triple. `null` slots are not allowed here — use
 * `SimpleRange` for input that may carry partial / wildcard segments.
 */
export type Version3 = {major: number; minor: number; patch: number;};

/**
 * Parsed shape of a "simple" semver range emitted by templates and
 * package.json manifests. We deliberately do *not* model `||`
 * compound expressions or hyphen ranges — templates produce caret /
 * tilde / exact / `>=` and that's it. `minor` / `patch` are `null`
 * for unspecified segments (e.g. `^5` has `minor=null, patch=null`).
 */
export type SimpleRange = {
    op: 'star'|'exact'|'caret'|'tilde'|'gte'|'gt'|'lte'|'lt';
    major: number;
    minor: number|null;
    patch: number|null;
};

/**
 * Frontend semver helpers. Hand-rolled (no `semver` dep) to cover only
 * the dialect npm dependency ranges actually use in this codebase:
 * `^X[.Y[.Z]]`, `~X[.Y[.Z]]`, exact, `>=X[.Y[.Z]]`, bare partials
 * (`5` → `5.x.x`), and `*`. Pre-release tags are stripped — nppm's
 * matrix doesn't need to disambiguate `1.0.0-rc.1` from `1.0.0`.
 */
export class Version {

    /**
     * Strip range modifiers (`^`, `~`, `>=`, `=`, leading `v`,
     * whitespace) so `^1.2.3` becomes `1.2.3`, the version we can
     * actually pass to a tarball / vuln lookup. Deliberately lossy —
     * caret/tilde widening collapses to "same". For *comparing* two
     * ranges, use {@link satisfiesRange} instead.
     */
    public static cleanRange(range: string): string {
        return range
        .trim()
        .replace(/^[\^~=v]+/u, '')
        .replace(/^>=\s*/u, '')
        .split(/\s/u)[0];
    }

    /**
     * Parse a single range token (no `||` unions, no hyphen `1.0 - 2.0`
     * ranges). Returns `null` when the input doesn't match the
     * supported grammar — callers must then fall back to the lossy
     * `cleanRange` comparison.
     */
    public static parseRange(input: string): SimpleRange|null {
        const s = input.trim();
        if (s === '' || s === '*' || s === 'x' || s === 'X') {
            return {op: 'star', major: 0, minor: null, patch: null};
        }
        const m = s.match(
            /^(\^|~|>=|>|<=|<|=)?\s*v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:[-+][\w.+-]*)?$/u
        );
        if (!m) {
            return null;
        }
        const opMap: Record<string, SimpleRange['op']> = {
            '^': 'caret', '~': 'tilde', '>=': 'gte', '>': 'gt',
            '<=': 'lte', '<': 'lt', '=': 'exact'
        };
        const op = m[1] ? opMap[m[1]] : 'exact';
        const parseSeg = (raw: string|undefined): number|null => {
            if (raw === undefined || raw === 'x' || raw === 'X' || raw === '*') {
                return null;
            }
            return parseInt(raw, 10);
        };
        return {
            op: op,
            major: parseInt(m[2], 10),
            minor: parseSeg(m[3]),
            patch: parseSeg(m[4])
        };
    }

    /**
     * Does the concrete `version` satisfy the parsed `range`? Implements
     * the npm semver semantics for the operators we parse:
     *  - caret: `^X.Y.Z` widens on the left-most non-zero digit
     *  - tilde: `~X.Y.Z` widens on patch; `~X.Y` widens on patch;
     *    `~X` widens on minor (so `~1` = `>=1.0.0 <2.0.0`)
     *  - exact partials: bare `5` = `>=5.0.0 <6.0.0`, bare `5.1` =
     *    `>=5.1.0 <5.2.0`
     */
    public static satisfies(v: Version3, r: SimpleRange): boolean {
        if (r.op === 'star') {
            return true;
        }
        if (r.op === 'exact') {
            if (r.minor === null) {
                return v.major === r.major;
            }
            if (r.patch === null) {
                return v.major === r.major && v.minor === r.minor;
            }
            return v.major === r.major && v.minor === r.minor && v.patch === r.patch;
        }
        const minor = r.minor ?? 0;
        const patch = r.patch ?? 0;
        const min: Version3 = {major: r.major, minor: minor, patch: patch};
        if (r.op === 'gte') {
            return Version._cmp(v, min) >= 0;
        }
        if (r.op === 'gt') {
            return Version._cmp(v, min) > 0;
        }
        if (r.op === 'lte') {
            return Version._cmp(v, min) <= 0;
        }
        if (r.op === 'lt') {
            return Version._cmp(v, min) < 0;
        }
        if (Version._cmp(v, min) < 0) {
            return false;
        }
        if (r.op === 'caret') {
            if (r.major > 0) {
                return Version._cmp(v, {major: r.major + 1, minor: 0, patch: 0}) < 0;
            }
            if (minor > 0) {
                return Version._cmp(v, {major: 0, minor: minor + 1, patch: 0}) < 0;
            }
            return Version._cmp(v, {major: 0, minor: 0, patch: patch + 1}) < 0;
        }
        if (r.op === 'tilde') {
            if (r.minor !== null) {
                return Version._cmp(v, {major: r.major, minor: minor + 1, patch: 0}) < 0;
            }
            return Version._cmp(v, {major: r.major + 1, minor: 0, patch: 0}) < 0;
        }
        return false;
    }

    /**
     * Lowest concrete version a range allows. `^1.2.3` → `1.2.3`,
     * `~1.2` → `1.2.0`, bare `5` → `5.0.0`. Returns `null` when the
     * range is unparseable. Upper-bound-only ranges (`<2.0.0`) report
     * `0.0.0` as the floor — fine for the overlap probe in
     * {@link satisfiesRange}, since the actual constraint kicks in
     * via the second probe direction.
     */
    public static rangeMinVersion(rangeStr: string): Version3|null {
        const r = Version.parseRange(rangeStr);
        if (!r) {
            return null;
        }
        if (r.op === 'lt' || r.op === 'lte') {
            return {major: 0, minor: 0, patch: 0};
        }
        return {major: r.major, minor: r.minor ?? 0, patch: r.patch ?? 0};
    }

    /**
     * Do two ranges have a non-empty intersection? I.e. is there any
     * concrete version both ranges accept? Used by the cross-project
     * matrix to decide whether a declared range is "compatible" with
     * the template's pin — `^5` is compatible with `5.1.2` (both accept
     * `5.1.2`), but `^4` is not compatible with `^5.0.0`.
     *
     * Algorithm: probe each range's minimum against the other range.
     * That catches every overlap case the simple-range grammar can
     * produce — both probes only fail when the ranges are disjoint.
     * Unparseable inputs fall back to the lossy `cleanRange` identity
     * test so a git URL or `latest` tag still compares sensibly.
     */
    public static satisfiesRange(declaredRange: string, pinRange: string): boolean {
        const declaredTrim = declaredRange.trim();
        const pinTrim = pinRange.trim();
        if (pinTrim === '*' || pinTrim === '') {
            return true;
        }
        if (declaredTrim === pinTrim) {
            return true;
        }
        const declared = Version.parseRange(declaredRange);
        const pin = Version.parseRange(pinRange);
        if (!declared || !pin) {
            return Version.cleanRange(declaredRange) === Version.cleanRange(pinRange);
        }
        const declaredMin = Version.rangeMinVersion(declaredRange);
        const pinMin = Version.rangeMinVersion(pinRange);
        if (!declaredMin || !pinMin) {
            return false;
        }
        return Version.satisfies(declaredMin, pin) || Version.satisfies(pinMin, declared);
    }

    private static _cmp(a: Version3, b: Version3): number {
        if (a.major !== b.major) {
            return a.major - b.major;
        }
        if (a.minor !== b.minor) {
            return a.minor - b.minor;
        }
        return a.patch - b.patch;
    }

}