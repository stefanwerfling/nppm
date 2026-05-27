import zlib from 'zlib';
import {describe, expect, it} from 'vitest';
import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {JsonCache} from '../Cache/JsonCache.js';
import {Registry, RegistryPackage} from '../Registry/Registry.js';
import {ChurnScanner, ChurnSeverity, findPreviousVersion} from '../Security/ChurnScanner.js';

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

function tgzWithFiles(files: {name: string; content: string}[]): Buffer {
    const parts: Buffer[] = [];
    for (const f of files) {
        const body = Buffer.from(f.content, 'utf8');
        const padded = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
        body.copy(padded);
        parts.push(tarHeader(`package/${f.name}`, body.length));
        parts.push(padded);
    }
    parts.push(Buffer.alloc(BLOCK));
    return zlib.gzipSync(Buffer.concat(parts));
}

/**
 * Build a Registry instance backed by a static `RegistryPackage`
 * stand-in — bypasses the fetch path entirely. We poke the cache
 * directly so `fetchOne` reads from it as a cache hit.
 */
function makeRegistry(name: string, pkg: RegistryPackage, dir: string): Registry {
    const cache = new JsonCache(dir, 60);
    cache.set(name, pkg);
    return new Registry('http://unused', cache);
}

describe('findPreviousVersion', () => {
    it('picks the highest stable below target', () => {
        expect(findPreviousVersion(['1.0.0', '1.1.0', '1.2.0', '2.0.0'], '2.0.0')).toBe('1.2.0');
        expect(findPreviousVersion(['1.0.0', '1.0.1', '1.0.2'], '1.0.2')).toBe('1.0.1');
    });

    it('ignores pre-release versions', () => {
        expect(findPreviousVersion(['1.0.0', '2.0.0-rc.1', '2.0.0'], '2.0.0')).toBe('1.0.0');
    });

    it('returns null when nothing qualifies', () => {
        expect(findPreviousVersion(['1.0.0'], '1.0.0')).toBeNull();
        expect(findPreviousVersion([], '1.0.0')).toBeNull();
        expect(findPreviousVersion(['1.0.0'], 'not-semver')).toBeNull();
    });
});

describe('ChurnScanner.scan', () => {
    const FRESH_DIR = (() => {
        const path = '/tmp/nppm-churn-' + Math.random().toString(36).slice(2);
        return path;
    });

    function setup(versions: string[], tarballs: Record<string, Buffer>) {
        const regCacheDir = FRESH_DIR();
        const registry = makeRegistry('pkg', {
            name: 'pkg',
            latest: versions[versions.length - 1],
            versions
        }, regCacheDir);

        const builder = new FingerprintBuilder(null, async (n, v) =>
            tarballs[`${n}@${v}`] ?? null
        );

        return new ChurnScanner(registry, builder);
    }

    it('flags a patch bump with too many file changes as warn', async () => {
        // 1.0.0 → 1.0.1 with 15 modified files (>10 = warn).
        const v1Files = Array.from({length: 15}, (_, i) => ({
            name: `f${i}.js`,
            content: `orig ${i}`
        }));
        const v2Files = Array.from({length: 15}, (_, i) => ({
            name: `f${i}.js`,
            content: `changed ${i}`
        }));

        const scanner = setup(['1.0.0', '1.0.1'], {
            'pkg@1.0.0': tgzWithFiles(v1Files),
            'pkg@1.0.1': tgzWithFiles(v2Files)
        });

        const finding = await scanner.scan('pkg', '1.0.1');
        expect(finding).not.toBeNull();
        expect(finding!.bumpType).toBe('patch');
        expect(finding!.previousVersion).toBe('1.0.0');
        expect(finding!.modified).toBe(15);
        expect(finding!.severity).toBe(ChurnSeverity.warn);
    });

    it('escalates a huge patch diff to risk', async () => {
        const v1 = Array.from({length: 40}, (_, i) => ({name: `f${i}.js`, content: `a${i}`}));
        const v2 = Array.from({length: 40}, (_, i) => ({name: `f${i}.js`, content: `b${i}`}));

        const scanner = setup(['1.0.0', '1.0.1'], {
            'pkg@1.0.0': tgzWithFiles(v1),
            'pkg@1.0.1': tgzWithFiles(v2)
        });

        const finding = await scanner.scan('pkg', '1.0.1');
        expect(finding!.severity).toBe(ChurnSeverity.risk);
    });

    it('treats a small patch bump as info', async () => {
        const scanner = setup(['1.0.0', '1.0.1'], {
            'pkg@1.0.0': tgzWithFiles([{name: 'a.js', content: 'x'}]),
            'pkg@1.0.1': tgzWithFiles([{name: 'a.js', content: 'y'}])
        });

        const finding = await scanner.scan('pkg', '1.0.1');
        expect(finding!.severity).toBe(ChurnSeverity.info);
        expect(finding!.bumpType).toBe('patch');
    });

    it('does not flag a major bump regardless of size', async () => {
        const v1 = Array.from({length: 200}, (_, i) => ({name: `f${i}.js`, content: `a${i}`}));
        const v2 = Array.from({length: 200}, (_, i) => ({name: `f${i}.js`, content: `b${i}`}));

        const scanner = setup(['1.0.0', '2.0.0'], {
            'pkg@1.0.0': tgzWithFiles(v1),
            'pkg@2.0.0': tgzWithFiles(v2)
        });

        const finding = await scanner.scan('pkg', '2.0.0');
        expect(finding!.bumpType).toBe('major');
        expect(finding!.severity).toBe(ChurnSeverity.info);
    });

    it('returns null when there is no previous stable version', async () => {
        const scanner = setup(['1.0.0'], {
            'pkg@1.0.0': tgzWithFiles([{name: 'a.js', content: 'x'}])
        });

        const finding = await scanner.scan('pkg', '1.0.0');
        expect(finding).toBeNull();
    });
});