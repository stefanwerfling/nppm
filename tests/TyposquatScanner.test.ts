import {describe, expect, it} from 'vitest';
import {TyposquatLevel, TyposquatScanner} from '../Security/TyposquatScanner.js';

describe('TyposquatScanner.levenshtein', () => {
    it('returns 0 for identical strings', () => {
        expect(TyposquatScanner.levenshtein('lodash', 'lodash')).toBe(0);
    });

    it('counts single-character substitutions, insertions, deletions', () => {
        expect(TyposquatScanner.levenshtein('lodash', 'lodahs')).toBe(2); // 2 swaps
        expect(TyposquatScanner.levenshtein('lodash', 'lodasch')).toBe(1); // 1 insertion
        expect(TyposquatScanner.levenshtein('lodash', 'lodas')).toBe(1);   // 1 deletion
    });

    it('handles empty inputs', () => {
        expect(TyposquatScanner.levenshtein('', 'abc')).toBe(3);
        expect(TyposquatScanner.levenshtein('abc', '')).toBe(3);
    });

    it('honours the maxDist short-circuit', () => {
        // Two strings whose true distance is 6 — but with maxDist=2
        // we should bail out after reaching 3 (=maxDist+1).
        const out = TyposquatScanner.levenshtein('aaaaaa', 'bbbbbb', 2);
        expect(out).toBeGreaterThan(2);
    });
});

describe('TyposquatScanner.classify', () => {
    it('reports `exact` for a verbatim popular-list entry', () => {
        const f = TyposquatScanner.classify('lodash');
        expect(f.level).toBe(TyposquatLevel.exact);
        expect(f.closestMatch).toBe('lodash');
        expect(f.distance).toBe(0);
        expect(f.hasConfusables).toBe(false);
    });

    it('flags risk when the name is one edit away from a popular package', () => {
        // `lodaash` is 1 insertion away from `lodash` — classic squat.
        const f = TyposquatScanner.classify('lodaash');
        expect(f.level).toBe(TyposquatLevel.risk);
        expect(f.closestMatch).toBe('lodash');
        expect(f.distance).toBe(1);
    });

    it('flags warn when the name is exactly two edits away', () => {
        // `loodassh` is 2 edits from `lodash` (one insert, one swap).
        const f = TyposquatScanner.classify('loodassh');
        expect(f.level).toBe(TyposquatLevel.warn);
        expect(f.distance).toBe(2);
    });

    it('reports `unrelated` for a name far from any popular entry', () => {
        const f = TyposquatScanner.classify('kavula_backend');
        expect(f.level).toBe(TyposquatLevel.unrelated);
    });

    it('flips to risk on any non-ASCII character, even when distance would say unrelated', () => {
        // Cyrillic 'е' (U+0435) for ASCII 'e' inside something not on
        // the list — still a homoglyph attack signal.
        const f = TyposquatScanner.classify('totally-niche-еvil-name');
        expect(f.level).toBe(TyposquatLevel.risk);
        expect(f.hasConfusables).toBe(true);
    });

    it('flags a confusable look-alike of a popular package', () => {
        // `expreѕs` — cyrillic 'ѕ' (U+0455) replacing ASCII 's'.
        const f = TyposquatScanner.classify('expreѕs');
        expect(f.level).toBe(TyposquatLevel.risk);
        expect(f.hasConfusables).toBe(true);
        expect(f.closestMatch).toBe('express');
    });

    it('does not match a popular entry when the byte string is unicode-encoded', () => {
        // The bytes for cyrillic 'expreѕs' differ from ASCII
        // 'express' even though the glyph looks identical, so
        // POPULAR_SET.has(...) must return false.
        const f = TyposquatScanner.classify('expreѕs');
        expect(f.level).not.toBe(TyposquatLevel.exact);
    });
});