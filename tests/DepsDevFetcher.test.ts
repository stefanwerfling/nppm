import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {DepsDevFetcher} from '../backend/Security/External/DepsDevFetcher.js';

function stubFetch(impl: (url: string) => {ok: boolean; status?: number; body?: unknown;}): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async(input: RequestInfo|URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const res = impl(url);
        return {
            ok: res.ok,
            status: res.status ?? (res.ok ? 200 : 500),
            statusText: res.ok ? 'OK' : 'Error',
            json: async() => res.body ?? {}
        } as unknown as Response;
    }) as typeof fetch;
    return () => {
        globalThis.fetch = original;
    };
}

describe('DepsDevFetcher.parseVersion', () => {
    it('parses a typical v3 version response', () => {
        const v = DepsDevFetcher.parseVersion({
            versionKey: {system: 'NPM', name: 'lodash', version: '4.17.21'},
            defaultVersion: '4.17.21',
            isDefault: true,
            licenses: ['MIT'],
            publishedAt: '2021-02-20T13:00:00Z',
            relatedProjects: [
                {projectKey: {name: 'github.com/lodash/lodash'}, relationType: 'SOURCE_REPO_TYPE'}
            ],
            advisoryKeys: [{id: 'GHSA-xyz'}]
        });
        expect(v).not.toBeNull();
        expect(v!.versionKey.name).toBe('lodash');
        expect(v!.defaultVersion).toBe('4.17.21');
        expect(v!.isDefault).toBe(true);
        expect(v!.licenses).toEqual(['MIT']);
        expect(v!.projects).toEqual([{type: 'SOURCE_REPO_TYPE', name: 'github.com/lodash/lodash'}]);
        expect(v!.advisoryKeys).toEqual(['GHSA-xyz']);
    });

    it('returns null when versionKey is missing', () => {
        expect(DepsDevFetcher.parseVersion({})).toBeNull();
        expect(DepsDevFetcher.parseVersion(null)).toBeNull();
    });

    it('synthesises isDefault from defaultVersion === versionKey.version', () => {
        const v = DepsDevFetcher.parseVersion({
            versionKey: {system: 'NPM', name: 'x', version: '1.0.0'},
            defaultVersion: '2.0.0'
        });
        expect(v!.isDefault).toBe(false);
    });
});

describe('DepsDevFetcher.fetch', () => {
    let dir: string;
    let cache: JsonCache;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-depsdev-'));
        cache = new JsonCache(dir, 60);
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('caches the parsed result so a second call never re-fetches', async() => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {
                ok: true,
                body: {versionKey: {system: 'NPM', name: 'x', version: '1'}, isDefault: true}
            };
        });
        try {
            const f = new DepsDevFetcher(cache);
            await f.fetch('x', '1');
            await f.fetch('x', '1');
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });
});