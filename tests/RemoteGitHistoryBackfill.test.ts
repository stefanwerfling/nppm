import {describe, expect, it} from 'vitest';
import {ConfigProjectType} from '../backend/Config/Config.js';
import {RemoteGitHistoryBackfill} from '../backend/History/RemoteGitHistoryBackfill.js';
import {ProjectRemote, RemoteCommit} from '../backend/Project/ProjectRemote.js';

/**
 * Test double for `ProjectRemote` that fills the commit-listing
 * methods from in-memory maps. Keyed by file path so the fallback
 * tests can distinguish `package-lock.json` from `package.json`.
 *
 * `commitsPerFile`: file path → ordered (oldest-first) commit list.
 * Missing key means "no commits touched this file" (empty list).
 * `filesAtRef`: `<path>:<ref>` → content. Missing key means the
 * `fetchFileAtRef` call returns null (file absent at that ref).
 */
class FakeRemoteProject extends ProjectRemote {

    constructor(
        private readonly _commitsPerFile: Map<string, RemoteCommit[]>,
        private readonly _filesAtRef: Map<string, string>,
        private readonly _head: string|null = null
    ) {
        super('fake-remote');
    }

    public getType(): ConfigProjectType {
        return ConfigProjectType.github;
    }

    public getKey(): string {
        return 'github:fake-remote';
    }

    protected async fetchFile(): Promise<string|null> {
        return null;
    }

    protected async listDirectory(): Promise<string[]> {
        return [];
    }

    public async listCommitsForFile(repoPath: string): Promise<RemoteCommit[]|null> {
        return this._commitsPerFile.get(repoPath) ?? [];
    }

    public async fetchFileAtRef(repoPath: string, ref: string): Promise<string|null> {
        return this._filesAtRef.get(`${repoPath}:${ref}`) ?? null;
    }

    public async getHeadSha(): Promise<string|null> {
        return this._head;
    }
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

function pkgJson(deps: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}): string {
    return JSON.stringify({name: 'root', version: '1.0.0', ...deps});
}

