import fs from 'fs';
import path from 'path';
import {SafePath} from '../Project/SafePath.js';
import {RegistryProxy, TarballStore} from './RegistryProxy.js';
import {ZipArchive} from './ZipArchive.js';

/**
 * On-disk tarball mirror under `.nppm/register/` (step 18.3). Layout
 * follows the user's spec — the package name is the folder, the version
 * is in the archive filename:
 *
 *   .nppm/register/lodash/lodash-4.17.21.zip
 *   .nppm/register/@types/node/node-20.11.0.zip   (scoped → nested dir,
 *                                                   unscoped filename)
 *
 * The original `.tgz` is stored (not deflated) inside the `.zip`, so the
 * bytes handed back by `read()` are byte-identical to what npm's SRI
 * integrity was computed against (see step 18.4).
 *
 * Every path is built through `SafePath.join`, so a crafted package
 * name arriving over HTTP (`..%2f..%2fetc`) throws instead of escaping
 * the store root. Writes are atomic (temp file + rename).
 */
export class DiskTarballStore implements TarballStore {

    private readonly _root: string;

    public constructor(storeDir: string) {
        this._root = storeDir;
    }

    public async has(name: string, version: string): Promise<boolean> {
        try {
            return fs.existsSync(this._fileFor(name, version));
        } catch {
            return false;
        }
    }

    public async read(name: string, version: string): Promise<Buffer|null> {
        try {
            const file = this._fileFor(name, version);
            if (!fs.existsSync(file)) {
                return null;
            }
            return ZipArchive.unpackSingle(fs.readFileSync(file));
        } catch {
            return null;
        }
    }

    public async write(name: string, version: string, tarball: Buffer): Promise<void> {
        const file = this._fileFor(name, version);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        const zip = ZipArchive.packSingle(DiskTarballStore._entryName(name, version), tarball);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, zip);
        fs.renameSync(tmp, file);
    }

    /**
     * Every mirrored archive, reconstructed from the on-disk layout.
     * The package name is the directory path relative to the store root
     * (so a scoped `@scope/pkg` nested dir round-trips), the version is
     * the archive filename minus the `<unscoped>-` prefix and `.zip`
     * suffix. `bytes` is the on-disk `.zip` size. Missing store dir →
     * empty list.
     */
    public async list(): Promise<{name: string; version: string; bytes: number; mtime: number;}[]> {
        if (!fs.existsSync(this._root)) {
            return [];
        }
        const out: {name: string; version: string; bytes: number; mtime: number;}[] = [];
        this._walk(this._root, out);
        return out;
    }

    /**
     * Wipe the entire mirror. Returns how many archives were removed so
     * the caller can report it. The directory is recreated lazily on
     * the next `write()`.
     */
    public async clear(): Promise<number> {
        if (!fs.existsSync(this._root)) {
            return 0;
        }
        const removed = (await this.list()).length;
        fs.rmSync(this._root, {recursive: true, force: true});
        return removed;
    }

    private _walk(dir: string, out: {name: string; version: string; bytes: number; mtime: number;}[]): void {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._walk(full, out);
                continue;
            }
            if (!entry.name.endsWith('.zip')) {
                continue;
            }
            const name = path.relative(this._root, dir).split(path.sep).join('/');
            const unscoped = RegistryProxy.unscopedName(name);
            const version = entry.name.slice(unscoped.length + 1, -'.zip'.length);
            if (version.length === 0) {
                continue;
            }
            const st = fs.statSync(full);
            out.push({name: name, version: version, bytes: st.size, mtime: st.mtimeMs});
        }
    }

    /**
     * Absolute `.zip` path for one coordinate, containment-checked
     * against the store root. `name` may contain a scope slash, which
     * `SafePath.join` resolves into a nested directory.
     */
    private _fileFor(name: string, version: string): string {
        const unscoped = RegistryProxy.unscopedName(name);
        return SafePath.join(this._root, name, `${unscoped}-${version}.zip`);
    }

    /** Original tarball filename stored as the single ZIP entry. */
    private static _entryName(name: string, version: string): string {
        return `${RegistryProxy.unscopedName(name)}-${version}.tgz`;
    }

}