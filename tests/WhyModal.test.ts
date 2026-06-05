import {describe, expect, it} from 'vitest';
import {ApiDepGraphResponse} from '../shared/Api/ApiTypes.js';
import {WhyModal} from '../Frontend/WhyModal.js';

/**
 * Build a synthetic flat dep-graph matching `ApiDepGraphResponse` —
 * one root (`app@1.0.0`) → middle (`a@1.0.0`, `b@1.0.0`) → leaf
 * (`leaf@1.0.0`), with `b` also pulling `leaf` so the reverse walk has
 * two distinct chains.
 */
function makeGraph(): ApiDepGraphResponse {
    return {
        project: {unid: 'x', name: 'x', type: 'local' as never},
        rootDeps: [{name: 'app', version: '1.0.0'}],
        packages: {
            'app@1.0.0': {
                name: 'app', version: '1.0.0', status: 'aligned',
                vulnCount: 0, latestVersion: '1.0.0',
                deps: [{name: 'a', version: '1.0.0'}, {name: 'b', version: '1.0.0'}]
            },
            'a@1.0.0': {
                name: 'a', version: '1.0.0', status: 'aligned',
                vulnCount: 0, latestVersion: '1.0.0',
                deps: [{name: 'leaf', version: '1.0.0'}]
            },
            'b@1.0.0': {
                name: 'b', version: '1.0.0', status: 'aligned',
                vulnCount: 0, latestVersion: '1.0.0',
                deps: [{name: 'leaf', version: '1.0.0'}]
            },
            'leaf@1.0.0': {
                name: 'leaf', version: '1.0.0', status: 'aligned',
                vulnCount: 0, latestVersion: '1.0.0',
                deps: []
            }
        }
    };
}

describe('WhyModal.buildReverseMap', () => {
    it('inverts every parent→child edge', () => {
        const reverse = WhyModal.buildReverseMap(makeGraph());
        expect(reverse.get('leaf@1.0.0')?.sort()).toEqual(['a@1.0.0', 'b@1.0.0']);
        expect(reverse.get('a@1.0.0')).toEqual(['app@1.0.0']);
        expect(reverse.get('b@1.0.0')).toEqual(['app@1.0.0']);
        expect(reverse.get('app@1.0.0')).toBeUndefined();
    });

    it('skips dep edges that did not resolve to a concrete version', () => {
        const g: ApiDepGraphResponse = {
            project: {unid: 'x', name: 'x', type: 'local' as never},
            rootDeps: [{name: 'app', version: '1.0.0'}],
            packages: {
                'app@1.0.0': {
                    name: 'app', version: '1.0.0', status: 'aligned',
                    vulnCount: 0, latestVersion: null,
                    deps: [{name: 'missing-peer', version: ''}]
                }
            }
        };
        const reverse = WhyModal.buildReverseMap(g);
        expect(reverse.size).toBe(0);
    });
});

describe('WhyModal.collectPaths', () => {
    it('finds both chains from a shared leaf back to the root', () => {
        const graph = makeGraph();
        const reverse = WhyModal.buildReverseMap(graph);
        const paths = WhyModal.collectPaths(
            'leaf@1.0.0',
            reverse,
            new Set(['app@1.0.0'])
        );

        expect(paths).toHaveLength(2);
        // Each chain starts at the root and ends at the target.
        for (const p of paths) {
            expect(p[0]).toBe('app@1.0.0');
            expect(p[p.length - 1]).toBe('leaf@1.0.0');
        }
        // The two chains differ only on the middle hop (a vs b).
        const middles = paths.map((p) => p[1]).sort();
        expect(middles).toEqual(['a@1.0.0', 'b@1.0.0']);
    });

    it('returns an empty list when the target has no parents at all', () => {
        const reverse = WhyModal.buildReverseMap(makeGraph());
        const paths = WhyModal.collectPaths(
            'app@1.0.0',
            reverse,
            new Set(['app@1.0.0'])
        );
        expect(paths).toEqual([]);
    });

    it('does not loop on cyclic peer-dep edges', () => {
        // Two packages depending on each other — pathologically rare
        // but possible with peer-dep loops. The seen-set should stop
        // the walk before it grows unbounded.
        const g: ApiDepGraphResponse = {
            project: {unid: 'x', name: 'x', type: 'local' as never},
            rootDeps: [{name: 'a', version: '1.0.0'}],
            packages: {
                'a@1.0.0': {
                    name: 'a', version: '1.0.0', status: 'aligned',
                    vulnCount: 0, latestVersion: '1.0.0',
                    deps: [{name: 'b', version: '1.0.0'}]
                },
                'b@1.0.0': {
                    name: 'b', version: '1.0.0', status: 'aligned',
                    vulnCount: 0, latestVersion: '1.0.0',
                    deps: [{name: 'a', version: '1.0.0'}]
                }
            }
        };
        const reverse = WhyModal.buildReverseMap(g);
        const paths = WhyModal.collectPaths(
            'b@1.0.0',
            reverse,
            new Set(['a@1.0.0'])
        );
        expect(paths).toHaveLength(1);
        expect(paths[0]).toEqual(['a@1.0.0', 'b@1.0.0']);
    });
});