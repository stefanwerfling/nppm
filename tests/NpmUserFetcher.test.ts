import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {NpmUserFetcher} from '../Security/NpmUserFetcher.js';

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

describe('NpmUserFetcher.parseTfa', () => {
    it('treats a literal `true` as enabled', () => {
        expect(NpmUserFetcher.parseTfa(true)).toBe(true);
    });

    it('treats a literal `false` as not enabled', () => {
        expect(NpmUserFetcher.parseTfa(false)).toBe(false);
    });

    it('treats a missing field as not enabled', () => {
        expect(NpmUserFetcher.parseTfa(undefined)).toBe(false);
        expect(NpmUserFetcher.parseTfa(null)).toBe(false);
    });

    it('treats a mode-object as enabled', () => {
        expect(NpmUserFetcher.parseTfa({mode: 'auth-only'})).toBe(true);
        expect(NpmUserFetcher.parseTfa({mode: 'auth-and-writes'})).toBe(true);
    });

    it('reports unknown shapes as `null` rather than guessing', () => {
        expect(NpmUserFetcher.parseTfa({})).toBeNull();
        expect(NpmUserFetcher.parseTfa('whatever')).toBeNull();
    });
});

describe('NpmUserFetcher.parseCreated', () => {
    it('returns plain ISO strings as-is', () => {
        expect(NpmUserFetcher.parseCreated('2021-01-01T00:00:00.000Z')).toBe('2021-01-01T00:00:00.000Z');
    });

    it('pulls the iso field out of the legacy {ts, iso} shape', () => {
        expect(NpmUserFetcher.parseCreated({ts: 1, iso: '2022-05-02T00:00:00Z'})).toBe('2022-05-02T00:00:00Z');
    });

    it('returns null for missing or empty values', () => {
        expect(NpmUserFetcher.parseCreated(undefined)).toBeNull();
        expect(NpmUserFetcher.parseCreated(null)).toBeNull();
        expect(NpmUserFetcher.parseCreated('')).toBeNull();
        expect(NpmUserFetcher.parseCreated({})).toBeNull();
    });
});

describe('NpmUserFetcher.fetch', () => {
    let dir: string;
    let cache: JsonCache;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-user-'));
        cache = new JsonCache(dir, 60);
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns the parsed envelope when the registry answers', async () => {
        const restore = stubFetch(() => ({
            ok: true,
            body: {tfa: {mode: 'auth-and-writes'}, created: '2018-03-15T10:00:00Z'}
        }));
        try {
            const fetcher = new NpmUserFetcher('http://r', cache);
            const doc = await fetcher.fetch('alice');
            expect(doc).not.toBeNull();
            expect(doc!.tfa).toBe(true);
            expect(doc!.created).toBe('2018-03-15T10:00:00Z');
        } finally {
            restore();
        }
    });

    it('returns null when the registry refuses (401 etc.)', async () => {
        const restore = stubFetch(() => ({ok: false, status: 401}));
        try {
            const fetcher = new NpmUserFetcher('http://r', cache);
            expect(await fetcher.fetch('alice')).toBeNull();
        } finally {
            restore();
        }
    });

    it('caches the parsed envelope so a second fetch never hits the network', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: true, body: {tfa: true, created: '2020-01-01T00:00:00Z'}};
        });
        try {
            const fetcher = new NpmUserFetcher('http://r', cache);
            await fetcher.fetch('alice');
            await fetcher.fetch('alice');
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });

    it('caches the null envelope too — refusal is not a miss', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: false, status: 401};
        });
        try {
            const fetcher = new NpmUserFetcher('http://r', cache);
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
            return {ok: true, body: {tfa: true, created: '2020-01-01T00:00:00Z'}};
        });
        try {
            const fetcher = new NpmUserFetcher('http://r', cache);
            expect(await fetcher.fetch('')).toBeNull();
            expect(calls).toBe(0);
        } finally {
            restore();
        }
    });
});
