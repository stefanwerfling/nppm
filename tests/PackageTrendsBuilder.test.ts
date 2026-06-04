import {describe, expect, it} from 'vitest';
import {PackageTrendsBuilder} from '../Package/PackageTrendsBuilder.js';
import {RegistryPackage} from '../Registry/Registry.js';

const mkPkg = (overrides: Partial<RegistryPackage>): RegistryPackage => ({
    name: 'demo',
    latest: '1.0.0',
    versions: [],
    ...overrides
});

describe('PackageTrendsBuilder.build', () => {
    it('emits one row per version sorted by release date', () => {
        const out = PackageTrendsBuilder.build(mkPkg({
            versions: ['2.0.0', '1.0.0', '1.5.0'],
            time: {
                '1.0.0': '2024-01-01T00:00:00.000Z',
                '1.5.0': '2024-06-01T00:00:00.000Z',
                '2.0.0': '2025-01-01T00:00:00.000Z'
            }
        }));
        expect(out.versions.map((v) => v.version)).toEqual(['1.0.0', '1.5.0', '2.0.0']);
    });

    it('attaches per-version unpackedSize / fileCount / publisher / counts', () => {
        const out = PackageTrendsBuilder.build(mkPkg({
            versions: ['1.0.0'],
            time: {'1.0.0': '2024-01-01T00:00:00.000Z'},
            dist: {'1.0.0': {tarball: 't', unpackedSize: 12345, fileCount: 7}},
            publishers: {'1.0.0': {name: 'alice'}},
            maintainerCounts: {'1.0.0': 3},
            dependencyCounts: {'1.0.0': 5}
        }));
        expect(out.versions[0]).toEqual({
            version: '1.0.0',
            releasedAt: '2024-01-01T00:00:00.000Z',
            unpackedSize: 12345,
            fileCount: 7,
            publisher: 'alice',
            maintainerCount: 3,
            depCount: 5
        });
    });

    it('treats missing maintainer/dep counts as null', () => {
        const out = PackageTrendsBuilder.build(mkPkg({
            versions: ['1.0.0'],
            time: {'1.0.0': '2024-01-01T00:00:00.000Z'}
        }));
        expect(out.versions[0].maintainerCount).toBeNull();
        expect(out.versions[0].depCount).toBeNull();
    });

    it('sorts undated versions to the tail', () => {
        const out = PackageTrendsBuilder.build(mkPkg({
            versions: ['1.0.0', '2.0.0'],
            time: {'2.0.0': '2025-01-01T00:00:00.000Z'} // 1.0.0 has no date
        }));
        expect(out.versions[0].version).toBe('2.0.0');
        expect(out.versions[1].version).toBe('1.0.0');
        expect(out.versions[1].releasedAt).toBeNull();
    });

    it('buckets releases by calendar month, chronological', () => {
        const out = PackageTrendsBuilder.build(mkPkg({
            versions: ['1.0.0', '1.1.0', '1.2.0'],
            time: {
                '1.0.0': '2024-01-15T00:00:00.000Z',
                '1.1.0': '2024-01-28T00:00:00.000Z',
                '1.2.0': '2024-03-05T00:00:00.000Z'
            }
        }));
        expect(out.releasesByMonth).toEqual([
            {month: '2024-01', count: 2},
            {month: '2024-03', count: 1}
        ]);
    });

    it('strips aux `modified` / `created` keys out of the bucket map', () => {
        const out = PackageTrendsBuilder.build(mkPkg({
            versions: ['1.0.0'],
            time: {
                'created': '2020-01-01T00:00:00.000Z',
                'modified': '2024-06-01T00:00:00.000Z',
                '1.0.0': '2024-01-15T00:00:00.000Z'
            }
        }));
        // Only the real-version bucket should appear.
        expect(out.releasesByMonth).toEqual([{month: '2024-01', count: 1}]);
    });

    it('handles a packument with no time map gracefully', () => {
        const out = PackageTrendsBuilder.build(mkPkg({
            versions: ['1.0.0']
        }));
        expect(out.versions.length).toBe(1);
        expect(out.versions[0].releasedAt).toBeNull();
        expect(out.releasesByMonth).toEqual([]);
    });
});