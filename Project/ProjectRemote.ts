import {ConfigProjectType} from '../Config/Config.js';
import {Lockfile, LockfileReader} from './Lockfile.js';
import {DependencyType, PackageDependency, PackageManifest} from './PackageManifest.js';
import {Project} from './Project.js';

/**
 * One commit returned by `listCommitsForFile` — what nppm needs from
 * the host's commit-history endpoint. Timestamps are unix-ms so the
 * shape matches `HistoryEntry.timestamp` downstream.
 */
export type RemoteCommit = {
    sha: string;
    timestamp: number;
};

/**
 * Raw fields we consume from a remote package.json. Anything else in
 * the file is irrelevant to nppm and stays as `unknown`.
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
};

/**
 * Base class shared by `ProjectGithub` and `ProjectGitea`. Subclasses
 * implement the two transport hooks; this class owns workspace
 * expansion, manifest parsing, and the dep-bucket flatten — the parts
 * that are identical regardless of the hosting platform.
 */
export abstract class ProjectRemote implements Project {

    private readonly _name: string;
    private _hidden: boolean;
    private _configIndex: number;

    constructor(displayName: string, opts: {hidden?: boolean; configIndex?: number} = {}) {
        this._name = displayName;
        this._hidden = opts.hidden === true;
        this._configIndex = opts.configIndex ?? -1;
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

    public abstract getType(): ConfigProjectType;

    public abstract getKey(): string;

    /**
     * Subclass contract: return the file body as UTF-8 text, or
     * `null` if the path is missing. Errors (network, auth) should
     * throw — `loadManifests` lets them surface to the API layer.
     */
    protected abstract fetchFile(repoPath: string): Promise<string|null>;

    /**
     * Subclass contract: return the names of the immediate children
     * of `repoPath` (relative names, e.g. `"api"`, not `"packages/api"`).
     * Returns `[]` for unknown / non-directory paths.
     */
    protected abstract listDirectory(repoPath: string): Promise<string[]>;

    /**
     * Walk the host's commit-history API for `repoPath`, returning
     * one entry per commit that touched the file, oldest-first.
     * `null` signals that the API is unreachable or the project has
     * no committed copy — both buckets the SSE handler surfaces as
     * "remote backfill unavailable" rather than as an exception.
     *
     * Implementations are expected to paginate; the
     * `RemoteGitHistoryBackfill` consumer relies on the result being
     * the complete history within the configured cap.
     */
    public abstract listCommitsForFile(repoPath: string): Promise<RemoteCommit[]|null>;

    /**
     * Fetch the file contents at a specific commit SHA. Same
     * not-found / not-text contract as `fetchFile` — returns `null`
     * for a missing or binary file. Throws on transport / auth
     * errors so the caller can decide whether to abort the walk.
     */
    public abstract fetchFileAtRef(repoPath: string, ref: string): Promise<string|null>;

    /**
     * Resolve the configured `ref` (or the repo's default branch) to
     * a concrete commit SHA. Used as the backfill watermark stored
     * in `HistoryFile.gitBackfilledHead` so the next call can
     * short-circuit when HEAD hasn't moved. `null` when the API is
     * unreachable.
     */
    public abstract getHeadSha(): Promise<string|null>;

    public async loadLockfile(): Promise<Lockfile|null> {
        // Remote contents API can serve `package-lock.json` just fine,
        // but the file is often huge (megabytes for any non-trivial
        // tree). Pulling it on every matrix render via base64-decode
        // would dwarf the rest of the page; the user can run lockfile
        // analysis against a checked-out copy if they need it.
        //
        // Returning `null` is the contract for "no lockfile available"
        // — callers treat it the same as a project without a committed
        // lock.
        const body = await this.fetchFile('package-lock.json');

        if (body === null) {
            return null;
        }

        return LockfileReader.parse(body);
    }

    public async loadManifests(): Promise<PackageManifest[]> {
        const rootBody = await this.fetchFile('package.json');

        if (rootBody === null) {
            throw new Error(`package.json missing in remote project "${this._name}"`);
        }

        const rootRaw = ProjectRemote._parse(rootBody, 'package.json');
        const manifests: PackageManifest[] = [ProjectRemote._toManifest(rootRaw, undefined)];

        for (const wsRel of await this._resolveWorkspaces(rootRaw)) {
            const wsBody = await this.fetchFile(`${wsRel}/package.json`);

            if (wsBody === null) {
                continue;
            }

            try {
                const wsRaw = ProjectRemote._parse(wsBody, `${wsRel}/package.json`);
                manifests.push(ProjectRemote._toManifest(wsRaw, wsRel));
            } catch (e) {
                console.warn(`nppm: workspace ${wsRel} skipped — ${(e as Error).message}`);
            }
        }

        return manifests;
    }

    private static _parse(body: string, label: string): RawPackageJson {
        try {
            return JSON.parse(body) as RawPackageJson;
        } catch (e) {
            throw new Error(`invalid JSON in ${label}: ${(e as Error).message}`);
        }
    }

    private static _toManifest(raw: RawPackageJson, workspace: string|undefined): PackageManifest {
        const name = typeof raw.name === 'string' ? raw.name : '<unnamed>';
        const version = typeof raw.version === 'string' ? raw.version : '0.0.0';

        const dependencies: PackageDependency[] = [
            ...ProjectRemote._extractDeps(raw.dependencies, DependencyType.dependency, workspace),
            ...ProjectRemote._extractDeps(raw.devDependencies, DependencyType.dev, workspace),
            ...ProjectRemote._extractDeps(raw.peerDependencies, DependencyType.peer, workspace),
            ...ProjectRemote._extractDeps(raw.optionalDependencies, DependencyType.optional, workspace)
        ];

        return {name, version, workspace, dependencies, scripts: ProjectRemote._extractScripts(raw.scripts)};
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
                out.push({name, version, type, workspace});
            }
        }

        return out;
    }

    /**
     * Resolve the `workspaces` field into a list of repo-relative
     * directory paths. Mirrors `ProjectLocal._resolveWorkspaces` but
     * uses `listDirectory` for `/*` glob expansion instead of the
     * filesystem.
     */
    private async _resolveWorkspaces(raw: RawPackageJson): Promise<string[]> {
        let patterns: string[] = [];

        if (Array.isArray(raw.workspaces)) {
            patterns = raw.workspaces.filter((v): v is string => typeof v === 'string');
        } else if (raw.workspaces && typeof raw.workspaces === 'object') {
            const ws = raw.workspaces as {packages?: unknown};

            if (Array.isArray(ws.packages)) {
                patterns = ws.packages.filter((v): v is string => typeof v === 'string');
            }
        }

        const out = new Set<string>();

        for (const pattern of patterns) {
            const normalized = pattern.replace(/\\/g, '/');

            if (normalized.endsWith('/*')) {
                const parent = normalized.slice(0, -2);

                for (const child of await this.listDirectory(parent)) {
                    out.add(`${parent}/${child}`);
                }
            } else {
                out.add(normalized);
            }
        }

        return Array.from(out);
    }
}