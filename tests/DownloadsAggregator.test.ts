import {describe, expect, it} from 'vitest';
import {DownloadsAggregator} from '../backend/Dashboard/DownloadsAggregator.js';

describe('DownloadsAggregator.fold', () => {
    it('sums per-project distinct-name downloads', () => {
        const projects = new Map<string, string[]>([
            ['a', ['react', 'lodash', 'react']], // duplicate intra-project
            ['b', ['axios']]
        ]);
        const downloads = new Map<string, number|null>([
            ['react', 100],
            ['lodash', 50],
            ['axios', 30]
        ]);
        const out = DownloadsAggregator.fold(projects, downloads);
        // react is deduped inside project a, so a = 100 + 50 = 150
        expect(out.perProject.get('a')).toBe(150);
        expect(out.perProject.get('b')).toBe(30);
    });

    it('dedupes ecosystem total across projects', () => {
        const projects = new Map<string, string[]>([
            ['a', ['react', 'lodash']],
            ['b', ['react', 'axios']]  // react shared across projects
        ]);
        const downloads = new Map<string, number|null>([
            ['react', 100],
            ['lodash', 50],
            ['axios', 30]
        ]);
        const out = DownloadsAggregator.fold(projects, downloads);
        // react counted ONCE for ecosystem: 100 + 50 + 30 = 180
        expect(out.ecosystemDeduped).toBe(180);
        // perProject sums DON'T dedupe across projects: 150 + 130 = 280
        const projectSum = Array.from(out.perProject.values()).reduce((s, v) => s + v, 0);
        expect(projectSum).toBe(280);
    });

    it('treats missing / null downloads as zero contribution', () => {
        const projects = new Map<string, string[]>([
            ['a', ['react', 'mystery', 'private-pkg']]
        ]);
        const downloads = new Map<string, number|null>([
            ['react', 100],
            ['mystery', null]
            // private-pkg not in map at all
        ]);
        const out = DownloadsAggregator.fold(projects, downloads);
        expect(out.perProject.get('a')).toBe(100);
        expect(out.ecosystemDeduped).toBe(100);
    });

    it('returns empty result on empty project map', () => {
        const out = DownloadsAggregator.fold(new Map(), new Map());
        expect(out.perProject.size).toBe(0);
        expect(out.ecosystemDeduped).toBe(0);
    });
});