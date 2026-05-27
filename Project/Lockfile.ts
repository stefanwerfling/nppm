/**
 * One resolved dependency as recorded in the lockfile. `path` is the
 * filesystem-style key npm uses (`node_modules/foo`,
 * `node_modules/@scope/bar`, or nested `node_modules/foo/node_modules/baz`);
 * `name` is derived from it.
 *
 * Flags mirror npm's lockfile semantics:
 *  - `dev`: only required for dev-time
 *  - `optional`: optionalDependency; may be missing on the box
 *  - `peer`: declared as a peer requirement
 */
export type LockedPackage = {
    name: string;
    version: string;
    path: string;
    resolved?: string;
    integrity?: string;
    dev: boolean;
    optional: boolean;
    peer: boolean;
    /**
     * Direct deps declared by this package — name → range. Pulled from
     * the `dependencies` / `peerDependencies` / `optionalDependencies`
     * maps in the lockfile entry. Empty record when none declared.
     * Used by the dep-graph view to walk the tree.
     */
    deps: Record<string, string>;
    peerDeps: Record<string, string>;
    optionalDeps: Record<string, string>;
};

/**
 * Where the lockfile data came from. Used by the UI to set
 * expectations on data fidelity:
 *  - `committed`: parsed from the project's checked-in
 *    `package-lock.json` — fully accurate.
 *  - `hidden`: parsed from `node_modules/.package-lock.json`, the
 *    copy npm writes alongside every install. Same shape and same
 *    fidelity as `committed`; just sourced from a different file.
 *  - `synthesized`: walked from `node_modules/*` manifests because
 *    neither lockfile was available. dev/peer/optional flags are
 *    always `false` and nested installs are flattened.
 */
export type LockfileSource = 'committed'|'hidden'|'synthesized';

/**
 * Parsed `package-lock.json`. We capture only the fields downstream
 * code consumes; the rest of npm's metadata (engines, funding, ...)
 * stays on disk.
 */
export type Lockfile = {
    lockfileVersion: number;
    source: LockfileSource;
    packages: LockedPackage[];
};

/**
 * Build a `name → installed-version` map of *top-level* packages.
 * Top-level = exactly one `node_modules/` segment in the path
 * (`node_modules/foo`, `node_modules/@scope/bar`); nested installs
 * (`node_modules/a/node_modules/b`) are skipped so the map matches
 * what a `package.json` declared dep would resolve to. First
 * occurrence wins on conflict.
 *
 * Used by the matrix builders to surface "what version is actually
 * installed" when a project pinned a git URL.
 */
export function topLevelVersionMap(lockfile: Lockfile): Map<string, string> {
    const out = new Map<string, string>();
    for (const pkg of lockfile.packages) {
        const segments = pkg.path.split('/');
        let nmCount = 0;
        for (const s of segments) {
            if (s === 'node_modules') {
                nmCount++;
            }
        }
        if (nmCount !== 1) {
            continue;
        }
        if (!out.has(pkg.name)) {
            out.set(pkg.name, pkg.version);
        }
    }
    return out;
}

/**
 * Pull the package name out of a `packages` key. The last
 * `node_modules/<...>` segment wins (so nested installs resolve to
 * the inner name), and scoped names — which contain a `/` — are
 * preserved.
 *
 *   node_modules/foo                        → foo
 *   node_modules/@scope/bar                 → @scope/bar
 *   node_modules/foo/node_modules/baz       → baz
 *   node_modules/foo/node_modules/@s/bar    → @s/bar
 */
export function packageNameFromPath(path: string): string|null {
    const segments = path.split('/');
    // Find the *last* `node_modules` occurrence — everything after it
    // (one or two segments depending on scope) is the package name.
    let lastNm = -1;
    for (let i = 0; i < segments.length; i++) {
        if (segments[i] === 'node_modules') {
            lastNm = i;
        }
    }

    if (lastNm < 0 || lastNm + 1 >= segments.length) {
        return null;
    }

    const first = segments[lastNm + 1];
    if (first.startsWith('@')) {
        const second = segments[lastNm + 2];
        return second ? `${first}/${second}` : null;
    }
    return first;
}

/**
 * Synthesize a `Lockfile` shape by walking an existing `node_modules`
 * directory. Used as a fallback for projects whose `package-lock.json`
 * is gitignored (a common convention) but who still keep deps installed
 * locally — we want CVE scans to work for those.
 *
 * Limitations vs. a real lockfile:
 *  - `dev` / `optional` / `peer` flags are always `false` (the info is
 *    only in the manifest's deps maps, which we don't cross-reference
 *    here yet)
 *  - nested installs (`node_modules/foo/node_modules/bar`) are *not*
 *    recursed into; only the top level + scoped roots are scanned.
 *    Real lockfiles flatten conflicts to nested installs; node_modules
 *    walks typically don't conflict in modern npm so the omission is
 *    rarely visible.
 *  - The marker `lockfileVersion: 0` lets the UI distinguish synthesized
 *    entries from a real lockfile (which is always v2 or v3).
 *
 * Returns `null` when `node_modules` is missing or unreadable — same
 * contract as `loadLockfile`.
 */
