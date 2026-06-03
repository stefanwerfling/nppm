import {describe, expect, it} from 'vitest';
import {DepGraphNode, DepGraphResponse} from '../DepGraph/DepGraphBuilder.js';
import {ImpactAnalyzer} from '../Security/ImpactAnalyzer.js';

function node(
    name: string,
    version: string,
    deps: {name: string; version: string}[] = []
): DepGraphNode {
    return {
        name,
        version,
        status: 'aligned',
        vulnCount: 0,
        latestVersion: version,
        deps
    };
}

function graph(
    unid: string,
    rootDeps: {name: string; version: string}[],
    packages: Record<string, DepGraphNode>
): DepGraphResponse {
    return {
        project: {unid, name: `proj-${unid}`, type: 'local'},
        rootDeps,
        packages
    };
}

describe('ImpactAnalyzer.versionMatches', () => {
    it('matches exact versions', () => {
        expect(ImpactAnalyzer.versionMatches('4.17.21', '4.17.21')).toBe(true);
        expect(ImpactAnalyzer.versionMatches('4.17.20', '4.17.21')).toBe(false);
    });

    it('treats `.x` wildcard as a dotted prefix', () => {
        expect(ImpactAnalyzer.versionMatches('4.17.21', '4.17.x')).toBe(true);
        expect(ImpactAnalyzer.versionMatches('4.17.0', '4.17.x')).toBe(true);
        expect(ImpactAnalyzer.versionMatches('4.18.0', '4.17.x')).toBe(false);
        expect(ImpactAnalyzer.versionMatches('4.170.0', '4.17.x')).toBe(false);
    });

    it('matches bare prefixes only at the dot boundary', () => {
        expect(ImpactAnalyzer.versionMatches('4.17.21', '4.17')).toBe(true);
        expect(ImpactAnalyzer.versionMatches('4.17', '4.17')).toBe(true);
        expect(ImpactAnalyzer.versionMatches('4.170.0', '4.17')).toBe(false);
        expect(ImpactAnalyzer.versionMatches('4.1.0', '4.x')).toBe(true);
        expect(ImpactAnalyzer.versionMatches('40.1.0', '4.x')).toBe(false);
    });

    it('treats `*` and `` as match-all', () => {
        expect(ImpactAnalyzer.versionMatches('1.2.3', '*')).toBe(true);
        expect(ImpactAnalyzer.versionMatches('1.2.3', '')).toBe(true);
    });
});

