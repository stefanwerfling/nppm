import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {SocketDevFetcher} from '../Security/External/SocketDevFetcher.js';

function stubFetch(impl: (url: string, init?: RequestInit) => {ok: boolean; status?: number; body?: unknown}): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo|URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const res = impl(url, init);
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

describe('SocketDevFetcher.parseScore', () => {
    it('reads the flat shape', () => {
        const s = SocketDevFetcher.parseScore({
            overall: 0.72, supplyChain: 0.4, quality: 0.9, maintenance: 0.6,
            vulnerability: 1.0, license: 0.8
        });
        expect(s).not.toBeNull();
        expect(s!.overall).toBe(0.72);
        expect(s!.supplyChain).toBe(0.4);
    });

    it('reads the legacy {score: {…}} envelope', () => {
        const s = SocketDevFetcher.parseScore({score: {overall: 0.5, supply_chain: 0.3}});
        expect(s).not.toBeNull();
        expect(s!.overall).toBe(0.5);
        expect(s!.supplyChain).toBe(0.3);
    });

    it('returns null for an unusable body', () => {
        expect(SocketDevFetcher.parseScore(null)).toBeNull();
        expect(SocketDevFetcher.parseScore('whatever')).toBeNull();
    });

    it('treats every missing number as null without escalating', () => {
        const s = SocketDevFetcher.parseScore({});
        expect(s).not.toBeNull();
        expect(s!.overall).toBeNull();
        expect(s!.quality).toBeNull();
    });
});

describe('SocketDevFetcher.fetch', () => {
    let dir: string;
    let cache: JsonCache;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-socket-'));
        cache = new JsonCache(dir, 60);
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns null and skips the network without an API key', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: true, body: {overall: 0.5}};
        });
        try {
            const f = new SocketDevFetcher(cache);
            expect(await f.fetch('lodash', '4.17.21')).toBeNull();
            expect(calls).toBe(0);
            expect(f.hasKey()).toBe(false);
        } finally {
            restore();
        }
    });

    it('sends the API key as Bearer and parses the response', async () => {
        let seenAuth: string|null = null;
        const restore = stubFetch((_url, init) => {
            const h = init?.headers as Record<string, string>|undefined;
            seenAuth = h?.Authorization ?? null;
            return {ok: true, body: {overall: 0.9}};
        });
        try {
            const f = new SocketDevFetcher(cache, 'secret-key');
            const s = await f.fetch('lodash', '4.17.21');
            expect(seenAuth).toBe('Bearer secret-key');
            expect(s!.overall).toBe(0.9);
        } finally {
            restore();
        }
    });

    it('caches the null envelope on refusal so a second call never re-fetches', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: false, status: 401};
        });
        try {
            const f = new SocketDevFetcher(cache, 'k');
            await f.fetch('lodash', '4.17.21');
            await f.fetch('lodash', '4.17.21');
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });
});