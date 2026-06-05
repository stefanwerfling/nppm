import zlib from 'zlib';
import {describe, expect, it} from 'vitest';
import {TarballParser} from '../backend/Fingerprint/TarballParser.js';

const BLOCK = 512;

/**
 * Build a tar header for one regular file. Checksum is computed per
 * spec so the buffer would round-trip through `tar -x`; the parser
 * under test does not verify it, but a real-tarball-shaped fixture
 * keeps the test honest.
 */
function tarHeader(name: string, size: number, prefix = ''): Buffer {
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644 ', 100, 8, 'ascii');
    header.write('0000000 ', 108, 8, 'ascii');
    header.write('0000000 ', 116, 8, 'ascii');
    header.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
    header.write('00000000000 ', 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces)
    header.write('0', 156, 1, 'ascii');
    header.write('ustar', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    if (prefix) {
        header.write(prefix, 345, 155, 'utf8');
    }

    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
        sum += header[i];
    }
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

    return header;
}

function tarBody(content: Buffer): Buffer {
    const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
    content.copy(padded, 0);
    return padded;
}

function buildTarball(files: {name: string; content: string}[]): Buffer {
    const parts: Buffer[] = [];

    for (const f of files) {
        const body = Buffer.from(f.content, 'utf8');
        parts.push(tarHeader(f.name, body.length));
        parts.push(tarBody(body));
    }

    parts.push(Buffer.alloc(BLOCK)); // end-of-archive zero block
    return zlib.gzipSync(Buffer.concat(parts));
}

describe('TarballParser', () => {
    it('extracts regular files and strips the package/ prefix', () => {
        const tgz = buildTarball([
            {name: 'package/package.json', content: '{"name":"foo"}'},
            {name: 'package/index.js', content: 'console.log(1)'}
        ]);

        const entries = TarballParser.parse(tgz);

        expect(entries).toHaveLength(2);
        expect(entries[0].path).toBe('package.json');
        expect(entries[0].content.toString('utf8')).toBe('{"name":"foo"}');
        expect(entries[1].path).toBe('index.js');
    });

    it('handles files larger than one block', () => {
        const big = 'x'.repeat(BLOCK + 17);
        const tgz = buildTarball([{name: 'package/big.txt', content: big}]);

        const entries = TarballParser.parse(tgz);
        expect(entries).toHaveLength(1);
        expect(entries[0].content.length).toBe(BLOCK + 17);
        expect(entries[0].content.toString('utf8')).toBe(big);
    });

    it('keeps paths without the package/ prefix intact', () => {
        // Some legacy npm-incompatible tarballs put files at the root.
        // The fingerprint should still see *something* — don't drop them.
        const header = tarHeader('README.md', 5);
        const body = tarBody(Buffer.from('hello', 'utf8'));
        const end = Buffer.alloc(BLOCK);
        const tgz = zlib.gzipSync(Buffer.concat([header, body, end]));

        const entries = TarballParser.parse(tgz);
        expect(entries).toHaveLength(1);
        expect(entries[0].path).toBe('README.md');
    });

    it('strips a non-package/ common prefix (e.g. @types/* tarballs)', () => {
        // @types/cookie-parser publishes its tarball under
        // `cookie-parser/` rather than `package/`. The parser should
        // notice that every entry shares the same top-level dir and
        // strip it.
        const tgz = buildTarball([
            {name: 'cookie-parser/package.json', content: '{"name":"@types/cookie-parser"}'},
            {name: 'cookie-parser/index.d.ts', content: 'declare module "cookie-parser";'}
        ]);

        const entries = TarballParser.parse(tgz);
        expect(entries.map((e) => e.path)).toEqual(['package.json', 'index.d.ts']);
    });

    it('does not strip when entries have multiple top-level dirs', () => {
        const tgz = buildTarball([
            {name: 'package/index.js', content: 'a'},
            {name: 'docs/readme.md', content: 'b'}
        ]);

        const entries = TarballParser.parse(tgz);
        // Without a single common dir we keep the raw paths so caller can
        // still find `package/index.js` etc.
        expect(entries.map((e) => e.path)).toEqual(['package/index.js', 'docs/readme.md']);
    });
});