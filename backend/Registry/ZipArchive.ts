import {Crc32} from './Crc32.js';

/**
 * Minimal single-entry ZIP writer/reader used by the registry store
 * (step 18.3). Hand-rolled to avoid adding a zip dependency — mirrors
 * how `TarballParser` hand-walks tar without the `tar` package.
 *
 * The entry is always **stored** (compression method 0), not deflated:
 * the payload is an npm `.tgz`, already gzip-compressed, so re-deflating
 * would waste CPU for no size win. More importantly, storing keeps the
 * original tarball bytes byte-identical inside the archive, so
 * `unpackSingle()` hands back exactly what went in — the invariant npm's
 * SRI integrity check depends on (see step 18.4).
 */
export class ZipArchive {

    private static readonly _SIG_LOCAL = 0x04034b50;
    private static readonly _SIG_CENTRAL = 0x02014b50;
    private static readonly _SIG_EOCD = 0x06054b50;
    private static readonly _VERSION = 20;
    private static readonly _METHOD_STORED = 0;

    /**
     * Wrap `data` as the single stored entry `entryName` in a ZIP
     * container and return the archive bytes.
     */
    public static packSingle(entryName: string, data: Buffer): Buffer {
        const name = Buffer.from(entryName, 'utf8');
        const crc = Crc32.compute(data);
        const size = data.length;

        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(ZipArchive._SIG_LOCAL, 0);
        local.writeUInt16LE(ZipArchive._VERSION, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(ZipArchive._METHOD_STORED, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(size, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        name.copy(local, 30);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(ZipArchive._SIG_CENTRAL, 0);
        central.writeUInt16LE(ZipArchive._VERSION, 4);
        central.writeUInt16LE(ZipArchive._VERSION, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(ZipArchive._METHOD_STORED, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(size, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(0, 42);
        name.copy(central, 46);

        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(ZipArchive._SIG_EOCD, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(1, 8);
        eocd.writeUInt16LE(1, 10);
        eocd.writeUInt32LE(central.length, 12);
        eocd.writeUInt32LE(local.length + size, 16);
        eocd.writeUInt16LE(0, 20);

        return Buffer.concat([local, data, central, eocd]);
    }

    /**
     * Read the first stored entry's payload back out of `zip`. Returns
     * `null` when the buffer isn't a ZIP local header, the entry isn't
     * stored (method 0), the declared size overruns the buffer, or the
     * payload's CRC-32 doesn't match the header. The CRC check makes a
     * store read self-validating: a truncated / bit-rotted / tampered
     * `.zip` reads back as `null` (a miss) so the proxy re-fetches from
     * the upstream instead of serving corrupt bytes that would only fail
     * npm's SRI check downstream (step 18.4 integrity consistency).
     */
    public static unpackSingle(zip: Buffer): Buffer|null {
        if (zip.length < 30 || zip.readUInt32LE(0) !== ZipArchive._SIG_LOCAL) {
            return null;
        }
        if (zip.readUInt16LE(8) !== ZipArchive._METHOD_STORED) {
            return null;
        }
        const expectedCrc = zip.readUInt32LE(14);
        const size = zip.readUInt32LE(18);
        const nameLen = zip.readUInt16LE(26);
        const extraLen = zip.readUInt16LE(28);
        const start = 30 + nameLen + extraLen;
        if (start + size > zip.length) {
            return null;
        }
        const payload = zip.subarray(start, start + size);
        if (Crc32.compute(payload) !== expectedCrc) {
            return null;
        }
        return payload;
    }

}