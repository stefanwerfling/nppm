import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {NpmDownloadsFetcher} from '../Downloads/NpmDownloadsFetcher.js';

describe('NpmDownloadsFetcher', () => {
    let dir: string;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-dl-'));
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
        globalThis.fetch = originalFetch;
    });

    const mockJson = (
        handler: (url: string) => unknown
    ): void => {
        globalThis.fetch = vi.fn(async (input: RequestInfo|URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            const body = handler(url);
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: {'content-type': 'application/json'}
            });
        }) as unknown as typeof globalThis.fetch;
    };

    it('bulk-fetches unscoped names in a single call', async () => {
        let callCount = 0;
        mockJson((url) => {
            callCount++;
            expect(url).toContain('react,lodash,axios');
            return {
                react: {downloads: 1000, package: 'react'},
                lodash: {downloads: 500, package: 'lodash'},
                axios: {downloads: 300, package: 'axios'}
            };
        });

        const cache = new JsonCache(dir, 60);
        const f = new NpmDownloadsFetcher(cache);
        const out = await f.fetchMany(['react', 'lodash', 'axios']);
        expect(callCount).toBe(1);
        expect(out.get('react')).toBe(1000);
        expect(out.get('lodash')).toBe(500);
        expect(out.get('axios')).toBe(300);
    });

    it('falls back to per-name fetch for scoped packages', async () => {
        const calls: string[] = [];
        mockJson((url) => {
            calls.push(url);
            if (url.includes('@babel/core')) {
                return {downloads: 5000};
            }
            if (url.includes('@types/node')) {
                return {downloads: 12000};
            }
            return {downloads: 0};
        });

        const cache = new JsonCache(dir, 60);
        const f = new NpmDownloadsFetcher(cache);
        const out = await f.fetchMany(['@babel/core', '@types/node']);
        expect(out.get('@babel/core')).toBe(5000);
        expect(out.get('@types/node')).toBe(12000);
        // Two separate fetches, one per scoped name.
        expect(calls.length).toBe(2);
    });

    it('caches successful results so repeated fetchMany skips the HTTP', async () => {
        let callCount = 0;
        mockJson(() => {
            callCount++;
            return {react: {downloads: 1000}};
        });

        const cache = new JsonCache(dir, 60);
        const f = new NpmDownloadsFetcher(cache);
        await f.fetchMany(['react']);
        await f.fetchMany(['react']);
        expect(callCount).toBe(1);
    });

    it('caches null results so a missing package does not keep re-hitting', async () => {
        let callCount = 0;
        mockJson(() => {
            callCount++;
            // Bulk endpoint shape: name as key, null when missing
            return {};
        });

        const cache = new JsonCache(dir, 60);
        const f = new NpmDownloadsFetcher(cache);
        const a = await f.fetchMany(['nonexistent']);
        const b = await f.fetchMany(['nonexistent']);
        expect(a.get('nonexistent')).toBeNull();
        expect(b.get('nonexistent')).toBeNull();
        expect(callCount).toBe(1);
    });

    it('handles single-name bulk responses without a wrapping map', async () => {
        // npm returns the bare object (no {name: object} envelope)
        // when the bulk URL has exactly one package.
        mockJson(() => ({downloads: 99}));
        const cache = new JsonCache(dir, 60);
        const f = new NpmDownloadsFetcher(cache);
        const out = await f.fetchMany(['express']);
        expect(out.get('express')).toBe(99);
    });
});