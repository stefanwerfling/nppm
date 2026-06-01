import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {LockedPackage} from '../Project/Lockfile.js';
import {Registry, RegistryPackage} from '../Registry/Registry.js';
import {
    IntegrityFinding,
    IntegrityFindingKind,
    IntegrityScanner,
    IntegritySeverity
} from '../Security/IntegrityScanner.js';

/**
 * Seed the registry cache with a full `RegistryPackage` envelope so
 * the scanner reads it directly — no network involved. Each test
 * controls what the registry "currently serves" by setting the
 * relevant `dist` block here.
 */
function seedRegistry(cache: JsonCache, pkg: RegistryPackage): void {
    cache.set(pkg.name, pkg);
}

/** Convenience builder for the LockedPackage shape — short and focused. */
function lp(opts: Partial<LockedPackage> & {name: string; version: string}): LockedPackage {
    return {
        name: opts.name,
        version: opts.version,
        path: opts.path ?? `node_modules/${opts.name}`,
        resolved: opts.resolved,
        integrity: opts.integrity,
        dev: opts.dev ?? false,
        optional: opts.optional ?? false,
        peer: opts.peer ?? false,
        deps: opts.deps ?? {},
        peerDeps: opts.peerDeps ?? {},
        optionalDeps: opts.optionalDeps ?? {}
    };
}

