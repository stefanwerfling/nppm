import {describe, expect, it} from 'vitest';
import {GitHistoryBackfill, GitRunner} from '../History/GitHistoryBackfill.js';

/**
 * Build an in-memory `GitRunner` backed by a fake commit-graph. Each
 * commit can carry both a lockfile and a package.json blob (either
 * may be null). The runner returns commits per file (matching how
 * `git log -- <file>` filters), and `show()` looks up the right
 * blob by file name.
 */
function fakeRunner(commits: {
    sha: string;
    ts: number;
    lockfile?: string|null;
    packageJson?: string|null;
}[]): GitRunner {
    return {
        isRepo: () => true,
        log: (_cwd, file) => {
            const field: 'lockfile'|'packageJson' = file === 'package-lock.json'
                ? 'lockfile'
                : 'packageJson';
            return commits
                .filter((c) => c[field] !== null && c[field] !== undefined)
                .map((c) => `${c.sha},${c.ts}`)
                .join('\n');
        },
        show: (_cwd, ref, file) => {
            const c = commits.find((x) => x.sha === ref);
            if (!c) {
                throw new Error(`missing commit: ${ref}`);
            }
            const blob = file === 'package-lock.json' ? c.lockfile : c.packageJson;
            if (blob === null || blob === undefined) {
                throw new Error(`missing file ${file} at ${ref}`);
            }
            return blob;
        },
        headSha: () => commits[commits.length - 1]?.sha ?? ''
    };
}

function pkgJson(deps: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}): string {
    return JSON.stringify({name: 'fake', version: '1.0.0', ...deps});
}

function lockfile(packages: Record<string, string>): string {
    const out: Record<string, unknown> = {};
    for (const [name, version] of Object.entries(packages)) {
        out[`node_modules/${name}`] = {version};
    }
    return JSON.stringify({
        lockfileVersion: 3,
        packages: {
            '': {name: 'root', version: '1.0.0'},
            ...out
        }
    });
}

