import zlib from 'zlib';

/**
 * One entry yielded from {@link parseTarball}. Tarball metadata
 * (mode, mtime, owner) is intentionally discarded — the fingerprint
 * only cares about path + content.
 */
export type TarEntry = {
    path: string;
    content: Buffer;
};

const BLOCK = 512;

/**
 * Parse the null-terminated octal field used for `size`. Some writers
 * pad with spaces or NULs; some terminate with a space; some leave
 * trailing garbage. We strip trailing whitespace and NULs and then
 * parse as base-8. Empty/invalid fields return 0.
 */
function readOctal(buf: Buffer, offset: number, length: number): number {
    let end = offset + length;

    while (end > offset) {
        const c = buf[end - 1];
        if (c === 0 || c === 0x20) {
            end--;
            continue;
        }
        break;
    }

    if (end === offset) {
        return 0;
    }

    const str = buf.toString('ascii', offset, end).trim();

    if (str.length === 0) {
        return 0;
    }

    const n = parseInt(str, 8);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Read a null-terminated ASCII field. Tar pads with NULs; everything
 * from the first NUL onwards is ignored.
 */
function readString(buf: Buffer, offset: number, length: number): string {
    let end = offset;
    const max = offset + length;

    while (end < max && buf[end] !== 0) {
        end++;
    }

    return buf.toString('utf8', offset, end);
}

/**
 * Walk a gunzipped tar buffer and yield each regular file. Non-file
 * entries (directories, symlinks, PAX/GNU extensions) are skipped —
 * npm tarballs in practice contain only regular files plus the
 * occasional directory entry, so this is sufficient.
 *
 * Two consecutive zero blocks terminate the archive (per the tar
 * spec); we stop walking when we see one zero block, since trailing
 * garbage past the first zero header is not meaningful.
 */
function walkTar(tar: Buffer): TarEntry[] {
    const entries: TarEntry[] = [];
    let offset = 0;

    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);

        // Zero block = end of archive.
        if (header[0] === 0) {
            break;
        }

        const name = readString(header, 0, 100);
        const size = readOctal(header, 124, 12);
        const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
        const prefix = readString(header, 345, 155);

        const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;

        offset += BLOCK;

        // Regular file: typeflag '0' or '\0' (legacy).
        if (typeflag === '0') {
            const content = tar.subarray(offset, offset + size);
            entries.push({path: fullName, content: Buffer.from(content)});
        }

        // Skip the content (rounded up to the next 512-byte block) for
        // *every* entry type, file or not.
        offset += Math.ceil(size / BLOCK) * BLOCK;
    }

    return entries;
}

/**
 * If every entry shares a single top-level directory (`package/`,
 * `cookie-parser/`, …) strip that prefix. npm convention is `package/`,
 * but `@types/*` tarballs use the un-scoped name (`@types/cookie-parser`
 * → `cookie-parser/`), and other publishers vary. Dynamic detection
 * means downstream code can rely on `package.json` living at the
 * fingerprint's path root regardless of how the tarball was packed.
 */
function stripCommonPrefix(entries: TarEntry[]): TarEntry[] {
    if (entries.length === 0) {
        return entries;
    }

    const firstSegments = new Set<string>();

    for (const e of entries) {
        const slash = e.path.indexOf('/');
        if (slash < 0) {
            return entries; // at least one file sits at the root → don't strip
        }
        firstSegments.add(e.path.slice(0, slash));
        if (firstSegments.size > 1) {
            return entries; // multiple top-level dirs → don't strip
        }
    }

    const prefix = `${firstSegments.values().next().value}/`;
    return entries.map((e) => ({
        path: e.path.slice(prefix.length),
        content: e.content
    }));
}

/**
 * Gunzip an npm tarball (`.tgz`) and return its regular file entries.
 * The single top-level directory npm wraps tarballs in is stripped, so
 * callers see `package.json`, not `package/package.json` or
 * `cookie-parser/package.json`.
 *
 * No external `tar` dependency: zlib is built-in and the tar format
 * for npm's well-behaved tarballs is ~80 lines of bookkeeping.
 */
export function parseTarball(tgz: Buffer): TarEntry[] {
    const tar = zlib.gunzipSync(tgz);
    return stripCommonPrefix(walkTar(tar));
}