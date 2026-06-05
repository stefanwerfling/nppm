import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {OpenSsfFetcher} from '../backend/Security/External/OpenSsfFetcher.js';

function stubFetch(impl: (url: string) => {ok: boolean; status?: number; body?: unknown}): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo|URL) => {
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

describe('OpenSsfFetcher.parseRepoUrl', () => {
    it('parses git+https URLs across hosts', () => {
        expect(OpenSsfFetcher.parseRepoUrl('git+https://github.com/lodash/lodash.git'))
            .toEqual({host: 'github.com', owner: 'lodash', repo: 'lodash'});
        expect(OpenSsfFetcher.parseRepoUrl('git+https://gitlab.com/g/r.git'))
            .toEqual({host: 'gitlab.com', owner: 'g', repo: 'r'});
        expect(OpenSsfFetcher.parseRepoUrl('git+https://bitbucket.org/b/r.git'))
            .toEqual({host: 'bitbucket.org', owner: 'b', repo: 'r'});
    });

    it('parses plain https URLs without .git suffix', () => {
        expect(OpenSsfFetcher.parseRepoUrl('https://github.com/axios/axios'))
            .toEqual({host: 'github.com', owner: 'axios', repo: 'axios'});
    });

    it('parses ssh URLs', () => {
        expect(OpenSsfFetcher.parseRepoUrl('git@github.com:owner/repo.git'))
            .toEqual({host: 'github.com', owner: 'owner', repo: 'repo'});
    });

    it('parses npm shorthand (owner/repo) as GitHub', () => {
        expect(OpenSsfFetcher.parseRepoUrl('owner/repo'))
            .toEqual({host: 'github.com', owner: 'owner', repo: 'repo'});
    });

    it('parses github:owner/repo shorthand', () => {
        expect(OpenSsfFetcher.parseRepoUrl('github:foo/bar'))
            .toEqual({host: 'github.com', owner: 'foo', repo: 'bar'});
    });

    it('returns null for unsupported hosts', () => {
        expect(OpenSsfFetcher.parseRepoUrl('https://example.com/foo/bar')).toBeNull();
        expect(OpenSsfFetcher.parseRepoUrl(null)).toBeNull();
        expect(OpenSsfFetcher.parseRepoUrl('')).toBeNull();
    });
});

describe('OpenSsfFetcher.parseResult', () => {
    it('parses a typical Scorecard response', () => {
        const r = OpenSsfFetcher.parseResult({
            score: 8.4,
            repo: {name: 'github.com/lodash/lodash'},
            checks: [
                {name: 'Code-Review', score: 9, reason: 'passing'},
                {name: 'Token-Permissions', score: 4}
            ]
        });
        expect(r).not.toBeNull();
        expect(r!.score).toBe(8.4);
        expect(r!.checks).toHaveLength(2);
        expect(r!.repoUrl).toBe('github.com/lodash/lodash');
    });

    it('drops malformed checks without crashing', () => {
        const r = OpenSsfFetcher.parseResult({
            score: 5,
            checks: [{name: 'x', score: 'not a number'}, null, {name: 'y', score: 3}]
        });
        expect(r!.checks).toHaveLength(1);
        expect(r!.checks[0].name).toBe('y');
    });

    it('returns null for an unusable body', () => {
        expect(OpenSsfFetcher.parseResult(null)).toBeNull();
        expect(OpenSsfFetcher.parseResult([])).toEqual({score: null, checks: [], repoUrl: ''});
    });
});

describe('OpenSsfFetcher.fetch', () => {
    let dir: string;
    let cache: JsonCache;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-openssf-'));
        cache = new JsonCache(dir, 60);
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('caches the parsed result so a second call never re-fetches', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: true, body: {score: 7.5, checks: []}};
        });
        try {
            const f = new OpenSsfFetcher(cache);
            await f.fetch({host: 'github.com', owner: 'o', repo: 'r'});
            await f.fetch({host: 'github.com', owner: 'o', repo: 'r'});
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });

    it('caches the null envelope on 404 — Scorecard hasn\'t scored this repo', async () => {
        let calls = 0;
        const restore = stubFetch(() => {
            calls++;
            return {ok: false, status: 404};
        });
        try {
            const f = new OpenSsfFetcher(cache);
            await f.fetch({host: 'github.com', owner: 'o', repo: 'r'});
            await f.fetch({host: 'github.com', owner: 'o', repo: 'r'});
            expect(calls).toBe(1);
        } finally {
            restore();
        }
    });
});