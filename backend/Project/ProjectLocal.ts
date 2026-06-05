import fs from 'fs';
import path from 'path';
import {ConfigProjectType} from '../Config/Config.js';
import {Lockfile, LockfileReader} from './Lockfile.js';
import {DependencyType, PackageDependency, PackageManifest} from './PackageManifest.js';
import {Project} from './Project.js';

/**
 * Raw shape of the fields we read from a package.json. Everything we do
 * not consume is left as `unknown` so a malformed value elsewhere in the
 * file does not bring down the parse.
 */
type RawPackageJson = {
    name?: unknown;
    version?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
    peerDependencies?: unknown;
    optionalDependencies?: unknown;
    workspaces?: unknown;
    scripts?: unknown;
    engines?: unknown;
    private?: unknown;
    type?: unknown;
    packageManager?: unknown;
};

/**
 * Reads a directory on disk: the root package.json plus every workspace
 * package.json it declares. Workspaces are taken from the npm format
 * (string array or `{ packages: string[] }`); each entry may end in `/*`
 * to expand to immediate children.
 */
export class ProjectLocal implements Project {

    private readonly _root: string;
    private readonly _name: string;
    private _hidden: boolean;
    private _configIndex: number;
    private readonly _templates: string[];

    constructor(
        absoluteRoot: string,
        configName?: string,
        opts: {hidden?: boolean; configIndex?: number; templates?: string[];} = {}
    ) {
        this._root = absoluteRoot;
        this._name = configName ?? path.basename(absoluteRoot);
        this._hidden = opts.hidden === true;
        this._configIndex = opts.configIndex ?? -1;
        this._templates = opts.templates ?? [];
    }

    public getName(): string {
        return this._name;
    }

    public isHidden(): boolean {
        return this._hidden;
    }

    public setHidden(hidden: boolean): void {
        this._hidden = hidden;
    }

    public getConfigIndex(): number {
        return this._configIndex;
    }

    public getTemplates(): string[] {
        return this._templates;
    }

    /**
     * Absolute on-disk root of the project. Exposed for tools that
     * need to walk source files (UnusedDetector) — remote projects
     * have no equivalent.
     */
    public getRoot(): string {
        return this._root;
    }

    public getKey(): string {
        /*
         * Absolute on-disk root: stable across renames of `name`, and
         * unique even for two projects whose configured `name` collides.
         */
        return `local:${this._root}`;
    }

    public getType(): ConfigProjectType {
        return ConfigProjectType.local;
    }

    public async loadLockfile(): Promise<Lockfile|null> {
        /*
         * Resolution order, in decreasing fidelity:
         *   1. Committed `<root>/package-lock.json`
         *   2. npm's hidden `<root>/node_modules/.package-lock.json`
         *      (same shape, same data — just written by npm into
         *      node_modules so projects that gitignore the committed
         *      lockfile still expose it locally)
         *   3. Synthesized walk of `<root>/node_modules/*` manifests
         *      (no dev/peer/optional flags, no nested data)
         */
        const lockPath = path.join(this._root, 'package-lock.json');
        if (fs.existsSync(lockPath)) {
            return LockfileReader.parse(fs.readFileSync(lockPath, 'utf-8'), 'committed');
        }

        const hiddenLockPath = path.join(this._root, 'node_modules', '.package-lock.json');
        if (fs.existsSync(hiddenLockPath)) {
            return LockfileReader.parse(fs.readFileSync(hiddenLockPath, 'utf-8'), 'hidden');
        }

        return LockfileReader.scanNodeModules(this._root, fs);
    }

    public async loadManifests(): Promise<PackageManifest[]> {
        const rootPkgPath = path.join(this._root, 'package.json');

        if (!fs.existsSync(rootPkgPath)) {
            throw new Error(`package.json not found in ${this._root}`);
        }

        const rootRaw = ProjectLocal._readJson(rootPkgPath);
        const manifests: PackageManifest[] = [ProjectLocal._toManifest(rootRaw, undefined)];

        for (const wsRel of ProjectLocal._resolveWorkspaces(this._root, rootRaw)) {
            const wsPkgPath = path.join(this._root, wsRel, 'package.json');

            if (!fs.existsSync(wsPkgPath)) {
                continue;
            }

            try {
                const wsRaw = ProjectLocal._readJson(wsPkgPath);
                manifests.push(ProjectLocal._toManifest(wsRaw, wsRel));
            } catch (e) {
                console.warn(`nppm: workspace ${wsRel} skipped — ${(e as Error).message}`);
            }
        }

        return manifests;
    }

