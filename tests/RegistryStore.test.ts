import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Crc32} from '../backend/Registry/Crc32.js';
import {DiskTarballStore} from '../backend/Registry/DiskTarballStore.js';
import {ZipArchive} from '../backend/Registry/ZipArchive.js';

describe('Crc32', () => {

    it('matches the canonical CRC-32 of "123456789"', () => {
        expect(Crc32.compute(Buffer.from('123456789'))).toBe(0xCBF43926);
    });

    it('is 0 for the empty buffer', () => {
        expect(Crc32.compute(Buffer.alloc(0))).toBe(0);
    });
});

describe('ZipArchive', () => {

    it('round-trips arbitrary binary bytes byte-identically', () => {
        const data = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x42, 0x99, 0x00, 0x7e]);
        const zip = ZipArchive.packSingle('pkg-1.0.0.tgz', data);
        expect(zip.readUInt32LE(0)).toBe(0x04034b50);
        const out = ZipArchive.unpackSingle(zip);
        expect(out).not.toBeNull();
        expect(Buffer.compare(out as Buffer, data)).toBe(0);
    });

    it('returns null for a non-ZIP buffer', () => {
        expect(ZipArchive.unpackSingle(Buffer.from('not a zip'))).toBeNull();
    });

    it('returns null when the payload CRC no longer matches (corruption)', () => {
        const zip = ZipArchive.packSingle('x.tgz', Buffer.from('hello-payload'));
        const bad = Buffer.from(zip);
        const payloadStart = 30 + 'x.tgz'.length;
        bad[payloadStart] = (bad[payloadStart] + 1) % 256;
        expect(ZipArchive.unpackSingle(bad)).toBeNull();
    });
});

describe('DiskTarballStore', () => {

    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-store-'));
    });

    afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true});
    });

    it('writes then reads back the original bytes; layout is <name>/<unscoped>-<version>.zip', async() => {
        const store = new DiskTarballStore(root);
        const tgz = Buffer.from('the-original-tarball-bytes');
        expect(await store.has('lodash', '4.17.21')).toBe(false);
        await store.write('lodash', '4.17.21', tgz);
        expect(await store.has('lodash', '4.17.21')).toBe(true);
        expect(fs.existsSync(path.join(root, 'lodash', 'lodash-4.17.21.zip'))).toBe(true);
        const back = await store.read('lodash', '4.17.21');
        expect(Buffer.compare(back as Buffer, tgz)).toBe(0);
    });

    it('nests scoped names and uses the unscoped filename', async() => {
        const store = new DiskTarballStore(root);
        await store.write('@types/node', '20.11.0', Buffer.from('x'));
        expect(fs.existsSync(path.join(root, '@types', 'node', 'node-20.11.0.zip'))).toBe(true);
        expect(await store.has('@types/node', '20.11.0')).toBe(true);
    });

    it('returns null on a miss', async() => {
        const store = new DiskTarballStore(root);
        expect(await store.read('missing', '1.0.0')).toBeNull();
    });

    it('refuses a path that escapes the store root', async() => {
        const store = new DiskTarballStore(root);
        await expect(store.write('../../etc/evil', '1.0.0', Buffer.from('x'))).rejects.toThrow(/escapes/u);
    });

    it('reads back null when the on-disk archive is corrupt', async() => {
        const store = new DiskTarballStore(root);
        await store.write('lodash', '4.17.21', Buffer.from('original'));
        fs.writeFileSync(path.join(root, 'lodash', 'lodash-4.17.21.zip'), Buffer.from('garbage, not a zip'));
        expect(await store.has('lodash', '4.17.21')).toBe(true);
        expect(await store.read('lodash', '4.17.21')).toBeNull();
    });
});