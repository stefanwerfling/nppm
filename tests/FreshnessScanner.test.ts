import {describe, expect, it} from 'vitest';
import {FreshnessLevel, FreshnessScanner} from '../backend/Security/FreshnessScanner.js';

// Pinned "now" so the day-age maths are deterministic across runs.
const NOW = Date.parse('2026-06-01T00:00:00Z');

function daysAgo(n: number): string {
    return new Date(NOW - n * 86400_000).toISOString();
}

describe('FreshnessScanner.classify', () => {
    it('returns null when neither timestamp is available', () => {
        const out = FreshnessScanner.classify(
            {firstPublishedAt: null, maintainerCreatedAt: null},
            {now: NOW}
        );
        expect(out).toBeNull();
    });

    it('flags risk when the package is younger than the risk threshold', () => {
        const out = FreshnessScanner.classify(
            {firstPublishedAt: daysAgo(2), maintainerCreatedAt: daysAgo(900)},
            {now: NOW}
        );
        expect(out!.level).toBe(FreshnessLevel.risk);
        expect(out!.packageAgeDays).toBe(2);
        expect(out!.maintainerAgeDays).toBe(900);
    });

    it('flags risk when the publisher account is very young, even if package is old', () => {
        const out = FreshnessScanner.classify(
            {firstPublishedAt: daysAgo(900), maintainerCreatedAt: daysAgo(3)},
            {now: NOW}
        );
        expect(out!.level).toBe(FreshnessLevel.risk);
        expect(out!.reason).toMatch(/3 days old/);
    });

    it('flags warn for ages between the risk and warn thresholds', () => {
        const out = FreshnessScanner.classify(
            {firstPublishedAt: daysAgo(15), maintainerCreatedAt: daysAgo(900)},
            {now: NOW}
        );
        expect(out!.level).toBe(FreshnessLevel.warn);
    });

    it('reports info when both signals are past the warn threshold', () => {
        const out = FreshnessScanner.classify(
            {firstPublishedAt: daysAgo(400), maintainerCreatedAt: daysAgo(2000)},
            {now: NOW}
        );
        expect(out!.level).toBe(FreshnessLevel.info);
    });

    it('classifies on the package signal alone when maintainer is unknown', () => {
        const out = FreshnessScanner.classify(
            {firstPublishedAt: daysAgo(4), maintainerCreatedAt: null},
            {now: NOW}
        );
        expect(out!.level).toBe(FreshnessLevel.risk);
        expect(out!.maintainerAgeDays).toBeNull();
    });

    it('respects custom thresholds', () => {
        // With default 30/7, a 5-day-old package is risk. With a
        // strict 60/14, the same age is still risk; with a relaxed
        // 7/3 it becomes warn.
        const strict = FreshnessScanner.classify(
            {firstPublishedAt: daysAgo(5), maintainerCreatedAt: null},
            {now: NOW, warnDays: 60, riskDays: 14}
        );
        const relaxed = FreshnessScanner.classify(
            {firstPublishedAt: daysAgo(5), maintainerCreatedAt: null},
            {now: NOW, warnDays: 7, riskDays: 3}
        );
        expect(strict!.level).toBe(FreshnessLevel.risk);
        expect(relaxed!.level).toBe(FreshnessLevel.warn);
    });

    it('treats unparseable timestamps as unknown rather than now', () => {
        const out = FreshnessScanner.classify(
            {firstPublishedAt: 'not-a-date', maintainerCreatedAt: null},
            {now: NOW}
        );
        expect(out).toBeNull();
    });
});