import fs from 'fs';
import os from 'os';
import path from 'path';
import {ApiFsBrowseEntry, ApiFsBrowseResponse} from '../../shared/Api/ApiTypes.js';
import {ServerContext} from './ServerContext.js';

/**
 * Backend-driven filesystem picker for the `DirectoryPickerModal` in
 * the frontend. Absolute-paths-only — the picker navigates a known
 * root and chains relative paths client-side, so opening it to a
 * user-supplied relative path would be ambiguous.
 *
 * Falls back to `os.homedir()` on `ENOENT` so a stale form value
 * (e.g. a previously-saved path that no longer exists) doesn't fail
 * the modal open — the picker just lands somewhere sensible.
 */
export class FsController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/fs/browse', async(req, res): Promise<void> => {
            const requested = typeof req.query.path === 'string' && req.query.path.length > 0
                ? req.query.path
                : process.cwd();
            const showHidden = req.query.showHidden === '1';

            if (!path.isAbsolute(requested)) {
                res.status(400).json({success: false, msg: `path must be absolute, got "${requested}"`});
                return;
            }

            try {
                const response = await FsController._listDirectory(requested, showHidden);
                res.status(200).json(response);
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === 'ENOENT') {
                    /*
                     * Fall back to home directory when the requested
                     * path doesn't exist — most likely a stale value
                     * from the form field.
                     */
                    try {
                        const fallback = await FsController._listDirectory(os.homedir(), showHidden);
                        res.status(200).json(fallback);
                        return;
                    } catch (e2) {
                        res.status(500).json({success: false, msg: (e2 as Error).message});
                        return;
                    }
                }
                res.status(500).json({success: false, msg: err.message});
            }
        });
    }

    private static async _listDirectory(absPath: string, showHidden: boolean): Promise<ApiFsBrowseResponse> {
        const dirents = await fs.promises.readdir(absPath, {withFileTypes: true});
        const entries: ApiFsBrowseEntry[] = [];
        for (const d of dirents) {
            if (!showHidden && d.name.startsWith('.')) {
                continue;
            }
            let kind: 'dir'|'file'|null = null;
            if (d.isDirectory()) {
                kind = 'dir';
            } else if (d.isFile()) {
                kind = 'file';
            } else if (d.isSymbolicLink()) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const stat = await fs.promises.stat(path.join(absPath, d.name));
                    kind = stat.isDirectory() ? 'dir' : 'file';
                } catch {
                    continue;
                }
            }
            if (kind === null) {
                continue;
            }
            entries.push({name: d.name, type: kind});
        }
        entries.sort((a, b): number => {
            if (a.type !== b.type) {
                return a.type === 'dir' ? -1 : 1;
            }
            return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
        });
        const parent = path.dirname(absPath);
        return {
            path: absPath,
            parent: parent === absPath ? null : parent,
            entries: entries
        };
    }
}