describe('IntegrityScanner', () => {
    let dir: string;
    let cache: JsonCache;
    let registry: Registry;
    let scanner: IntegrityScanner;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-int-'));
        cache = new JsonCache(dir, 60);
        // Stub fetch to return null — every miss should already be
        // seeded by the test; this enforces no surprise network.
        registry = new Registry('http://test', cache);
        scanner = new IntegrityScanner(registry);
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns no findings when integrity + tarball match registry', async () => {
        seedRegistry(cache, {
            name: 'lodash',
            latest: '4.17.21',
            versions: ['4.17.21'],
            dist: {
                '4.17.21': {
                    tarball: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
                    integrity: 'sha512-clean-hash'
                }
            }
        });

        const findings = await scanner.scan([lp({
            name: 'lodash',
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-clean-hash'
        })]);
        expect(findings).toEqual([]);
    });

    it('flags integrity mismatch as risk', async () => {
        seedRegistry(cache, {
            name: 'evil',
            latest: '1.0.0',
            versions: ['1.0.0'],
            dist: {
                '1.0.0': {
                    tarball: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
                    integrity: 'sha512-CURRENT-hash'
                }
            }
        });

        const findings = await scanner.scan([lp({
            name: 'evil',
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
            integrity: 'sha512-OLD-hash-from-lockfile'
        })]);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            name: 'evil',
            version: '1.0.0',
            kind: IntegrityFindingKind.integrityMismatch,
            severity: IntegritySeverity.risk,
            lockfileIntegrity: 'sha512-OLD-hash-from-lockfile',
            registryIntegrity: 'sha512-CURRENT-hash'
        });
    });

    it('flags tarball redirect as info when integrity still matches', async () => {
        seedRegistry(cache, {
            name: 'mirrored',
            latest: '2.0.0',
            versions: ['2.0.0'],
            dist: {
                '2.0.0': {
                    tarball: 'https://registry.npmjs.org/mirrored/-/mirrored-2.0.0.tgz',
                    integrity: 'sha512-matching-hash'
                }
            }
        });

        const findings = await scanner.scan([lp({
            name: 'mirrored',
            version: '2.0.0',
            resolved: 'https://mirror.internal/repo/mirrored-2.0.0.tgz',
            integrity: 'sha512-matching-hash'
        })]);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            name: 'mirrored',
            kind: IntegrityFindingKind.tarballRedirect,
            severity: IntegritySeverity.info
        });
    });

    it('flags missing integrity in the lockfile as info', async () => {
        seedRegistry(cache, {
            name: 'old',
            latest: '0.1.0',
            versions: ['0.1.0'],
            dist: {
                '0.1.0': {
                    tarball: 'https://registry.npmjs.org/old/-/old-0.1.0.tgz',
                    integrity: 'sha1-legacy-hash'
                }
            }
        });

        const findings = await scanner.scan([lp({
            name: 'old',
            version: '0.1.0',
            resolved: 'https://registry.npmjs.org/old/-/old-0.1.0.tgz'
            // no integrity field
        })]);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            name: 'old',
            kind: IntegrityFindingKind.integrityMissing,
            severity: IntegritySeverity.info,
            registryIntegrity: 'sha1-legacy-hash'
        });
    });

    it('flags private packages (registry returns null) as info', async () => {
        // No seeding — `registry.fetchOne('private-pkg')` will try
        // the network, get a non-2xx (stubbed via no fetcher), and
        // return null.
        // Override the global fetch for this test to simulate 404.
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(null, {status: 404});
        try {
            const findings = await scanner.scan([lp({
                name: 'private-pkg',
                version: '1.0.0',
                resolved: 'https://internal.registry/private-pkg.tgz',
                integrity: 'sha512-internal'
            })]);
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                name: 'private-pkg',
                kind: IntegrityFindingKind.versionNotInRegistry,
                severity: IntegritySeverity.info
            });
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('produces no finding when registry knows the package but not the version (cold dist cache)', async () => {
        // Older cache entry without `dist` — defer judgment.
        seedRegistry(cache, {
            name: 'oldcache',
            latest: '1.0.0',
            versions: ['1.0.0']
            // no dist block
        });
        const findings = await scanner.scan([lp({
            name: 'oldcache',
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/oldcache/-/oldcache-1.0.0.tgz',
            integrity: 'sha512-something'
        })]);
        expect(findings).toEqual([]);
    });

    it('dedupes nested installs to one finding per name@version', async () => {
        seedRegistry(cache, {
            name: 'evil',
            latest: '1.0.0',
            versions: ['1.0.0'],
            dist: {
                '1.0.0': {
                    tarball: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
                    integrity: 'sha512-bad'
                }
            }
        });

        const findings = await scanner.scan([
            lp({name: 'evil', version: '1.0.0', integrity: 'sha512-good',
                resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz'}),
            // Same name@version, different path — nested install
            lp({name: 'evil', version: '1.0.0',
                path: 'node_modules/wrapper/node_modules/evil',
                integrity: 'sha512-good',
                resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz'})
        ]);
        expect(findings).toHaveLength(1);
    });

    it('skips git-installed packages (no registry anchor)', async () => {
        const findings = await scanner.scan([lp({
            name: 'vts',
            version: 'git+https://github.com/OpenSourcePKG/vts.git',
            resolved: 'git+https://github.com/OpenSourcePKG/vts.git',
            integrity: undefined
        })]);
        expect(findings).toEqual([]);
    });

    it('summarize rolls up severity counts and picks the max', async () => {
        seedRegistry(cache, {
            name: 'pkg-r', latest: '1.0.0', versions: ['1.0.0'],
            dist: {'1.0.0': {tarball: 'https://r/p.tgz', integrity: 'sha512-a'}}
        });
        seedRegistry(cache, {
            name: 'pkg-i', latest: '1.0.0', versions: ['1.0.0'],
            dist: {'1.0.0': {tarball: 'https://r/i.tgz', integrity: 'sha512-i'}}
        });

        const findings = await scanner.scan([
            lp({name: 'pkg-r', version: '1.0.0',
                resolved: 'https://r/p.tgz', integrity: 'sha512-different'}),  // risk
            lp({name: 'pkg-i', version: '1.0.0',
                resolved: 'https://mirror/i.tgz', integrity: 'sha512-i'})       // info
        ]);

        const summary = IntegrityScanner.summarize(findings, 2);
        expect(summary).toEqual({
            maxSeverity: IntegritySeverity.risk,
            riskCount: 1,
            warnCount: 0,
            infoCount: 1,
            totalScanned: 2
        });
    });

    it('summarize returns maxSeverity null when no findings', () => {
        const summary = IntegrityScanner.summarize([], 5);
        expect(summary.maxSeverity).toBeNull();
        expect(summary.totalScanned).toBe(5);
    });

    it('aggregateByName collapses cross-project findings to per-name max severity', () => {
        const findings: IntegrityFinding[] = [
            // pkg-a: two projects reporting different severities for two versions
            {
                name: 'pkg-a', version: '1.0.0',
                kind: IntegrityFindingKind.tarballRedirect,
                severity: IntegritySeverity.info, message: ''
            },
            {
                name: 'pkg-a', version: '2.0.0',
                kind: IntegrityFindingKind.integrityMismatch,
                severity: IntegritySeverity.risk, message: ''
            },
            // pkg-b: only risk
            {
                name: 'pkg-b', version: '1.0.0',
                kind: IntegrityFindingKind.integrityMismatch,
                severity: IntegritySeverity.risk, message: ''
            },
            // pkg-c: only info
            {
                name: 'pkg-c', version: '1.0.0',
                kind: IntegrityFindingKind.versionNotInRegistry,
                severity: IntegritySeverity.info, message: ''
            }
        ];

        const out = IntegrityScanner.aggregateByName(findings);
        expect(out.get('pkg-a')).toEqual({severity: IntegritySeverity.risk, riskCount: 1});
        expect(out.get('pkg-b')).toEqual({severity: IntegritySeverity.risk, riskCount: 1});
        expect(out.get('pkg-c')).toEqual({severity: IntegritySeverity.info, riskCount: 0});
    });
});