describe('ImpactAnalyzer.analyzeGraph', () => {
    it('labels a root-declared hit as direct and returns a single-step path', () => {
        const g = graph('p1',
            [{name: 'lodash', version: '4.17.21'}],
            {'lodash@4.17.21': node('lodash', '4.17.21')}
        );
        const report = ImpactAnalyzer.analyzeGraph(g, 'lodash', null);
        expect(report.hits).toHaveLength(1);
        expect(report.hits[0].kind).toBe('direct');
        expect(report.hits[0].path).toEqual(['lodash@4.17.21']);
    });

    it('labels a deeply-nested hit as transitive and reconstructs the path', () => {
        const g = graph('p2',
            [{name: 'react', version: '18.0.0'}],
            {
                'react@18.0.0': node('react', '18.0.0', [{name: 'some-lib', version: '2.0.0'}]),
                'some-lib@2.0.0': node('some-lib', '2.0.0', [{name: 'lodash', version: '4.17.21'}]),
                'lodash@4.17.21': node('lodash', '4.17.21')
            }
        );
        const report = ImpactAnalyzer.analyzeGraph(g, 'lodash', null);
        expect(report.hits).toHaveLength(1);
        expect(report.hits[0].kind).toBe('transitive');
        expect(report.hits[0].path).toEqual([
            'react@18.0.0',
            'some-lib@2.0.0',
            'lodash@4.17.21'
        ]);
    });

    it('filters by the version pattern', () => {
        const g = graph('p3',
            [
                {name: 'a', version: '1.0.0'},
                {name: 'b', version: '1.0.0'}
            ],
            {
                'a@1.0.0': node('a', '1.0.0', [{name: 'lodash', version: '4.17.21'}]),
                'b@1.0.0': node('b', '1.0.0', [{name: 'lodash', version: '4.18.0'}]),
                'lodash@4.17.21': node('lodash', '4.17.21'),
                'lodash@4.18.0': node('lodash', '4.18.0')
            }
        );
        const report = ImpactAnalyzer.analyzeGraph(g, 'lodash', '4.17.x');
        expect(report.hits).toHaveLength(1);
        expect(report.hits[0].version).toBe('4.17.21');
    });

    it('returns the shortest path when multiple chains reach the same key', () => {
        // root → short-chain → lodash       (length 3)
        // root → long-chain → mid → lodash  (length 4)
        const g = graph('p4',
            [
                {name: 'short-chain', version: '1.0.0'},
                {name: 'long-chain', version: '1.0.0'}
            ],
            {
                'short-chain@1.0.0': node('short-chain', '1.0.0', [{name: 'lodash', version: '4.17.21'}]),
                'long-chain@1.0.0': node('long-chain', '1.0.0', [{name: 'mid', version: '1.0.0'}]),
                'mid@1.0.0': node('mid', '1.0.0', [{name: 'lodash', version: '4.17.21'}]),
                'lodash@4.17.21': node('lodash', '4.17.21')
            }
        );
        const report = ImpactAnalyzer.analyzeGraph(g, 'lodash', null);
        expect(report.hits).toHaveLength(1);
        expect(report.hits[0].path).toEqual(['short-chain@1.0.0', 'lodash@4.17.21']);
    });

    it('returns one hit per matching version when multiple are installed', () => {
        const g = graph('p5',
            [
                {name: 'a', version: '1.0.0'},
                {name: 'b', version: '1.0.0'}
            ],
            {
                'a@1.0.0': node('a', '1.0.0', [{name: 'lodash', version: '4.17.21'}]),
                'b@1.0.0': node('b', '1.0.0', [{name: 'lodash', version: '4.17.15'}]),
                'lodash@4.17.21': node('lodash', '4.17.21'),
                'lodash@4.17.15': node('lodash', '4.17.15')
            }
        );
        const report = ImpactAnalyzer.analyzeGraph(g, 'lodash', '4.17.x');
        expect(report.hits.map((h) => h.version).sort()).toEqual(['4.17.15', '4.17.21']);
    });

    it('returns no hits when the package is absent', () => {
        const g = graph('p6',
            [{name: 'react', version: '18.0.0'}],
            {'react@18.0.0': node('react', '18.0.0')}
        );
        const report = ImpactAnalyzer.analyzeGraph(g, 'lodash', null);
        expect(report.hits).toEqual([]);
    });

    it('sorts direct hits before transitive', () => {
        const g = graph('p7',
            [
                {name: 'lodash', version: '4.17.21'},
                {name: 'react', version: '18.0.0'}
            ],
            {
                'lodash@4.17.21': node('lodash', '4.17.21'),
                'react@18.0.0': node('react', '18.0.0', [{name: 'lodash', version: '4.17.15'}]),
                'lodash@4.17.15': node('lodash', '4.17.15')
            }
        );
        const report = ImpactAnalyzer.analyzeGraph(g, 'lodash', null);
        expect(report.hits[0].kind).toBe('direct');
        expect(report.hits[1].kind).toBe('transitive');
    });
});

describe('ImpactAnalyzer.buildReport', () => {
    it('separates hit / clean / skipped buckets and sorts by hit count desc', () => {
        const pp = [
            {
                project: {unid: 'a', name: 'alpha', type: 'local'},
                hits: [
                    {name: 'lodash', version: '1', kind: 'direct' as const, path: ['lodash@1'], status: 'aligned' as const, vulnCount: 0}
                ]
            },
            {
                project: {unid: 'b', name: 'beta', type: 'local'},
                hits: [
                    {name: 'lodash', version: '1', kind: 'direct' as const, path: ['lodash@1'], status: 'aligned' as const, vulnCount: 0},
                    {name: 'lodash', version: '2', kind: 'direct' as const, path: ['lodash@2'], status: 'aligned' as const, vulnCount: 0}
                ]
            },
            {
                project: {unid: 'c', name: 'gamma', type: 'local'},
                hits: []
            }
        ];
        const report = ImpactAnalyzer.buildReport(
            {name: 'lodash', versionPattern: null},
            pp,
            [{unid: 'd', name: 'delta', type: 'local', reason: 'no lockfile'}]
        );
        expect(report.totalHits).toBe(3);
        expect(report.projects.map((p) => p.project.unid)).toEqual(['b', 'a']);
        expect(report.cleanProjects.map((p) => p.unid)).toEqual(['c']);
        expect(report.skippedProjects.map((p) => p.unid)).toEqual(['d']);
    });
});