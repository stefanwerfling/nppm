/* eslint-disable no-bitwise -- CRC-32 is defined in terms of bit ops; there is no non-bitwise formulation. */

/**
 * Standard CRC-32 (polynomial 0xEDB88320) needed by the ZIP local- and
 * central-directory headers. Hand-rolled to keep the registry store
 * dependency-free — same stance as the hand-rolled tar walk in
 * `TarballParser`. The 256-entry lookup table is built once and memoised
 * for the process lifetime.
 */
export class Crc32 {

    private static _table: Uint32Array|null = null;

    private static _buildTable(): Uint32Array {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            }
            table[n] = c >>> 0;
        }
        return table;
    }

    /**
     * CRC-32 checksum of `buf` as an unsigned 32-bit integer.
     */
    public static compute(buf: Buffer): number {
        if (!Crc32._table) {
            Crc32._table = Crc32._buildTable();
        }
        const table = Crc32._table;
        let crc = 0xFFFFFFFF;
        for (const byte of buf) {
            crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xFF];
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

}