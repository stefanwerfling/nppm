import fs from 'fs';
import path from 'path';
import {ApiLifecycleScript} from '../../shared/Api/ApiTypes.js';

/**
 * Install-lifecycle hooks npm runs by default. `prepare` runs on
 * `npm install` for git deps and on `npm pack`/`publish`; we include
 * it so the user can see + re-trigger it after `--ignore-scripts`.
 */
const HOOKS: readonly string[] = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * Walks `node_modules/*` to find every package whose `package.json`
 * declares one of the install lifecycle hooks. Used by the Upgrade
 * modal after `npm install --ignore-scripts` so the user knows what
 * was *not* executed and can re-run any specific package via the
 * "Run" button (`npm rebuild <pkg>`).
 *
 * Walks one level of `node_modules` plus the second-level `@scope/`
 * directories; we don't recurse into nested `node_modules` because
 * `npm rebuild` operates on the top-level installed copy anyway.
 */
export class LifecycleScriptScanner {

    private readonly _projectRoot: string;

    constructor(projectRoot: string) {
        this._projectRoot = projectRoot;
    }

    public scan(): ApiLifecycleScript[] {
        const nm = path.join(this._projectRoot, 'node_modules');
        if (!fs.existsSync(nm)) {
            return [];
        }

        const out: ApiLifecycleScript[] = [];
        for (const entry of LifecycleScriptScanner._safeReaddir(nm)) {
            if (entry === '.bin' || entry === '.package-lock.json' || entry.startsWith('.')) {
                continue;
            }
            const full = path.join(nm, entry);
            if (entry.startsWith('@')) {
                // Scoped namespace — list child packages.
                for (const sub of LifecycleScriptScanner._safeReaddir(full)) {
                    LifecycleScriptScanner._collect(path.join(full, sub), `${entry}/${sub}`, out);
                }
                continue;
            }
            LifecycleScriptScanner._collect(full, entry, out);
        }

        out.sort((a, b) => {
            const n = a.name.localeCompare(b.name);
            return n !== 0 ? n : a.hook.localeCompare(b.hook);
        });
        return out;
    }

    private static _collect(pkgDir: string, name: string, out: ApiLifecycleScript[]): void {
        const manifestPath = path.join(pkgDir, 'package.json');
        if (!fs.existsSync(manifestPath)) {
            return;
        }
        let parsed: {version?: unknown; scripts?: Record<string, unknown>};
        try {
            parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch {
            return;
        }
        const scripts = parsed.scripts;
        if (!scripts || typeof scripts !== 'object') {
            return;
        }
        const version = typeof parsed.version === 'string' ? parsed.version : '';
        for (const hook of HOOKS) {
            const body = scripts[hook];
            if (typeof body === 'string' && body.length > 0) {
                out.push({name, version, hook, script: body});
            }
        }
    }

    private static _safeReaddir(dir: string): string[] {
        try {
            return fs.readdirSync(dir);
        } catch {
            return [];
        }
    }
}