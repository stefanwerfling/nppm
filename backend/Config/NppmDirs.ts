import fs from 'fs';
import path from 'path';

/**
 * Single source of truth for the four hidden directories nppm writes
 * into a project root. Everything lives under one `.nppm/` parent so a
 * project sees one folder instead of three (`.nppm-cache/`,
 * `.nppm-history/`, `.nppm-backups/`) sprinkled across the root.
 *
 * `migrate()` is idempotent — it walks the three legacy locations and
 * renames each into `.nppm/<bucket>/` exactly when the legacy folder
 * exists AND the new target doesn't (any prior partial migration
 * leaves both alone instead of merging). Already-migrated roots are
 * remembered for the lifetime of the process so subsequent calls are
 * no-ops.
 */
export class NppmDirs {

    private static readonly _BASE = '.nppm';

    /**
     * Per-process set of project roots whose legacy directories have
     * already been migrated (or had nothing to migrate). Avoids hitting
     * the filesystem on every cache/history/backup access.
     */
    private static readonly _migrated = new Set<string>();

    public static base(projectRoot: string): string {
        return path.join(projectRoot, NppmDirs._BASE);
    }

    public static cache(projectRoot: string): string {
        NppmDirs.migrate(projectRoot);
        return path.join(projectRoot, NppmDirs._BASE, 'cache');
    }

    public static history(projectRoot: string): string {
        NppmDirs.migrate(projectRoot);
        return path.join(projectRoot, NppmDirs._BASE, 'history');
    }

    public static backups(projectRoot: string): string {
        NppmDirs.migrate(projectRoot);
        return path.join(projectRoot, NppmDirs._BASE, 'backups');
    }

    /**
     * Move `.nppm-cache/`, `.nppm-history/`, `.nppm-backups/` (if
     * present) under a single `.nppm/<bucket>/` parent. Idempotent and
     * skips any bucket whose new target already exists — manual partial
     * migrations are left untouched rather than half-merged.
     */
    public static migrate(projectRoot: string): void {
        const resolved = path.resolve(projectRoot);
        if (NppmDirs._migrated.has(resolved)) {
            return;
        }
        NppmDirs._migrated.add(resolved);
        const base = path.join(resolved, NppmDirs._BASE);
        const moves: {from: string; to: string}[] = [
            {from: path.join(resolved, '.nppm-cache'), to: path.join(base, 'cache')},
            {from: path.join(resolved, '.nppm-history'), to: path.join(base, 'history')},
            {from: path.join(resolved, '.nppm-backups'), to: path.join(base, 'backups')}
        ];
        for (const m of moves) {
            if (!fs.existsSync(m.from)) {
                continue;
            }
            if (fs.existsSync(m.to)) {
                continue;
            }
            fs.mkdirSync(base, {recursive: true});
            fs.renameSync(m.from, m.to);
        }
    }

    /**
     * Reset the per-process migration memo. Only used by tests — each
     * test runs against a fresh temp dir, but the static memo would
     * still carry the previous-test path and skip the rename if a new
     * test happened to reuse the same absolute path string.
     */
    public static resetForTests(): void {
        NppmDirs._migrated.clear();
    }
}