import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';

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

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

describe('FingerprintBuilder', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-fp-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('hashes each tarball file with sha256 and sorts by path', async () => {
        const tgz = buildTgz([
            {name: 'package/index.js', content: 'console.log(1)'},
            {name: 'package/package.json', content: '{"name":"x"}'}
        ]);

        const builder = new FingerprintBuilder(null, async () => tgz);
        const fp = await builder.build('x', '1.0.0');

        expect(fp).not.toBeNull();
        expect(fp!.name).toBe('x');
        expect(fp!.version).toBe('1.0.0');
        expect(fp!.files.map((f) => f.path)).toEqual(['index.js', 'package.json']);
        expect(fp!.files[0].sha256).toBe(sha256('console.log(1)'));
        expect(fp!.files[1].sha256).toBe(sha256('{"name":"x"}'));
        expect(fp!.files[0].size).toBe('console.log(1)'.length);
    });

    it('returns null for a 404 tarball', async () => {
        const builder = new FingerprintBuilder(null, async () => null);
        expect(await builder.build('missing', '0.0.1')).toBeNull();
    });

    it('caches successful fingerprints (no second fetch)', async () => {
        const tgz = buildTgz([{name: 'package/a.js', content: 'a'}]);
        let calls = 0;
        const cache = new JsonCache(dir, 60, {permanent: true});
        const builder = new FingerprintBuilder(cache, async () => {
            calls++;
            return tgz;
        });

        const first = await builder.build('a', '1.0.0');
        const second = await builder.build('a', '1.0.0');

        expect(calls).toBe(1);
        expect(second).toEqual(first);
    });

    it('extracts deps and scripts from the tarball package.json', async () => {
        const tgz = buildTgz([
            {
                name: 'package/package.json',
                content: JSON.stringify({
                    name: 'foo',
                    version: '1.0.0',
                    dependencies: {bar: '^2.0.0'},
                    devDependencies: {baz: '~3.0.0'},
                    scripts: {postinstall: 'node hack.js'}
                })
            }
        ]);

        const builder = new FingerprintBuilder(null, async () => tgz);
        const fp = await builder.build('foo', '1.0.0');

        expect(fp!.manifest).not.toBeNull();
        expect(fp!.manifest!.dependencies).toEqual({bar: '^2.0.0'});
        expect(fp!.manifest!.devDependencies).toEqual({baz: '~3.0.0'});
        expect(fp!.manifest!.peerDependencies).toEqual({});
        expect(fp!.manifest!.scripts).toEqual({postinstall: 'node hack.js'});
    });

    it('stores content only for small non-binary JS files', async () => {
        const tgz = buildTgz([
            {name: 'package/index.js', content: 'console.log("hi")'},
            {name: 'package/types.d.ts', content: 'export {};'},
            {name: 'package/README.md', content: '# hi'}
        ]);

        const builder = new FingerprintBuilder(null, async () => tgz);
        const fp = await builder.build('foo', '1.0.0');

        const byPath = new Map(fp!.files.map((f) => [f.path, f]));
        expect(byPath.get('index.js')!.content).toBe('console.log("hi")');
        expect(byPath.get('types.d.ts')!.content).toBeUndefined();
        expect(byPath.get('README.md')!.content).toBeUndefined();
    });

    it('skips content for JS files past the size cap', async () => {
        const big = 'x'.repeat(101 * 1024); // 101 KiB > 100 KiB cap
        const tgz = buildTgz([{name: 'package/big.js', content: big}]);

        const builder = new FingerprintBuilder(null, async () => tgz);
        const fp = await builder.build('foo', '1.0.0');

        expect(fp!.files[0].path).toBe('big.js');
        expect(fp!.files[0].size).toBe(101 * 1024);
        expect(fp!.files[0].content).toBeUndefined();
    });

    it('skips content for binary JS-named files', async () => {
        // Some packages ship `.js.gz` (treated as `.gz` by extension)
        // but also occasionally ship binaries that someone mis-named.
        // The NUL-byte sniff keeps them out of the content cache.
        const binary = Buffer.from([0x42, 0x00, 0x42, 0x00, 0x42]);
        const padded = Buffer.alloc(512);
        binary.copy(padded);

        // Hand-roll because buildTgz writes string content; we need bytes.
        const zlib = await import('zlib');
        const headerBytes = ((): Buffer => {
            const h = Buffer.alloc(512);
            h.write('package/odd.js', 0, 100, 'utf8');
            h.write('0000644 ', 100, 8, 'ascii');
            h.write('0000000 ', 108, 8, 'ascii');
            h.write('0000000 ', 116, 8, 'ascii');
            h.write(binary.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
            h.write('00000000000 ', 136, 12, 'ascii');
            h.write('        ', 148, 8, 'ascii');
            h.write('0', 156, 1, 'ascii');
            h.write('ustar', 257, 6, 'ascii');
            h.write('00', 263, 2, 'ascii');
            let sum = 0;
            for (let i = 0; i < 512; i++) {
                sum += h[i];
            }
            h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
            return h;
        })();

        const tgz = zlib.gzipSync(Buffer.concat([headerBytes, padded, Buffer.alloc(512)]));

        const builder = new FingerprintBuilder(null, async () => tgz);
        const fp = await builder.build('foo', '1.0.0');

        expect(fp!.files[0].content).toBeUndefined();
    });

    it('survives a missing or malformed package.json (manifest = null)', async () => {
        const broken = buildTgz([{name: 'package/package.json', content: 'not json'}]);
        const builder = new FingerprintBuilder(null, async () => broken);
        const fp = await builder.build('foo', '1.0.0');

        expect(fp!.manifest).toBeNull();
    });

    it('caches 404s so they do not refetch', async () => {
        let calls = 0;
        const cache = new JsonCache(dir, 60, {permanent: true});
        const builder = new FingerprintBuilder(cache, async () => {
            calls++;
            return null;
        });

        await builder.build('nope', '0.0.1');
        const second = await builder.build('nope', '0.0.1');

        expect(calls).toBe(1);
        expect(second).toBeNull();
    });
});