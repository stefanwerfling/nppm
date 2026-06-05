import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {GithubRelease, ReleasesFetcher} from '../backend/Releases/ReleasesFetcher.js';
import {Registry, RegistryPackage} from '../backend/Registry/Registry.js';

describe('parseGithubRepo', () => {
    it('parses git+https github URLs', () => {
        expect(ReleasesFetcher.parseGithubRepo('git+https://github.com/foo/bar.git')).toEqual({
            owner: 'foo',
            repo: 'bar'
        });
    });
    it('parses bare https github URLs', () => {
        expect(ReleasesFetcher.parseGithubRepo('https://github.com/foo/bar')).toEqual({
            owner: 'foo',
            repo: 'bar'
        });
    });
    it('parses SCP-style git@', () => {
        expect(ReleasesFetcher.parseGithubRepo('git@github.com:foo/bar.git')).toEqual({
            owner: 'foo',
            repo: 'bar'
        });
    });
    it('parses npm shorthand', () => {
        expect(ReleasesFetcher.parseGithubRepo('foo/bar')).toEqual({owner: 'foo', repo: 'bar'});
    });
    it('returns null for non-github / malformed', () => {
        expect(ReleasesFetcher.parseGithubRepo('https://gitlab.com/foo/bar')).toBeNull();
        expect(ReleasesFetcher.parseGithubRepo(undefined)).toBeNull();
        expect(ReleasesFetcher.parseGithubRepo('')).toBeNull();
    });
});

class FakeRegistry extends Registry {
    constructor(private readonly _data: Record<string, RegistryPackage|null>, dir: string) {
        super('unused', new JsonCache(dir, 60));
    }
    public async fetchOne(name: string) {
        return this._data[name] ?? null;
    }
}

describe('ReleasesFetcher', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-rel-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns null when the registry has no record', async () => {
        const reg = new FakeRegistry({}, dir);
        const fetcher = new ReleasesFetcher(reg, null);
        expect(await fetcher.fetch('missing')).toBeNull();
    });

    it('builds a registry-only release list when there is no github repo', async () => {
        const reg = new FakeRegistry({
            foo: {
                name: 'foo',
                latest: '1.1.0',
                versions: ['1.0.0', '1.1.0'],
                time: {
                    '1.0.0': '2024-01-01T00:00:00Z',
                    '1.1.0': '2024-02-01T00:00:00Z'
                }
            }
        }, dir);
        const fetcher = new ReleasesFetcher(reg, null);
        const out = (await fetcher.fetch('foo'))!;

        // sorted newest-first
        expect(out.releases.map((r) => r.version)).toEqual(['1.1.0', '1.0.0']);
        expect(out.releases[0].body).toBeUndefined();
    });

    it('merges GitHub release notes onto matching versions', async () => {
        const reg = new FakeRegistry({
            foo: {
                name: 'foo',
                latest: '1.0.0',
                versions: ['1.0.0', '0.9.0'],
                time: {
                    '1.0.0': '2024-02-01T00:00:00Z',
                    '0.9.0': '2024-01-01T00:00:00Z'
                },
                repository: 'git+https://github.com/foo/foo.git'
            }
        }, dir);

        const ghFetcher = async (_owner: string, _repo: string): Promise<GithubRelease[]> => [
            {
                tag_name: 'v1.0.0',
                name: '1.0.0 - GA',
                body: 'first stable',
                html_url: 'https://github.com/foo/foo/releases/tag/v1.0.0',
                published_at: '2024-02-01T01:00:00Z'
            }
        ];

        const fetcher = new ReleasesFetcher(reg, null, {ghFetcher});
        const out = (await fetcher.fetch('foo'))!;

        const v100 = out.releases.find((r) => r.version === '1.0.0')!;
        expect(v100.body).toBe('first stable');
        expect(v100.name).toBe('1.0.0 - GA');
        expect(v100.url).toBe('https://github.com/foo/foo/releases/tag/v1.0.0');

        // unmatched version keeps registry data only
        const v090 = out.releases.find((r) => r.version === '0.9.0')!;
        expect(v090.body).toBeUndefined();
    });

    it('falls back to registry-only data when GitHub is unreachable', async () => {
        const reg = new FakeRegistry({
            foo: {
                name: 'foo',
                latest: '1.0.0',
                versions: ['1.0.0'],
                time: {'1.0.0': '2024-01-01T00:00:00Z'},
                repository: 'git+https://github.com/foo/foo.git'
            }
        }, dir);
        const ghFetcher = async () => {
            throw new Error('rate limited');
        };
        const fetcher = new ReleasesFetcher(reg, null, {ghFetcher});
        const out = (await fetcher.fetch('foo'))!;
        expect(out.releases[0].body).toBeUndefined();
        expect(out.releases[0].publishedAt).toBe('2024-01-01T00:00:00Z');
    });

    it('caches successful responses so a second fetch makes no network calls', async () => {
        const reg = new FakeRegistry({
            foo: {name: 'foo', latest: '1.0.0', versions: ['1.0.0']}
        }, dir);
        let calls = 0;
        const cache = new JsonCache(dir, 60);
        const fetcher = new ReleasesFetcher(reg, cache);

        // Wrap registry to count calls (cache should suppress the
        // second registry.fetchOne too).
        const origFetchOne = reg.fetchOne.bind(reg);
        reg.fetchOne = async (name: string) => {
            calls++;
            return origFetchOne(name);
        };

        await fetcher.fetch('foo');
        await fetcher.fetch('foo');
        expect(calls).toBe(1);
    });
});