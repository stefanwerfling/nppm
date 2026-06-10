import {describe, expect, it} from 'vitest';
import {Version} from '../frontend/Util/Version.js';

describe('Version.parseRange', () => {
    it('parses caret / tilde / exact / gte / partials', () => {
        expect(Version.parseRange('^1.2.3')).toEqual({op: 'caret', major: 1, minor: 2, patch: 3});
        expect(Version.parseRange('~1.2')).toEqual({op: 'tilde', major: 1, minor: 2, patch: null});
        expect(Version.parseRange('1.2.3')).toEqual({op: 'exact', major: 1, minor: 2, patch: 3});
        expect(Version.parseRange('>=1.0.0')).toEqual({op: 'gte', major: 1, minor: 0, patch: 0});
        expect(Version.parseRange('5')).toEqual({op: 'exact', major: 5, minor: null, patch: null});
        expect(Version.parseRange('v1.2.3')).toEqual({op: 'exact', major: 1, minor: 2, patch: 3});
    });

    it('returns null on unparseable input', () => {
        expect(Version.parseRange('git+https://example.com/x.git')).toBeNull();
        expect(Version.parseRange('1.0.0 || 2.0.0')).toBeNull();
    });

    it('treats *, x, X, "" as a wildcard', () => {
        expect(Version.parseRange('*')).toEqual({op: 'star', major: 0, minor: null, patch: null});
        expect(Version.parseRange('x')).toEqual({op: 'star', major: 0, minor: null, patch: null});
        expect(Version.parseRange('')).toEqual({op: 'star', major: 0, minor: null, patch: null});
    });

    it('strips prerelease + build tags', () => {
        expect(Version.parseRange('1.2.3-rc.1')).toEqual({op: 'exact', major: 1, minor: 2, patch: 3});
    });
});

describe('Version.satisfies', () => {
    const v = (major: number, minor: number, patch: number): {major: number; minor: number; patch: number;} =>
        ({major, minor, patch});

    it('handles caret semantics around the leftmost non-zero', () => {
        const caretMajor = Version.parseRange('^1.2.3')!;
        expect(Version.satisfies(v(1, 2, 3), caretMajor)).toBe(true);
        expect(Version.satisfies(v(1, 99, 0), caretMajor)).toBe(true);
        expect(Version.satisfies(v(2, 0, 0), caretMajor)).toBe(false);
        expect(Version.satisfies(v(1, 2, 2), caretMajor)).toBe(false);

        const caretZeroMinor = Version.parseRange('^0.2.3')!;
        expect(Version.satisfies(v(0, 2, 9), caretZeroMinor)).toBe(true);
        expect(Version.satisfies(v(0, 3, 0), caretZeroMinor)).toBe(false);

        const caretZeroPatch = Version.parseRange('^0.0.3')!;
        expect(Version.satisfies(v(0, 0, 3), caretZeroPatch)).toBe(true);
        expect(Version.satisfies(v(0, 0, 4), caretZeroPatch)).toBe(false);
    });

    it('handles tilde semantics', () => {
        const tilde = Version.parseRange('~1.2.3')!;
        expect(Version.satisfies(v(1, 2, 99), tilde)).toBe(true);
        expect(Version.satisfies(v(1, 3, 0), tilde)).toBe(false);

        const tildeBareMajor = Version.parseRange('~1')!;
        expect(Version.satisfies(v(1, 99, 0), tildeBareMajor)).toBe(true);
        expect(Version.satisfies(v(2, 0, 0), tildeBareMajor)).toBe(false);
    });

    it('handles exact and partial-exact', () => {
        const exact = Version.parseRange('1.2.3')!;
        expect(Version.satisfies(v(1, 2, 3), exact)).toBe(true);
        expect(Version.satisfies(v(1, 2, 4), exact)).toBe(false);

        const partial = Version.parseRange('5')!;
        expect(Version.satisfies(v(5, 0, 0), partial)).toBe(true);
        expect(Version.satisfies(v(5, 99, 99), partial)).toBe(true);
        expect(Version.satisfies(v(6, 0, 0), partial)).toBe(false);
    });
});

describe('Version.satisfiesRange (overlap)', () => {
    it('matches the user\'s example — `^5` is compatible with `5.1.2`', () => {
        expect(Version.satisfiesRange('^5', '5.1.2')).toBe(true);
        expect(Version.satisfiesRange('5.1.2', '^5')).toBe(true);
    });

    it('treats wildcard pins as always-compatible', () => {
        expect(Version.satisfiesRange('^4.0.0', '*')).toBe(true);
    });

    it('identifies disjoint major-version bumps', () => {
        expect(Version.satisfiesRange('^4', '^5')).toBe(false);
        expect(Version.satisfiesRange('^4', '^5.0.0')).toBe(false);
    });

    it('treats identical strings as compatible without parsing', () => {
        expect(Version.satisfiesRange('git+https://example/repo.git#main',
                                       'git+https://example/repo.git#main')).toBe(true);
    });

    it('rejects different non-parseable inputs (git URL vs pin)', () => {
        expect(Version.satisfiesRange('git+https://example/repo.git#main', '^1.2.3')).toBe(false);
    });

    it('caret-vs-tilde overlap', () => {
        expect(Version.satisfiesRange('^1.0.0', '~1.5.0')).toBe(true);
        expect(Version.satisfiesRange('~1.5.0', '~1.6.0')).toBe(false);
    });
});