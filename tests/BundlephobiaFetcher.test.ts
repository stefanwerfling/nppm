import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BundlephobiaFetcher} from '../Bundle/BundlephobiaFetcher.js';
import {JsonCache} from '../Cache/JsonCache.js';

/**
 * Replace the global fetch with a fixed-response stub for the
 * duration of one test. Returns a teardown closure.
 */
function stubFetch(impl: (url: string) => {ok: boolean; status?: number; body?: unknown}): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const res = impl(url);
        return {
            ok: res.ok,
            status: res.status ?? (res.ok ? 200 : 500),
            statusText: res.ok ? 'OK' : 'Error',
            json: async () => res.body ?? {}
        } as unknown as Response;
    }) as typeof fetch;
    return () => {
        globalThis.fetch = original;
    };
}

describe('BundlephobiaFetcher.fetch', () => {
    let dir: string;
    let cache: JsonCache;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-bundle-'));
        cache = new JsonCache(dir, 60, {permanent: true});
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns the parsed payload on success', async () => {
        const restore = stubFetch(() => ({
            ok: true,
            body: {size: 12345, gzip: 4567, dependencyCount: 9}
        }));
        try {
            const f = new BundlephobiaFetcher(cache);
            const r = await f.fetch('lodash', '4.17.21');
            expect(r).toEqual({size: 12345, gzip: 4567, dependencyCount: 9});
        } finally {
            restore();
        }
    });

    it('treats a 404 response as null', async () => {
        const restore = stubFetch(() => ({ok: false, status: 404}));
        try {
            const f = new BundlephobiaFetcher(cache);
            expect(await f.fetch('mystery', '1.0.0')).toBeNull();
        } finally {
            restore();
        }
    });

    it('treats a 200 response without numeric size as null', async () => {
        const restore = stubFetch(() => ({ok: true, body: {dependencyCount: 3}}));
        try {
            const f = new BundlephobiaFetcher(cache);
            expect(await f.fetch('cli-only', '1.0.0')).toBeNull();
        } finally {
            restore();
        }
    });

    it('caches successful results — second fetch never hits the network', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: true, body: {size: 100, gzip: 50, dependencyCount: 0}};
        });
        try {
            const f = new BundlephobiaFetcher(cache);
            await f.fetch('a', '1.0.0');
            await f.fetch('a', '1.0.0');
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });

    it('caches null answers too — refusal is not a miss', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: false, status: 404};
        });
        try {
            const f = new BundlephobiaFetcher(cache);
            await f.fetch('cli', '1.0.0');
            await f.fetch('cli', '1.0.0');
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });

    it('returns null for missing name or version without hitting the network', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: true, body: {size: 1, gzip: 1, dependencyCount: 0}};
        });
        try {
            const f = new BundlephobiaFetcher(cache);
            expect(await f.fetch('', '1.0.0')).toBeNull();
            expect(await f.fetch('a', '')).toBeNull();
            expect(calls).toBe(0);
        } finally {
            restore();
        }
    });

    it('fetchMany resolves a batch keyed by name@version', async () => {
        const restore = stubFetch((url) => {
            const m = /package=([^&]+)/.exec(url);
            const coord = m ? decodeURIComponent(m[1]) : '';
            if (coord === 'a@1.0.0') {
                return {ok: true, body: {size: 100, gzip: 50, dependencyCount: 0}};
            }
            if (coord === 'b@2.0.0') {
                return {ok: true, body: {size: 200, gzip: 80, dependencyCount: 1}};
            }
            return {ok: false, status: 404};
        });
        try {
            const f = new BundlephobiaFetcher(cache);
            const out = await f.fetchMany([
                {name: 'a', version: '1.0.0'},
                {name: 'b', version: '2.0.0'},
                {name: 'c', version: '3.0.0'}
            ]);
            expect(out.get('a@1.0.0')?.size).toBe(100);
            expect(out.get('b@2.0.0')?.gzip).toBe(80);
            expect(out.get('c@3.0.0')).toBeNull();
        } finally {
            restore();
        }
    });
});