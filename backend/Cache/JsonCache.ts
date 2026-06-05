import fs from 'fs';
import path from 'path';

/**
 * On-disk entry — `t` is the unix-ms timestamp we wrote `v` at. TTL is
 * checked against `t` on read.
 */
type Entry<T> = {
    t: number;
    v: T;
};

/**
 * Optional behaviour switches for a cache instance. `permanent: true`
 * means TTL is ignored on read — useful for cache pockets that store
 * immutable data (e.g. npm tarball fingerprints, since a published
 * `pkg@version` never changes).
 */
export type JsonCacheOptions = {
    permanent?: boolean;
};

/**
 * One-file-per-key JSON cache. Cache keys are sanitised so package
 * names containing `/` (scoped packages) still resolve to a single
 * file. Stale entries are not auto-deleted — they get overwritten on
 * the next successful fetch.
 */
export class JsonCache {

    private readonly _dir: string;
    private readonly _ttlMs: number;
    private readonly _permanent: boolean;

    constructor(dir: string, ttlMinutes: number, opts: JsonCacheOptions = {}) {
        this._dir = dir;
        this._ttlMs = ttlMinutes * 60 * 1000;
        this._permanent = opts.permanent === true;
        fs.mkdirSync(dir, {recursive: true});
    }

    public get<T>(key: string): T|null {
        const file = this._fileFor(key);

        if (!fs.existsSync(file)) {
            return null;
        }

        try {
            const raw = fs.readFileSync(file, 'utf-8');
            const entry = JSON.parse(raw) as Entry<T>;

            if (!this._permanent && Date.now() - entry.t > this._ttlMs) {
                return null;
            }

            return entry.v;
        } catch {
            // corrupt cache entry — treat as miss, will be overwritten
            return null;
        }
    }

    public set<T>(key: string, value: T): void {
        const file = this._fileFor(key);
        const entry: Entry<T> = {t: Date.now(), v: value};
        fs.writeFileSync(file, JSON.stringify(entry));
    }

    /**
     * Slashes and other characters that would create subdirectories
     * (or collide with reserved names) are replaced with `__`. The
     * resulting filename still encodes the original key so a stale
     * cache directory is human-inspectable.
     */
    private _fileFor(key: string): string {
        const safe = key.replace(/[^a-zA-Z0-9._@-]/g, '__');
        return path.join(this._dir, `${safe}.json`);
    }

}