describe('GitHistoryBackfill', () => {

    it('returns empty when no git repo', () => {
        const runner: GitRunner = {
            isRepo: () => false,
            log: () => '',
            show: () => '',
            headSha: () => ''
        };
        const backfill = new GitHistoryBackfill(runner);
        const result = backfill.build('/proj');
        expect(result.entries).toEqual([]);
        expect(result.headSha).toBeNull();
    });

    it('builds chronological entries from consecutive commits', () => {
        const c1 = lockfile({foo: '1.0.0', bar: '2.0.0'});
        const c2 = lockfile({foo: '1.0.1', baz: '0.1.0'});  // foo bumped, bar removed, baz added
        const runner = fakeRunner([
            {sha: 'aaa', ts: 1000, lockfile: c1},
            {sha: 'bbb', ts: 2000, lockfile: c2}
        ]);

        const backfill = new GitHistoryBackfill(runner);
        const result = backfill.build('/proj');

        expect(result.entries).toHaveLength(2);
        expect(result.headSha).toBe('bbb');

        // First commit = initial baseline (all added)
        expect(result.entries[0].timestamp).toBe(1000_000);
        expect(result.entries[0].source).toBe('git');
        expect(result.entries[0].commitSha).toBe('aaa');
        expect(result.entries[0].added.map((a) => a.name).sort()).toEqual(['bar', 'foo']);
        expect(result.entries[0].removed).toEqual([]);
        expect(result.entries[0].updated).toEqual([]);

        // Second commit = delta
        expect(result.entries[1].timestamp).toBe(2000_000);
        expect(result.entries[1].added).toEqual([{name: 'baz', version: '0.1.0'}]);
        expect(result.entries[1].removed).toEqual([{name: 'bar', version: '2.0.0'}]);
        expect(result.entries[1].updated).toHaveLength(1);
        expect(result.entries[1].updated[0]).toMatchObject({
            name: 'foo',
            fromVersion: '1.0.0',
            toVersion: '1.0.1',
            bumpType: 'patch'
        });
    });

    it('skips commits whose lockfile fails to parse', () => {
        const c1 = lockfile({foo: '1.0.0'});
        const c2 = '{"lockfileVersion": 1}';  // v1 — rejected
        const c3 = lockfile({foo: '2.0.0'});
        const runner = fakeRunner([
            {sha: 'aaa', ts: 1000, lockfile: c1},
            {sha: 'bbb', ts: 2000, lockfile: c2},
            {sha: 'ccc', ts: 3000, lockfile: c3}
        ]);

        const backfill = new GitHistoryBackfill(runner);
        const result = backfill.build('/proj');

        // Only the two valid commits produced entries
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].commitSha).toBe('aaa');
        expect(result.entries[1].commitSha).toBe('ccc');
        expect(result.entries[1].updated[0]).toMatchObject({
            name: 'foo',
            fromVersion: '1.0.0',
            toVersion: '2.0.0',
            bumpType: 'major'
        });
    });

    it('drops no-op commits (identical lockfile content)', () => {
        const c = lockfile({foo: '1.0.0'});
        const runner = fakeRunner([
            {sha: 'aaa', ts: 1000, lockfile: c},
            {sha: 'bbb', ts: 2000, lockfile: c}   // same lockfile
        ]);

        const backfill = new GitHistoryBackfill(runner);
        const result = backfill.build('/proj');

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].commitSha).toBe('aaa');
    });

    it('reports finalState matching the last commit', () => {
        const runner = fakeRunner([
            {sha: 'aaa', ts: 1000, lockfile: lockfile({foo: '1.0.0'})},
            {sha: 'bbb', ts: 2000, lockfile: lockfile({foo: '1.0.0', bar: '3.0.0'})}
        ]);

        const backfill = new GitHistoryBackfill(runner);
        const result = backfill.build('/proj');

        expect(result.finalState.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            {name: 'bar', version: '3.0.0'},
            {name: 'foo', version: '1.0.0'}
        ]);
    });

    it('fires onProgress for each commit', () => {
        const runner = fakeRunner([
            {sha: 'aaa', ts: 1000, lockfile: lockfile({foo: '1.0.0'})},
            {sha: 'bbb', ts: 2000, lockfile: lockfile({foo: '1.0.1'})},
            {sha: 'ccc', ts: 3000, lockfile: lockfile({foo: '1.0.2'})}
        ]);

        const backfill = new GitHistoryBackfill(runner);
        const calls: [number, number][] = [];
        backfill.build('/proj', (cur, tot) => calls.push([cur, tot]));

        expect(calls).toEqual([[1, 3], [2, 3], [3, 3]]);
    });

    it('falls back to package.json when no lockfile was ever committed', () => {
        // Only package.json — no lockfile in any commit
        const runner = fakeRunner([
            {
                sha: 'aaa', ts: 1000,
                packageJson: pkgJson({dependencies: {foo: '^1.0.0'}})
            },
            {
                sha: 'bbb', ts: 2000,
                packageJson: pkgJson({dependencies: {foo: '^2.0.0', bar: '~1.0.0'}})
            }
        ]);

        const backfill = new GitHistoryBackfill(runner);
        const result = backfill.build('/proj');

        expect(result.source).toBe('package-json');
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].lockfileSource).toBe('package-json');
        expect(result.entries[0].added).toEqual([{name: 'foo', version: '^1.0.0'}]);
        expect(result.entries[1].updated[0]).toMatchObject({
            name: 'foo',
            fromVersion: '^1.0.0',
            toVersion: '^2.0.0'
        });
        expect(result.entries[1].added).toEqual([{name: 'bar', version: '~1.0.0'}]);
        expect(result.finalState.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            {name: 'bar', version: '~1.0.0'},
            {name: 'foo', version: '^2.0.0'}
        ]);
    });

    it('prefers lockfile path even when package.json commits also exist', () => {
        // Both files committed — lockfile wins
        const runner = fakeRunner([
            {
                sha: 'aaa', ts: 1000,
                lockfile: lockfile({foo: '1.0.0'}),
                packageJson: pkgJson({dependencies: {foo: '^1.0.0'}})
            },
            {
                sha: 'bbb', ts: 2000,
                lockfile: lockfile({foo: '1.0.1'}),
                packageJson: pkgJson({dependencies: {foo: '^1.0.0'}})
            }
        ]);

        const backfill = new GitHistoryBackfill(runner);
        const result = backfill.build('/proj');

        expect(result.source).toBe('committed');
        // Resolved versions, not declared ranges
        expect(result.entries[0].added).toEqual([{name: 'foo', version: '1.0.0'}]);
        expect(result.entries[1].updated[0].toVersion).toBe('1.0.1');
    });

    it('reports source: committed (default) on empty git repos', () => {
        // No commits at all
        const runner = fakeRunner([]);
        const backfill = new GitHistoryBackfill(runner);
        const result = backfill.build('/proj');
        expect(result.entries).toEqual([]);
        expect(result.source).toBe('committed');
    });
});
