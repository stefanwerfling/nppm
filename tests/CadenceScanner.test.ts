import {describe, expect, it} from 'vitest';
import {CadenceLevel, CadenceScanner} from '../Security/CadenceScanner.js';

// Pinned "now" so day-age maths is deterministic across runs.
const NOW = Date.parse('2026-06-01T00:00:00Z');

function daysAgo(n: number): string {
    return new Date(NOW - n * 86400_000).toISOString();
}

describe('CadenceScanner.classify', () => {
    it('returns null when no time map is provided', () => {
        expect(CadenceScanner.classify(undefined)).toBeNull();
        expect(CadenceScanner.classify(null)).toBeNull();
        expect(CadenceScanner.classify({})).toBeNull();
    });

    it('returns null when no version entry has a parseable timestamp', () => {
        const out = CadenceScanner.classify({
            created: '2020-01-01T00:00:00Z',
            modified: '2026-05-01T00:00:00Z',
            '1.0.0': 'not-a-date'
        }, {now: NOW});
        expect(out).toBeNull();
    });

    it('flags risk when the last release is older than the risk threshold', () => {
        const out = CadenceScanner.classify({
            '1.0.0': daysAgo(900),
            '1.1.0': daysAgo(850)
        }, {now: NOW});

        expect(out!.level).toBe(CadenceLevel.risk);
        expect(out!.daysSinceLastRelease).toBe(850);
        expect(out!.releaseCount).toBe(2);
    });

    it('flags warn when last release is past 180d but inside 730d', () => {
        const out = CadenceScanner.classify({
            '1.0.0': daysAgo(400),
            '1.1.0': daysAgo(200)
        }, {now: NOW});

        expect(out!.level).toBe(CadenceLevel.warn);
        expect(out!.daysSinceLastRelease).toBe(200);
    });

    it('reports info for actively maintained packages', () => {
        const out = CadenceScanner.classify({
            '1.0.0': daysAgo(120),
            '1.1.0': daysAgo(60),
            '1.2.0': daysAgo(10)
        }, {now: NOW});

        expect(out!.level).toBe(CadenceLevel.info);
        expect(out!.daysSinceLastRelease).toBe(10);
        expect(out!.medianCadenceDays).not.toBeNull();
    });

    it('ignores the `created` and `modified` sentinel keys in the time map', () => {
        // If `created` were counted as a release, the median cadence
        // and last-release would be wrong. Pin them far apart from
        // the actual versions to make any leak loud.
        const out = CadenceScanner.classify({
            created: daysAgo(5000),
            modified: daysAgo(0),
            '1.0.0': daysAgo(120),
            '1.1.0': daysAgo(60),
            '1.2.0': daysAgo(30)
        }, {now: NOW});

        expect(out!.daysSinceLastRelease).toBe(30);
        expect(out!.releaseCount).toBe(3);
    });

    it('computes median cadence over the recent window', () => {
        // Six releases, gaps of 10/20/15/25/30 days. Median = 20.
        const out = CadenceScanner.classify({
            '1.0.0': daysAgo(100),
            '1.1.0': daysAgo(90),  // gap 10
            '1.2.0': daysAgo(70),  // gap 20
            '1.3.0': daysAgo(55),  // gap 15
            '1.4.0': daysAgo(30),  // gap 25
            '1.5.0': daysAgo(0)    // gap 30
        }, {now: NOW});

        expect(out!.medianCadenceDays).toBe(20);
    });

    it('respects custom thresholds', () => {
        // Strict project: 30d warn, 90d risk.
        const out = CadenceScanner.classify({
            '1.0.0': daysAgo(120)
        }, {now: NOW, warnDays: 30, riskDays: 90});

        expect(out!.level).toBe(CadenceLevel.risk);
    });
});