describe('RemoteGitHistoryBackfill', () => {

    it('returns empty when neither lockfile nor package.json has commits', async () => {
        const project = new FakeRemoteProject(new Map(), new Map(), 'abc');
        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);
        expect(result.entries).toEqual([]);
        expect(result.headSha).toBe('abc');
        expect(result.source).toBe('committed');
    });

    it('builds chronological entries from consecutive remote lockfile commits', async () => {
        const project = new FakeRemoteProject(
            new Map([
                ['package-lock.json', [
                    {sha: 'aaa', timestamp: 1000_000},
                    {sha: 'bbb', timestamp: 2000_000}
                ]]
            ]),
            new Map([
                ['package-lock.json:aaa', lockfile({foo: '1.0.0', bar: '2.0.0'})],
                ['package-lock.json:bbb', lockfile({foo: '1.0.1', baz: '0.1.0'})]
            ]),
            'bbb'
        );

        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);

        expect(result.source).toBe('committed');
        expect(result.headSha).toBe('bbb');
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].commitSha).toBe('aaa');
        expect(result.entries[0].added.map((a) => a.name).sort()).toEqual(['bar', 'foo']);
        expect(result.entries[1].updated[0]).toMatchObject({
            name: 'foo',
            fromVersion: '1.0.0',
            toVersion: '1.0.1',
            bumpType: 'patch'
        });
        expect(result.entries[1].removed).toEqual([{name: 'bar', version: '2.0.0'}]);
    });

    it('skips commits whose lockfile is unparseable', async () => {
        const project = new FakeRemoteProject(
            new Map([
                ['package-lock.json', [
                    {sha: 'aaa', timestamp: 1000_000},
                    {sha: 'bbb', timestamp: 2000_000},
                    {sha: 'ccc', timestamp: 3000_000}
                ]]
            ]),
            new Map([
                ['package-lock.json:aaa', lockfile({foo: '1.0.0'})],
                ['package-lock.json:bbb', '{"lockfileVersion": 1}'],
                ['package-lock.json:ccc', lockfile({foo: '2.0.0'})]
            ]),
            'ccc'
        );

        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);

        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].commitSha).toBe('aaa');
        expect(result.entries[1].commitSha).toBe('ccc');
        expect(result.entries[1].updated[0]).toMatchObject({
            fromVersion: '1.0.0',
            toVersion: '2.0.0',
            bumpType: 'major'
        });
    });

    it('skips commits whose file fetch returns null (deleted at that ref)', async () => {
        const project = new FakeRemoteProject(
            new Map([
                ['package-lock.json', [
                    {sha: 'aaa', timestamp: 1000_000},
                    {sha: 'bbb', timestamp: 2000_000}
                ]]
            ]),
            new Map([
                ['package-lock.json:aaa', lockfile({foo: '1.0.0'})]
                // bbb is missing from files map → fetchFileAtRef returns null
            ]),
            'bbb'
        );

        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].commitSha).toBe('aaa');
    });

    it('reports finalState matching the last successful snapshot', async () => {
        const project = new FakeRemoteProject(
            new Map([
                ['package-lock.json', [
                    {sha: 'aaa', timestamp: 1000_000},
                    {sha: 'bbb', timestamp: 2000_000}
                ]]
            ]),
            new Map([
                ['package-lock.json:aaa', lockfile({foo: '1.0.0'})],
                ['package-lock.json:bbb', lockfile({foo: '1.0.0', bar: '3.0.0'})]
            ]),
            'bbb'
        );

        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);

        expect(result.finalState.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            {name: 'bar', version: '3.0.0'},
            {name: 'foo', version: '1.0.0'}
        ]);
    });

    it('fires onProgress per commit including ones that were skipped', async () => {
        const project = new FakeRemoteProject(
            new Map([
                ['package-lock.json', [
                    {sha: 'aaa', timestamp: 1000_000},
                    {sha: 'bbb', timestamp: 2000_000},
                    {sha: 'ccc', timestamp: 3000_000}
                ]]
            ]),
            new Map([
                ['package-lock.json:aaa', lockfile({foo: '1.0.0'})],
                ['package-lock.json:bbb', '{"lockfileVersion": 1}'],
                ['package-lock.json:ccc', lockfile({foo: '1.0.1'})]
            ]),
            'ccc'
        );

        const backfill = new RemoteGitHistoryBackfill();
        const calls: [number, number][] = [];
        await backfill.build(project, (cur, tot) => calls.push([cur, tot]));

        expect(calls).toEqual([[1, 3], [2, 3], [3, 3]]);
    });

    it('returns empty result when the commit list call throws', async () => {
        class ThrowingProject extends FakeRemoteProject {
            public async listCommitsForFile(): Promise<RemoteCommit[]|null> {
                throw new Error('rate limit');
            }
        }
        const project = new ThrowingProject(new Map(), new Map(), 'abc');
        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);
        expect(result.entries).toEqual([]);
        expect(result.headSha).toBe('abc');
    });

    it('handles a null commit list (API said "no such file") gracefully', async () => {
        class NullProject extends FakeRemoteProject {
            public async listCommitsForFile(): Promise<RemoteCommit[]|null> {
                return null;
            }
        }
        const project = new NullProject(new Map(), new Map(), null);
        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);
        expect(result.entries).toEqual([]);
        expect(result.headSha).toBeNull();
    });

    it('falls back to package.json when no lockfile commits exist', async () => {
        const project = new FakeRemoteProject(
            new Map([
                // No lockfile commits — empty list for that file
                ['package-lock.json', []],
                ['package.json', [
                    {sha: 'aaa', timestamp: 1000_000},
                    {sha: 'bbb', timestamp: 2000_000}
                ]]
            ]),
            new Map([
                ['package.json:aaa', pkgJson({dependencies: {foo: '^1.0.0'}})],
                ['package.json:bbb', pkgJson({dependencies: {foo: '^2.0.0', bar: '~1.0.0'}})]
            ]),
            'bbb'
        );

        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);

        expect(result.source).toBe('package-json');
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].lockfileSource).toBe('package-json');
        expect(result.entries[0].added).toEqual([{name: 'foo', version: '^1.0.0'}]);
        expect(result.entries[1].updated[0]).toMatchObject({
            name: 'foo',
            fromVersion: '^1.0.0',
            toVersion: '^2.0.0'
        });
    });

    it('prefers lockfile path even when package.json commits also exist', async () => {
        const project = new FakeRemoteProject(
            new Map([
                ['package-lock.json', [{sha: 'aaa', timestamp: 1000_000}]],
                ['package.json', [{sha: 'aaa', timestamp: 1000_000}]]
            ]),
            new Map([
                ['package-lock.json:aaa', lockfile({foo: '1.0.0'})],
                ['package.json:aaa', pkgJson({dependencies: {foo: '^1.0.0'}})]
            ]),
            'aaa'
        );

        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);

        expect(result.source).toBe('committed');
        // Resolved version (1.0.0), not the declared range (^1.0.0)
        expect(result.entries[0].added).toEqual([{name: 'foo', version: '1.0.0'}]);
    });

    it('falls back when the lockfile commits-list call throws but package.json is reachable', async () => {
        class PartiallyThrowingProject extends FakeRemoteProject {
            public async listCommitsForFile(file: string): Promise<RemoteCommit[]|null> {
                if (file === 'package-lock.json') {
                    throw new Error('lockfile API blip');
                }
                return super.listCommitsForFile(file);
            }
        }
        const project = new PartiallyThrowingProject(
            new Map([
                ['package.json', [{sha: 'aaa', timestamp: 1000_000}]]
            ]),
            new Map([
                ['package.json:aaa', pkgJson({dependencies: {foo: '^1.0.0'}})]
            ]),
            'aaa'
        );

        const backfill = new RemoteGitHistoryBackfill();
        const result = await backfill.build(project);

        expect(result.source).toBe('package-json');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].added).toEqual([{name: 'foo', version: '^1.0.0'}]);
    });
});