export function scanNodeModules(
    root: string,
    fsLike: {
        existsSync: (p: string) => boolean;
        readdirSync: (p: string) => string[];
        readFileSync: (p: string, enc: 'utf-8') => string;
        statSync: (p: string) => {isDirectory: () => boolean};
    }
): Lockfile|null {
    // Posix join — we use forward slashes in `path` regardless of host
    // OS because that's the lockfile convention.
    const nmDir = `${root}/node_modules`.replace(/\\/g, '/');

    if (!fsLike.existsSync(nmDir) || !fsLike.statSync(nmDir).isDirectory()) {
        return null;
    }

    const packages: LockedPackage[] = [];

    const tryPushPackage = (name: string, pkgDir: string, relPath: string): void => {
        const manifestPath = `${pkgDir}/package.json`;
        if (!fsLike.existsSync(manifestPath)) {
            return;
        }
        try {
            const parsed = JSON.parse(fsLike.readFileSync(manifestPath, 'utf-8')) as {
                version?: unknown;
                dependencies?: unknown;
                peerDependencies?: unknown;
                optionalDependencies?: unknown;
            };
            if (typeof parsed.version !== 'string') {
                return;
            }
            packages.push({
                name,
                version: parsed.version,
                path: relPath,
                dev: false,
                optional: false,
                peer: false,
                deps: stringMap(parsed.dependencies),
                peerDeps: stringMap(parsed.peerDependencies),
                optionalDeps: stringMap(parsed.optionalDependencies)
            });
        } catch {
            // Skip individual broken manifests — one bad package
            // shouldn't kill the whole scan.
        }
    };

    for (const entry of fsLike.readdirSync(nmDir)) {
        // Hidden entries are npm internals (`.bin`, `.cache`,
        // `.package-lock.json`, …) — never real packages.
        if (entry.startsWith('.')) {
            continue;
        }

        const entryDir = `${nmDir}/${entry}`;
        if (!fsLike.statSync(entryDir).isDirectory()) {
            continue;
        }

        if (entry.startsWith('@')) {
            // Scoped: descend one more level. `node_modules/@scope/pkg`.
            for (const sub of fsLike.readdirSync(entryDir)) {
                if (sub.startsWith('.')) {
                    continue;
                }
                const subDir = `${entryDir}/${sub}`;
                if (!fsLike.statSync(subDir).isDirectory()) {
                    continue;
                }
                tryPushPackage(`${entry}/${sub}`, subDir, `node_modules/${entry}/${sub}`);
            }
        } else {
            tryPushPackage(entry, entryDir, `node_modules/${entry}`);
        }
    }

    // lockfileVersion 0 + source 'synthesized' = walked from node_modules
    // manifests; the real format always emits ≥ 2.
    return {lockfileVersion: 0, source: 'synthesized', packages};
}

type RawLockEntry = {
    name?: string;
    version?: string;
    resolved?: string;
    integrity?: string;
    dev?: boolean;
    devOptional?: boolean;
    optional?: boolean;
    peer?: boolean;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
};

type RawLock = {
    lockfileVersion?: number;
    packages?: Record<string, RawLockEntry>;
};

/**
 * Filter an unknown value down to `Record<string, string>`. Lockfile
 * entries are mostly well-typed but other tools (yarn-to-npm
 * converters, hand-edits) occasionally produce nulls or numbers.
 */
function stringMap(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Parse `package-lock.json` v2 or v3 (npm 7+). v1 (`dependencies`-only
 * tree without a flat `packages` map) is rejected — the conversion is
 * intrusive enough that we'd rather fail loudly than guess.
 *
 * The root entry (`packages[""]`) is skipped; consumers care about the
 * resolved sub-dependencies, not "what this project calls itself".
 *
 * `source` is `committed` by default since that's the most common
 * caller (`<root>/package-lock.json`). The fallback in
 * `ProjectLocal.loadLockfile` passes `'hidden'` for npm's internal
 * `node_modules/.package-lock.json` — same parser, different label.
 */
export function parsePackageLock(content: string, source: LockfileSource = 'committed'): Lockfile {
    const raw = JSON.parse(content) as RawLock;
    const version = raw.lockfileVersion ?? 0;

    if (version < 2) {
        throw new Error(
            `package-lock.json lockfileVersion ${version} not supported (need ≥ 2)`
        );
    }

    if (!raw.packages || typeof raw.packages !== 'object') {
        throw new Error('package-lock.json: missing `packages` map');
    }

    const out: LockedPackage[] = [];

    for (const [pkgPath, entry] of Object.entries(raw.packages)) {
        if (pkgPath === '') {
            // Root entry — describes the project itself, not a dep.
            continue;
        }

        const name = entry.name ?? packageNameFromPath(pkgPath);
        if (!name || typeof entry.version !== 'string') {
            continue;
        }

        out.push({
            name,
            version: entry.version,
            path: pkgPath,
            resolved: entry.resolved,
            integrity: entry.integrity,
            dev: entry.dev === true || entry.devOptional === true,
            optional: entry.optional === true || entry.devOptional === true,
            peer: entry.peer === true,
            deps: stringMap(entry.dependencies),
            peerDeps: stringMap(entry.peerDependencies),
            optionalDeps: stringMap(entry.optionalDependencies)
        });
    }

    return {lockfileVersion: version, source, packages: out};
}