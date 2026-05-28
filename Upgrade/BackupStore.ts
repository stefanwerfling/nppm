import fs from 'fs';
import path from 'path';

/**
 * Stamp for a single backup snapshot. `dir` is the timestamped folder
 * under `.nppm-backups/`; `files` are the relative paths we copied.
 * The caller logs/streams this back to the UI so the user can find
 * the snapshot quickly if they want to roll back manually.
 */
export type BackupStamp = {
    dir: string;
    files: string[];
};

/**
 * Per-project backup pocket. One folder per `save()` call so two
 * upgrades in sequence don't overwrite each other. Stored *next to*
 * `nppm.json` (not under `.nppm-cache/`) so the user can keep them
 * out of band of the cache lifecycle and commit them if they want.
 *
 * Naming: `.nppm-backups/<isoTimestamp>/<relative-path>`.
 */
export class BackupStore {

    private readonly _root: string;

    constructor(root: string) {
        this._root = root;
        fs.mkdirSync(root, {recursive: true});
    }

    /**
     * Snapshot a list of absolute file paths into a fresh timestamped
     * directory. `baseDir` is the project root — relative paths inside
     * `baseDir` are preserved so a workspace at `apps/api/package.json`
     * lands under `.nppm-backups/<ts>/apps/api/package.json`.
     */
    public save(baseDir: string, absPaths: string[]): BackupStamp {
        const stamp = BackupStore._timestamp();
        const dir = path.join(this._root, stamp);
        fs.mkdirSync(dir, {recursive: true});

        const files: string[] = [];
        for (const abs of absPaths) {
            if (!fs.existsSync(abs)) {
                continue;
            }
            const rel = path.relative(baseDir, abs);
            // path.relative may yield `../...` if the file is outside
            // baseDir; skip those to avoid escaping the backup pocket.
            if (rel.startsWith('..')) {
                continue;
            }
            const target = path.join(dir, rel);
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.copyFileSync(abs, target);
            files.push(rel);
        }

        return {dir, files};
    }

    /**
     * ISO-shaped timestamp, filesystem-safe. Granular to seconds so
     * two upgrades in the same second collide; in practice this is
     * fine — the UI prevents concurrent applies via the apply lock.
     */
    private static _timestamp(): string {
        const d = new Date();
        const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');
        return (
            `${d.getUTCFullYear()}`
            + `-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
            + `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`
            + `Z`
        );
    }
}