    /**
     * Read + JSON.parse a package.json. Wraps the parse error to point
     * at the file the user actually edits.
     */
    private static _readJson(file: string): RawPackageJson {
        const raw = fs.readFileSync(file, 'utf-8');

        try {
            return JSON.parse(raw) as RawPackageJson;
        } catch (e) {
            throw new Error(`invalid JSON in ${file}: ${(e as Error).message}`);
        }
    }

    /**
     * Project a `package.json` onto our flat `PackageManifest` shape.
     * The four dependency buckets become a single tagged list so the
     * matrix view can render them with one loop.
     */
    private static _toManifest(raw: RawPackageJson, workspace: string|undefined): PackageManifest {
        const name = typeof raw.name === 'string' ? raw.name : '<unnamed>';
        const version = typeof raw.version === 'string' ? raw.version : '0.0.0';

        const deps: PackageDependency[] = [
            ...ProjectLocal._extractDeps(raw.dependencies, DependencyType.dependency, workspace),
            ...ProjectLocal._extractDeps(raw.devDependencies, DependencyType.dev, workspace),
            ...ProjectLocal._extractDeps(raw.peerDependencies, DependencyType.peer, workspace),
            ...ProjectLocal._extractDeps(raw.optionalDependencies, DependencyType.optional, workspace)
        ];

        return {
            name: name,
            version: version,
            workspace: workspace,
            dependencies: deps,
            scripts: ProjectLocal._extractScripts(raw.scripts),
            engines: ProjectLocal._extractStringMap(raw.engines),
            isPrivate: typeof raw.private === 'boolean' ? raw.private : undefined,
            moduleType: typeof raw.type === 'string' ? raw.type : undefined,
            packageManager: typeof raw.packageManager === 'string' ? raw.packageManager : undefined
        };
    }

    private static _extractStringMap(raw: unknown): Record<string, string>|undefined {
        if (!raw || typeof raw !== 'object') {
            return undefined;
        }
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof v === 'string') {
                out[k] = v;
            }
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }

    private static _extractScripts(raw: unknown): Record<string, string> {
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

    private static _extractDeps(
        block: unknown,
        type: DependencyType,
        workspace: string|undefined
    ): PackageDependency[] {
        if (!block || typeof block !== 'object') {
            return [];
        }

        const out: PackageDependency[] = [];

        for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
            if (typeof version === 'string') {
                out.push({name: name, version: version, type: type, workspace: workspace});
            }
        }

        return out;
    }

    /**
     * Resolve the `workspaces` field into a list of relative directory
     * paths. Supports both shapes (array of patterns, `{packages: []}`)
     * and trailing-`/*` globs (expands to first-level children that
     * contain a package.json). No `**` support — keep it predictable.
     */
    private static _resolveWorkspaces(root: string, raw: RawPackageJson): string[] {
        let patterns: string[] = [];

        if (Array.isArray(raw.workspaces)) {
            patterns = raw.workspaces.filter((v): v is string => typeof v === 'string');
        } else if (raw.workspaces && typeof raw.workspaces === 'object') {
            const ws = raw.workspaces as {packages?: unknown;};

            if (Array.isArray(ws.packages)) {
                patterns = ws.packages.filter((v): v is string => typeof v === 'string');
            }
        }

        const out = new Set<string>();

        for (const pattern of patterns) {
            const normalized = pattern.replace(/\\/g, '/');

            if (normalized.endsWith('/*')) {
                const parent = normalized.slice(0, -2);
                const parentAbs = path.join(root, parent);

                if (!fs.existsSync(parentAbs) || !fs.statSync(parentAbs).isDirectory()) {
                    continue;
                }

                for (const entry of fs.readdirSync(parentAbs)) {
                    const child = path.posix.join(parent, entry);
                    const childPkg = path.join(root, child, 'package.json');

                    if (fs.existsSync(childPkg)) {
                        out.add(child);
                    }
                }
            } else {
                out.add(normalized);
            }
        }

        return Array.from(out);
    }

}