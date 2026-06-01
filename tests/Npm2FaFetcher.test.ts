import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {Npm2FaFetcher} from '../Security/Npm2FaFetcher.js';

/**
 * Replace the global fetch with a fixed-response stub for the
 * duration of one test. Returns a teardown that restores the prior
 * fetch — every test calls it in a `finally` block so the next test
 * doesn't inherit the stub.
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

describe('Npm2FaFetcher.parseTfa', () => {
    it('treats a literal `true` as enabled', () => {
        expect(Npm2FaFetcher.parseTfa(true)).toBe(true);
    });

    it('treats a literal `false` as not enabled', () => {
        expect(Npm2FaFetcher.parseTfa(false)).toBe(false);
    });

    it('treats a missing field as not enabled', () => {
        expect(Npm2FaFetcher.parseTfa(undefined)).toBe(false);
        expect(Npm2FaFetcher.parseTfa(null)).toBe(false);
    });

    it('treats a mode-object as enabled', () => {
        expect(Npm2FaFetcher.parseTfa({mode: 'auth-only'})).toBe(true);
        expect(Npm2FaFetcher.parseTfa({mode: 'auth-and-writes'})).toBe(true);
    });

    it('reports unknown shapes as `null` rather than guessing', () => {
        expect(Npm2FaFetcher.parseTfa({})).toBeNull();
        expect(Npm2FaFetcher.parseTfa('whatever')).toBeNull();
    });
});

describe('Npm2FaFetcher.fetch', () => {
    let dir: string;
    let cache: JsonCache;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-tfa-'));
        cache = new JsonCache(dir, 60);
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns a real boolean when the registry hands one back', async () => {
        const restore = stubFetch(() => ({ok: true, body: {tfa: {mode: 'auth-and-writes'}}}));
        try {
            const fetcher = new Npm2FaFetcher('http://r', cache);
            expect(await fetcher.fetch('alice')).toBe(true);
        } finally {
            restore();
        }
    });

    it('returns null when the registry refuses (401 etc.)', async () => {
        const restore = stubFetch(() => ({ok: false, status: 401}));
        try {
            const fetcher = new Npm2FaFetcher('http://r', cache);
            expect(await fetcher.fetch('alice')).toBeNull();
        } finally {
            restore();
        }
    });

    it('caches the result so a second fetch never hits the network', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: true, body: {tfa: true}};
        });
        try {
            const fetcher = new Npm2FaFetcher('http://r', cache);
            await fetcher.fetch('alice');
            await fetcher.fetch('alice');
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });

    it('caches an unknown answer too — `null` is not a miss', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: false, status: 401};
        });
        try {
            const fetcher = new Npm2FaFetcher('http://r', cache);
            await fetcher.fetch('alice');
            await fetcher.fetch('alice');
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });

    it('returns null for an empty username without hitting the network', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: true, body: {tfa: true}};
        });
        try {
            const fetcher = new Npm2FaFetcher('http://r', cache);
            expect(await fetcher.fetch('')).toBeNull();
            expect(calls).toBe(0);
        } finally {
            restore();
        }
    });
});