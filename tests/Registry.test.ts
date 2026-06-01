import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {Registry} from '../Registry/Registry.js';

/**
 * Build a fetch double that maps URL → response body. Throws if a
 * URL outside the map is asked for, so accidental network reach
 * surfaces as a test failure.
 */
function makeFetch(routes: Record<string, unknown>): typeof fetch {
    return vi.fn(async (input: unknown) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        if (!(url in routes)) {
            throw new Error(`unexpected fetch ${url}`);
        }

        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => routes[url]
        } as Response;
    }) as unknown as typeof fetch;
}

describe('Registry', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-reg-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
        vi.unstubAllGlobals();
    });

    it('returns latest + versions for a successful hit', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/lodash': {
                name: 'lodash',
                'dist-tags': {latest: '4.17.21'},
                versions: {'4.17.21': {}, '4.17.20': {}},
                time: {'4.17.21': '2021-02-20T00:00:00Z'}
            }
        }));

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache);
        const pkg = await r.fetchOne('lodash');

        expect(pkg).not.toBeNull();
        expect(pkg!.latest).toBe('4.17.21');
        expect(pkg!.versions.sort()).toEqual(['4.17.20', '4.17.21']);
    });

    it('cache prevents a second HTTP call', async () => {
        const fetchMock = makeFetch({
            'https://registry.example/foo': {
                name: 'foo',
                'dist-tags': {latest: '1.0.0'},
                versions: {'1.0.0': {}}
            }
        });
        vi.stubGlobal('fetch', fetchMock);

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache);

        await r.fetchOne('foo');
        await r.fetchOne('foo');

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns null on non-2xx', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 404,
            statusText: 'Not Found'
        } as Response)));

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache);
        expect(await r.fetchOne('ghost')).toBeNull();
    });

    it('fetchMany deduplicates names and returns a map', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/a': {
                name: 'a',
                'dist-tags': {latest: '1.0.0'},
                versions: {'1.0.0': {}}
            },
            'https://registry.example/b': {
                name: 'b',
                'dist-tags': {latest: '2.0.0'},
                versions: {'2.0.0': {}}
            }
        }));

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache);
        const result = await r.fetchMany(['a', 'b', 'a']);

        expect(result.size).toBe(2);
        expect(result.get('a')!.latest).toBe('1.0.0');
        expect(result.get('b')!.latest).toBe('2.0.0');
    });

    it('extracts per-version `_npmUser` into the publishers map', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/foo': {
                name: 'foo',
                'dist-tags': {latest: '1.0.1'},
                versions: {
                    '1.0.0': {_npmUser: {name: 'alice', email: 'a@x'}},
                    '1.0.1': {_npmUser: {name: 'bob'}},
                    // No `_npmUser` — should be omitted from the map.
                    '0.9.0': {}
                }
            }
        }));

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache);
        const pkg = await r.fetchOne('foo');

        expect(pkg!.publishers).toBeDefined();
        expect(pkg!.publishers!['1.0.0']).toEqual({name: 'alice', email: 'a@x'});
        expect(pkg!.publishers!['1.0.1']).toEqual({name: 'bob'});
        expect(pkg!.publishers!['0.9.0']).toBeUndefined();
    });

    it('extracts modern bare-string license field', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/p': {
                name: 'p',
                'dist-tags': {latest: '1.0.0'},
                versions: {'1.0.0': {}},
                license: 'MIT'
            }
        }));
        const r = new Registry('https://registry.example', new JsonCache(dir, 60));
        const pkg = await r.fetchOne('p');
        expect(pkg!.license).toBe('MIT');
    });

    it('extracts deprecated {type,url} license object', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/p': {
                name: 'p',
                'dist-tags': {latest: '1.0.0'},
                versions: {'1.0.0': {}},
                license: {type: 'Apache-2.0', url: 'https://…'}
            }
        }));
        const r = new Registry('https://registry.example', new JsonCache(dir, 60));
        const pkg = await r.fetchOne('p');
        expect(pkg!.license).toBe('Apache-2.0');
    });

    it('joins legacy licenses[] array as an OR-expression', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/p': {
                name: 'p',
                'dist-tags': {latest: '1.0.0'},
                versions: {'1.0.0': {}},
                licenses: [{type: 'MIT'}, {type: 'Apache-2.0'}]
            }
        }));
        const r = new Registry('https://registry.example', new JsonCache(dir, 60));
        const pkg = await r.fetchOne('p');
        expect(pkg!.license).toBe('(MIT OR Apache-2.0)');
    });

    it('omits the publishers field when no version has `_npmUser`', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/old': {
                name: 'old',
                'dist-tags': {latest: '1.0.0'},
                versions: {'1.0.0': {}}
            }
        }));

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache);
        const pkg = await r.fetchOne('old');

        expect(pkg!.publishers).toBeUndefined();
    });

    it('extracts dist.signatures + dist.attestations from a provenance-published version', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/proven': {
                name: 'proven',
                'dist-tags': {latest: '1.0.0'},
                versions: {
                    '1.0.0': {
                        dist: {
                            tarball: 'https://registry.example/proven/-/proven-1.0.0.tgz',
                            integrity: 'sha512-abc',
                            signatures: [{keyid: 'SHA256:k', sig: 'MEYC'}],
                            attestations: {
                                url: 'https://registry.example/-/npm/v1/attestations/proven@1.0.0',
                                provenance: {predicateType: 'https://slsa.dev/provenance/v0.2'}
                            }
                        }
                    }
                }
            }
        }));

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache);
        const pkg = await r.fetchOne('proven');

        const dist = pkg!.dist?.['1.0.0'];
        expect(dist).toBeDefined();
        expect(dist!.integrity).toBe('sha512-abc');
        expect(dist!.signatures).toEqual([{keyid: 'SHA256:k', sig: 'MEYC'}]);
        expect(dist!.attestations?.url).toMatch(/attestations\/proven/);
        expect(dist!.attestations?.provenance?.predicateType).toBe('https://slsa.dev/provenance/v0.2');
    });

    it('omits signatures/attestations when the registry serves neither', async () => {
        vi.stubGlobal('fetch', makeFetch({
            'https://registry.example/bare': {
                name: 'bare',
                'dist-tags': {latest: '1.0.0'},
                versions: {
                    '1.0.0': {
                        dist: {
                            tarball: 'https://registry.example/bare/-/bare-1.0.0.tgz'
                        }
                    }
                }
            }
        }));

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache);
        const pkg = await r.fetchOne('bare');

        const dist = pkg!.dist?.['1.0.0'];
        expect(dist).toBeDefined();
        expect(dist!.signatures).toBeUndefined();
        expect(dist!.attestations).toBeUndefined();
    });

    it('sends Authorization header when configured', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
                name: 'priv',
                'dist-tags': {latest: '1'},
                versions: {'1': {}}
            })
        } as Response));
        vi.stubGlobal('fetch', fetchMock);

        const cache = new JsonCache(dir, 60);
        const r = new Registry('https://registry.example', cache, 'secret');
        await r.fetchOne('priv');

        const call = fetchMock.mock.calls[0] as unknown as [string, {headers: Record<string, string>}];
        expect(call[1].headers.Authorization).toBe('Bearer secret');
    });
});