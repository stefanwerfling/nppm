import {describe, expect, it} from 'vitest';
import {DashboardGrowthBuilder} from '../backend/Dashboard/DashboardGrowthBuilder.js';
import {HistoryEntry, HistoryFile} from '../backend/History/History.js';

const mkEntry = (
    timestamp: number,
    added: string[] = [],
    removed: string[] = [],
    updated: {name: string; from: string; to: string}[] = []
): HistoryEntry => ({
    timestamp,
    lockfileSource: 'test',
    added: added.map((nv) => {
        const at = nv.lastIndexOf('@');
        return {name: nv.slice(0, at), version: nv.slice(at + 1)};
    }),
    removed: removed.map((nv) => {
        const at = nv.lastIndexOf('@');
        return {name: nv.slice(0, at), version: nv.slice(at + 1)};
    }),
    updated: updated.map((u) => ({
        name: u.name,
        fromVersion: u.from,
        toVersion: u.to,
        bumpType: 'minor' as const,
        reason: 'minor-bump'
    })),
    source: 'snapshot' as const
});

const mkHistory = (
    finalPackages: {name: string; version: string}[],
    finalTs: number,
    entries: HistoryEntry[]
): HistoryFile => ({
    projectKey: 'k',
    projectName: 'n',
    lastSnapshot: {timestamp: finalTs, packages: finalPackages},
    entries,
    gitBackfilledHead: null
});

describe('DashboardGrowthBuilder.replay', () => {
    it('returns empty list when there is no snapshot', () => {
        const h: HistoryFile = {
            projectKey: 'k', projectName: 'n', lastSnapshot: null, entries: [], gitBackfilledHead: null
        };
        expect(DashboardGrowthBuilder.replay(h)).toEqual([]);
    });

    it('emits one point when only the snapshot exists (no deltas)', () => {
        const h = mkHistory(
            [{name: 'a', version: '1.0.0'}, {name: 'b', version: '1.0.0'}],
            1700_000_000_000,
            []
        );
        const pts = DashboardGrowthBuilder.replay(h);
        expect(pts.length).toBe(1);
        expect(pts[0].count).toBe(2);
    });

    it('derives baseline from final count minus net delta', () => {
        // Final: 5 packages. Two entries:
        //   e0: +3 -1 (net +2)
        //   e1: +1 -0 (net +1)
        // Net delta = +3 → baseline = 5 - 3 = 2
        // Trajectory: 2 → 4 → 5
        const h = mkHistory(
            [
                {name: 'a', version: '1'}, {name: 'b', version: '1'},
                {name: 'c', version: '1'}, {name: 'd', version: '1'},
                {name: 'e', version: '1'}
            ],
            1700_000_002_000,
            [
                mkEntry(1700_000_000_000, ['a@1', 'b@1', 'c@1'], ['x@1']),
                mkEntry(1700_000_001_000, ['d@1'], [])
            ]
        );
        const pts = DashboardGrowthBuilder.replay(h);
        // baseline anchor + 2 entries + (lastSnapshot is same ts as the last
        // entry? final 1700_000_002_000 != entry 1700_000_001_000 so a
        // 4th point appears).
        const counts = pts.map((p) => p.count);
        expect(counts).toEqual([2, 4, 5, 5]);
    });

    it('treats update entries as count-neutral', () => {
        const h = mkHistory(
            [{name: 'a', version: '2.0.0'}],
            2_000,
            [mkEntry(1_000, [], [], [{name: 'a', from: '1.0.0', to: '2.0.0'}])]
        );
        const pts = DashboardGrowthBuilder.replay(h);
        const counts = pts.map((p) => p.count);
        // baseline=1, after entry=1 (update doesn't change count), snapshot=1
        expect(counts).toEqual([1, 1, 1]);
    });
});

describe('DashboardGrowthBuilder.build', () => {
    it('drops projects with no history', () => {
        const out = DashboardGrowthBuilder.build([
            {
                unid: 'a', name: 'A',
                history: {projectKey: 'a', projectName: 'A', lastSnapshot: null, entries: [], gitBackfilledHead: null}
            }
        ]);
        expect(out.series).toEqual([]);
        expect(out.total).toEqual([]);
    });

    it('carries-forward ecosystem total across non-aligned timestamps', () => {
        // Project A: 1 pkg at T=1000, 3 pkg at T=3000
        // Project B: 5 pkg at T=2000, 6 pkg at T=4000
        // Expected total events (carry-forward):
        //   T=1000: A=1, B=0 → 1
        //   T=2000: A=1, B=5 → 6
        //   T=3000: A=3, B=5 → 8
        //   T=4000: A=3, B=6 → 9
        const projA = mkHistory(
            [{name: 'a1', version: '1'}, {name: 'a2', version: '1'}, {name: 'a3', version: '1'}],
            3_000,
            [mkEntry(3_000, ['a2@1', 'a3@1'], [])]
        );
        // For project A, baseline = 3 - 2 = 1 at t=2999 → emit (2999, 1) then (3000, 3)
        const projB = mkHistory(
            [
                {name: 'b1', version: '1'}, {name: 'b2', version: '1'}, {name: 'b3', version: '1'},
                {name: 'b4', version: '1'}, {name: 'b5', version: '1'}, {name: 'b6', version: '1'}
            ],
            4_000,
            [mkEntry(4_000, ['b6@1'], [])]
        );
        // For project B, baseline = 6 - 1 = 5 at t=3999 → emit (3999, 5) then (4000, 6)
        const out = DashboardGrowthBuilder.build([
            {unid: 'a', name: 'A', history: projA},
            {unid: 'b', name: 'B', history: projB}
        ]);
        expect(out.series.length).toBe(2);
        // Total should be carry-forward — verify final value
        const totalCounts = out.total.map((p) => p.count);
        expect(totalCounts[totalCounts.length - 1]).toBe(9); // 3 + 6
        // Monotonically non-decreasing in this scenario (no removals)
        for (let i = 1; i < totalCounts.length; i++) {
            expect(totalCounts[i]).toBeGreaterThanOrEqual(totalCounts[i - 1]);
        }
    });

    it('clips to sinceMs but anchors carry-forward at the cutoff', () => {
        // History with one delta well before sinceMs, one inside.
        // Pre-cutoff anchor should be re-stamped to the cutoff with the
        // pre-cutoff count.
        const now = Date.now();
        const h = mkHistory(
            [{name: 'a', version: '1'}, {name: 'b', version: '1'}, {name: 'c', version: '1'}],
            now - 86400_000, // 1 day ago
            [
                mkEntry(now - 30 * 86400_000, ['a@1', 'b@1'], []), // 30 days ago
                mkEntry(now - 86400_000, ['c@1'], []) // 1 day ago
            ]
        );
        const cutoff = now - 7 * 86400_000;
        const out = DashboardGrowthBuilder.build(
            [{unid: 'x', name: 'X', history: h}],
            cutoff
        );
        expect(out.series.length).toBe(1);
        const counts = out.series[0].points.map((p) => p.count);
        // First point should be the carry-forward anchor at the cutoff
        // with the pre-cutoff count (= 2, after the 30-days-ago entry).
        expect(counts[0]).toBe(2);
        // Last point should be the count after the 1-day-ago entry = 3.
        expect(counts[counts.length - 1]).toBe(3);
    });
});