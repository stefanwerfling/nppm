import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {Registry} from '../backend/Registry/Registry.js';
import {DepsDevFetcher} from '../backend/Security/External/DepsDevFetcher.js';
import {OpenSsfFetcher} from '../backend/Security/External/OpenSsfFetcher.js';
import {SocketDevFetcher} from '../backend/Security/External/SocketDevFetcher.js';
import {ExternalSeverity, ExternalSourcesScanner} from '../backend/Security/ExternalSourcesScanner.js';

type StubResponse = {ok: boolean; status?: number; body?: unknown;};

/**
 * URL-aware fetch stub. Each test passes a router function that maps
 * URL → response; everything else lands as a 500 so a missing route
 * fails loudly instead of being silently treated as null.
 */
function stubFetch(router: (url: string) => StubResponse|undefined): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async(input: RequestInfo|URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const res = router(url) ?? {ok: false, status: 500};
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

describe('ExternalSourcesScanner', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-ext-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    function make(opts: {
        socketKey?: string;
        enabled?: boolean;
        socketEnabled?: boolean;
        openssfEnabled?: boolean;
        depsDevEnabled?: boolean;
    } = {}): ExternalSourcesScanner {
        const regCache = new JsonCache(path.join(dir, 'reg'), 60);
        const registry = new Registry('https://registry.npmjs.org', regCache);
        const socket = new SocketDevFetcher(
            new JsonCache(path.join(dir, 'sock'), 60),
            opts.socketKey
        );
        const openssf = new OpenSsfFetcher(new JsonCache(path.join(dir, 'osf'), 60));
        const depsDev = new DepsDevFetcher(new JsonCache(path.join(dir, 'dd'), 60));
        return new ExternalSourcesScanner(registry, socket, openssf, depsDev, {
            enabled: opts.enabled,
            socket: {enabled: opts.socketEnabled},
            openssf: {enabled: opts.openssfEnabled},
            depsDev: {enabled: opts.depsDevEnabled}
        });
    }

    it('returns empty findings when the master switch is off', async() => {
        const scanner = make({enabled: false});
        const r = await scanner.scan('lodash', '4.17.21');
        expect(r.level).toBeNull();
        expect(r.findings).toHaveLength(0);
        expect(scanner.hasAnySource()).toBe(false);
    });

    it('returns empty findings for a git-version package', async() => {
        const scanner = make({socketKey: 'k'});
        const r = await scanner.scan('figtree', 'git+https://github.com/x/figtree.git#main');
        expect(r.level).toBeNull();
        expect(r.findings).toHaveLength(0);
    });

    it('aggregates worst-of-three severity from real responses', async() => {
        /*
         * socket overall 0.4 (=40/100) below the risk threshold → risk
         * OpenSSF 7.5 → info (≥ 7)
         * deps.dev metadata → info
         * worst-of-three = risk
         */
        const restore = stubFetch((url) => {
            if (url.includes('registry.npmjs.org/lodash')) {
                return {ok: true, body: {
                    'name': 'lodash',
                    'dist-tags': {latest: '4.17.21'},
                    'versions': {'4.17.21': {}},
                    'repository': {url: 'git+https://github.com/lodash/lodash.git'}
                }};
            }
            if (url.includes('socket.dev/v0/npm/lodash/4.17.21/score')) {
                return {ok: true, body: {overall: 0.4}};
            }
            if (url.includes('securityscorecards.dev/projects/github.com/lodash/lodash')) {
                return {ok: true, body: {score: 7.5, checks: [], repo: {name: 'github.com/lodash/lodash'}}};
            }
            if (url.includes('deps.dev/v3/systems/npm/packages/lodash/versions/4.17.21')) {
                return {ok: true, body: {
                    versionKey: {system: 'NPM', name: 'lodash', version: '4.17.21'},
                    defaultVersion: '4.17.21', isDefault: true
                }};
            }
            return undefined;
        });
        try {
            const scanner = make({socketKey: 'key'});
            const r = await scanner.scan('lodash', '4.17.21');
            expect(r.level).toBe(ExternalSeverity.risk);
            expect(r.findings).toHaveLength(3);
            const sources = r.findings.map((f) => f.source).sort();
            expect(sources).toEqual(['depsDev', 'openssf', 'socket']);
        } finally {
            restore();
        }
    });

    it('skips socket when no API key is configured', async() => {
        const restore = stubFetch((url) => {
            if (url.includes('registry.npmjs.org/lodash')) {
                return {ok: true, body: {
                    'name': 'lodash',
                    'dist-tags': {latest: '4.17.21'},
                    'versions': {'4.17.21': {}}
                }};
            }
            if (url.includes('socket.dev/')) {
                /*
                 * Stub will return undefined if hit — but socket
                 * should not be invoked at all without a key.
                 */
                return undefined;
            }
            if (url.includes('securityscorecards.dev/')) {
                return {ok: false, status: 404};
            }
            if (url.includes('deps.dev/')) {
                return {ok: true, body: {
                    versionKey: {system: 'NPM', name: 'lodash', version: '4.17.21'}
                }};
            }
            return undefined;
        });
        try {
            const scanner = make({});
            const r = await scanner.scan('lodash', '4.17.21');
            /*
             * Without a key socket is dropped; OpenSSF 404 yields null;
             * only deps.dev contributes → info-only finding.
             */
            expect(r.findings.every((f) => f.source !== 'socket')).toBe(true);
            expect(r.level).toBe(ExternalSeverity.info);
        } finally {
            restore();
        }
    });

    it('hasAnySource is false when every per-source flag is off', () => {
        const scanner = make({socketEnabled: false, openssfEnabled: false, depsDevEnabled: false});
        expect(scanner.hasAnySource()).toBe(false);
    });

    it('hasAnySource is true with just deps.dev', () => {
        const scanner = make({socketEnabled: false, openssfEnabled: false});
        expect(scanner.hasAnySource()).toBe(true);
    });

    it('setEnabled disables the scanner at runtime', async() => {
        const scanner = make({socketKey: 'k'});
        expect(scanner.isEnabled()).toBe(true);
        scanner.setEnabled(false);
        expect(scanner.isEnabled()).toBe(false);
        const r = await scanner.scan('lodash', '4.17.21');
        expect(r.findings).toHaveLength(0);
    });

    it('scanBatch returns one entry per input in order', async() => {
        const restore = stubFetch((url) => {
            if (url.includes('registry.npmjs.org/')) {
                return {ok: true, body: {
                    'name': 'x',
                    'dist-tags': {latest: '1.0.0'},
                    'versions': {'1.0.0': {}}
                }};
            }
            return {ok: false, status: 404};
        });
        try {
            const scanner = make({});
            const r = await scanner.scanBatch([
                {name: 'a', version: '1.0.0'},
                {name: 'b', version: '2.0.0'}
            ]);
            expect(r).toHaveLength(2);
            expect(r[0].name).toBe('a');
            expect(r[1].name).toBe('b');
        } finally {
            restore();
        }
    });

    it('summarise produces the compact matrix shape', () => {
        const summary = ExternalSourcesScanner.summarise({
            name: 'x', version: '1', level: ExternalSeverity.warn,
            findings: [
                {source: 'socket', severity: ExternalSeverity.warn, score: 65, detail: 'x', url: null, raw: null},
                {source: 'depsDev', severity: ExternalSeverity.info, score: null, detail: 'y', url: null, raw: null}
            ]
        });
        expect(summary).toEqual({name: 'x', version: '1', level: ExternalSeverity.warn, count: 2});
    });
});