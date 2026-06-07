import {describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {Registry, RegistryPackage} from '../backend/Registry/Registry.js';
import {MaintainerScanner, MaintainerSeverity} from '../backend/Security/MaintainerScanner.js';
import {NpmUserFetcher} from '../backend/Security/NpmUserFetcher.js';

function makeRegistry(name: string, pkg: RegistryPackage): Registry {
    /*
     * Stand-in: poke the static `RegistryPackage` straight into a fresh
     * disk cache so `fetchOne` returns it as a cache hit and the test
     * never reaches a network path.
     */
    const dir = `/tmp/nppm-maint-${  Math.random().toString(36).slice(2)}`;
    const cache = new JsonCache(dir, 60);
    cache.set(name, pkg);
    return new Registry('http://unused', cache);
}

describe('MaintainerScanner.previousStableVersions', () => {
    it('returns predecessors newest-first', () => {
        const out = MaintainerScanner.previousStableVersions(['1.0.0', '1.2.0', '1.1.0', '2.0.0'], '2.0.0');
        expect(out).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    });

    it('skips pre-release versions', () => {
        const out = MaintainerScanner.previousStableVersions(['1.0.0', '2.0.0-rc.1', '1.5.0'], '2.0.0');
        expect(out).toEqual(['1.5.0', '1.0.0']);
    });

    it('returns empty list when target is not parseable', () => {
        expect(MaintainerScanner.previousStableVersions(['1.0.0'], 'not-semver')).toEqual([]);
    });
});

describe('MaintainerScanner.scan', () => {

    /**
     * Helper: build a packument-shaped `RegistryPackage` with `n`
     * versions all published by `oldOwner`, then a final version
     * published by `newOwner` after `gapDays` days of silence.
     */
    function pkgWithHandover(opts: {
        priorCount: number;
        oldOwner: string;
        newOwner: string;
        gapDays: number;
    }): RegistryPackage {
        const versions: string[] = [];
        const publishers: Record<string, {name: string;}> = {};
        const time: Record<string, string> = {};

        // First N stable versions, one per week.
        const start = Date.parse('2022-01-01T00:00:00Z');
        for (let i = 0; i < opts.priorCount; i++) {
            const v = `1.0.${i}`;
            versions.push(v);
            publishers[v] = {name: opts.oldOwner};
            time[v] = new Date(start + (i * 7 * 86400_000)).toISOString();
        }

        const latest = `1.0.${opts.priorCount}`;
        const lastPrior = `1.0.${opts.priorCount - 1}`;
        versions.push(latest);
        publishers[latest] = {name: opts.newOwner};
        time[latest] = new Date(
            Date.parse(time[lastPrior]) + (opts.gapDays * 86400_000)
        ).toISOString();

        return {
            name: 'pkg',
            latest: latest,
            versions: versions,
            publishers: publishers,
            time: time
        };
    }

    it('flags an active mature package with a fast owner handover as RISK', async() => {
        // gap = 3 days: the event-stream / ua-parser-js pattern.
        const registry = makeRegistry('pkg', pkgWithHandover({
            priorCount: 20,
            oldOwner: 'alice',
            newOwner: 'eve',
            gapDays: 3
        }));

        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', '1.0.20');

        expect(finding).not.toBeNull();
        expect(finding!.severity).toBe(MaintainerSeverity.risk);
        expect(finding!.currentPublisher?.name).toBe('eve');
    });

    it('flags a medium-gap handover on a mature package as WARN', async() => {
        /*
         * gap = 60 days: long enough to be unusual, short enough to be
         * worth checking. Below the suspiciousGapDays default of 180.
         */
        const registry = makeRegistry('pkg', pkgWithHandover({
            priorCount: 15,
            oldOwner: 'alice',
            newOwner: 'bob',
            gapDays: 60
        }));

        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', '1.0.15');

        expect(finding!.severity).toBe(MaintainerSeverity.warn);
    });

    it('demotes a long-silence handover to INFO (community takeover)', async() => {
        /*
         * gap = 789 days: typical abandoned-package adoption — usually
         * benign, not a takeover.
         */
        const registry = makeRegistry('pkg', pkgWithHandover({
            priorCount: 20,
            oldOwner: 'alice',
            newOwner: 'siemienik',
            gapDays: 789
        }));

        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', '1.0.20');

        expect(finding!.severity).toBe(MaintainerSeverity.info);
        expect(finding!.reason).toMatch(/community takeover/u);
    });

    it('softens to WARN when the package is young (few predecessors)', async() => {
        const registry = makeRegistry('pkg', pkgWithHandover({
            priorCount: 3,
            oldOwner: 'alice',
            newOwner: 'eve',
            gapDays: 3
        }));

        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', '1.0.3');

        expect(finding!.severity).toBe(MaintainerSeverity.warn);
    });

    it('respects custom thresholds from config', async() => {
        /*
         * With the default 30/180 ladder, a 60-day gap is `warn`. A
         * strict project may want anything ≤ 90 days to be `risk`.
         */
        const registry = makeRegistry('pkg', pkgWithHandover({
            priorCount: 20,
            oldOwner: 'alice',
            newOwner: 'eve',
            gapDays: 60
        }));

        const scanner = new MaintainerScanner(registry, {quickHandoverDays: 90});
        const finding = await scanner.scan('pkg', '1.0.20');

        expect(finding!.severity).toBe(MaintainerSeverity.risk);
    });

    it('treats a known publisher as INFO', async() => {
        const registry = makeRegistry('pkg', pkgWithHandover({
            priorCount: 15,
            oldOwner: 'alice',
            newOwner: 'alice',
            gapDays: 200
        }));

        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', '1.0.15');

        expect(finding!.severity).toBe(MaintainerSeverity.info);
        expect(finding!.trustedPublishers).toContain('alice');
    });

    it('returns INFO with a sentinel reason when there is no prior history', async() => {
        const registry = makeRegistry('pkg', {
            name: 'pkg',
            latest: '1.0.0',
            versions: ['1.0.0'],
            publishers: {'1.0.0': {name: 'alice'}},
            time: {'1.0.0': '2022-01-01T00:00:00Z'}
        });

        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', '1.0.0');

        expect(finding!.severity).toBe(MaintainerSeverity.info);
        expect(finding!.priorVersionsWithPublisher).toBe(0);
    });

    it('returns null for git installs', async() => {
        const registry = makeRegistry('pkg', {
            name: 'pkg',
            latest: null,
            versions: []
        });

        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', 'git+https://github.com/foo/bar.git');

        expect(finding).toBeNull();
    });

    it('returns null when the registry has no record at all', async() => {
        const dir = `/tmp/nppm-maint-${  Math.random().toString(36).slice(2)}`;
        const cache = new JsonCache(dir, 60);
        // Mock fetch to 404 — Registry.fetchOne should return null.
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async() => ({
            ok: false,
            status: 404,
            statusText: 'Not Found'
        } as unknown as Response)) as typeof fetch;

        try {
            const registry = new Registry('http://unused', cache);
            const scanner = new MaintainerScanner(registry);
            const finding = await scanner.scan('ghost', '1.0.0');
            expect(finding).toBeNull();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('attaches the publisher 2FA flag + account-created date when a fetcher is wired', async() => {
        const registry = makeRegistry('pkg', pkgWithHandover({
            priorCount: 20,
            oldOwner: 'alice',
            newOwner: 'eve',
            gapDays: 3
        }));

        const dir = `/tmp/nppm-user-${  Math.random().toString(36).slice(2)}`;
        const userCache = new JsonCache(dir, 60);
        /*
         * Stub fetch to report 2FA off + a known account-creation
         * timestamp for the new publisher.
         */
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async(input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            const isEve = url.includes('eve');
            return {
                ok: true, status: 200, statusText: 'OK',
                json: async() => ({
                    tfa: !isEve,
                    created: isEve ? '2026-05-30T00:00:00Z' : '2018-01-01T00:00:00Z'
                })
            } as unknown as Response;
        }) as typeof fetch;

        try {
            const fetcher = new NpmUserFetcher('http://unused', userCache);
            const scanner = new MaintainerScanner(registry, {}, fetcher);
            const finding = await scanner.scan('pkg', '1.0.20');

            expect(finding!.currentPublisher2FA).toBe(false);
            expect(finding!.currentPublisherCreatedAt).toBe('2026-05-30T00:00:00Z');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('leaves the 2FA flag as `null` when no fetcher is provided', async() => {
        const registry = makeRegistry('pkg', pkgWithHandover({
            priorCount: 20, oldOwner: 'alice', newOwner: 'alice', gapDays: 30
        }));
        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', '1.0.20');
        expect(finding!.currentPublisher2FA ?? null).toBeNull();
    });

    it('treats a missing _npmUser field as INFO (pre-2014 packages)', async() => {
        const registry = makeRegistry('pkg', {
            name: 'pkg',
            latest: '1.0.5',
            versions: ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5'],
            publishers: {
                '1.0.0': {name: 'alice'},
                '1.0.1': {name: 'alice'},
                '1.0.2': {name: 'alice'},
                '1.0.3': {name: 'alice'},
                '1.0.4': {name: 'alice'}
                // '1.0.5' deliberately omitted — old release w/o _npmUser
            }
        });

        const scanner = new MaintainerScanner(registry);
        const finding = await scanner.scan('pkg', '1.0.5');

        expect(finding!.severity).toBe(MaintainerSeverity.info);
        expect(finding!.currentPublisher).toBeNull();
    });
});