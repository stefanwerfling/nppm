import {ChildProcess, spawn} from 'child_process';
import fs from 'fs';
import path from 'path';
import {ApiUpgradeRequest} from '../Api/ApiTypes.js';
import {SafePath} from '../Project/SafePath.js';
import {BackupStamp, BackupStore} from './BackupStore.js';
import {EditResult, PackageJsonEditor} from './PackageJsonEditor.js';

/**
 * Strategy for `child_process.spawn`. Real callers use Node's built-in
 * `spawn`; tests inject a stub that yields scripted stdout/stderr
 * without touching the system shell.
 */
export type SpawnFn = (
    command: string,
    args: readonly string[],
    options: {cwd: string; env?: NodeJS.ProcessEnv}
) => ChildProcess;

/**
 * Callback shape every streaming endpoint uses. Mirrors the
 * `ApiStream*Event` payloads in `Api/ApiTypes.ts` — one callback per
 * event name keeps the SSE adapter trivial.
 */
export type StreamSink = {
    onStart: (command: string, cwd: string) => void;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onEnd: (exitCode: number|null) => void;
    onError: (msg: string) => void;
};

/**
 * Orchestrator for the Upgrade modal's flows. Owns the package.json
 * edit (via `PackageJsonEditor`), the backup snapshot (via
 * `BackupStore`), and any child-process spawn (`npm install
 * --ignore-scripts`, `npm rebuild <pkg>`). Each public method is
 * independently invokable from the API layer so the routes stay
 * thin.
 */
export class Upgrader {

    private readonly _projectRoot: string;
    private readonly _backups: BackupStore;
    private readonly _spawn: SpawnFn;

    constructor(projectRoot: string, spawnFn: SpawnFn = spawn) {
        this._projectRoot = projectRoot;
        this._backups = new BackupStore(path.join(projectRoot, '.nppm-backups'));
        this._spawn = spawnFn;
    }

    /**
     * Resolve the absolute path of the `package.json` that the
     * Upgrade request targets. `request.workspace` empty / undefined
     * means the project root; anything else is treated as a
     * directory relative to the root.
     */
    public resolvePackageJson(request: ApiUpgradeRequest): {abs: string; rel: string} {
        const wsDir = request.workspace && request.workspace.length > 0 ? request.workspace : '';
        const rel = wsDir.length > 0
            ? path.join(wsDir, 'package.json')
            : 'package.json';
        // SafePath rejects workspaces like `../../etc` that would let an
        // upgrade-apply call write a package.json outside the project.
        return {abs: SafePath.join(this._projectRoot, rel), rel};
    }

    /**
     * Read + plan the edit. Returns the new `package.json` content
     * alongside the original so the API can render a diff. Does *not*
     * write to disk.
     */
    public preview(request: ApiUpgradeRequest): {
        path: string;
        rel: string;
        result: EditResult;
    } {
        const {abs, rel} = this.resolvePackageJson(request);
        if (!fs.existsSync(abs)) {
            throw new Error(`package.json not found at ${abs}`);
        }
        const source = fs.readFileSync(abs, 'utf-8');
        const result = PackageJsonEditor.apply(source, request.depType, request.name, request.toRange);
        return {path: abs, rel, result};
    }

    /**
     * Commit the edit to disk after snapshotting the affected files
     * (`package.json` and `package-lock.json` if present). Throws if
     * the underlying preview wouldn't change anything (caller should
     * have caught that earlier — guard against the race anyway).
     */
    public applyEdit(request: ApiUpgradeRequest): {
        backup: BackupStamp;
        result: EditResult;
        path: string;
        rel: string;
    } {
        const {path: abs, rel, result} = this.preview(request);
        if (!result.changed) {
            throw new Error(`${request.name} is already at ${request.toRange} in ${rel}`);
        }
        const lockPath = path.join(this._projectRoot, 'package-lock.json');
        const backup = this._backups.save(this._projectRoot, [abs, lockPath]);
        fs.writeFileSync(abs, result.after);
        return {backup, result, path: abs, rel};
    }

    /**
     * Bulk variant of `applyEdit`: plan every pick first, snapshot all
     * touched files (each pick's `package.json` + the project's lockfile
     * if present) in ONE backup folder, then write every changed file.
     * Picks where the dep isn't in the named bucket are returned with
     * `changed:false` so the caller can report "skipped" without aborting
     * the rest of the batch. Throws only on filesystem failures or
     * unreadable `package.json` files — domain-level "nothing to do"
     * surfaces as `changed:false`.
     */
    public applyMany(requests: ApiUpgradeRequest[]): {
        backup: BackupStamp;
        results: {request: ApiUpgradeRequest; path: string; rel: string; result: EditResult}[];
    } {
        // Plan everything up-front so the snapshot covers exactly the
        // files we're about to touch — and so a parse failure aborts
        // before we've mutated anything.
        const planned: {request: ApiUpgradeRequest; abs: string; rel: string; result: EditResult}[] = [];
        const touched = new Set<string>();
        for (const request of requests) {
            const {abs, rel} = this.resolvePackageJson(request);
            if (!fs.existsSync(abs)) {
                throw new Error(`package.json not found at ${abs}`);
            }
            const source = fs.readFileSync(abs, 'utf-8');
            const result = PackageJsonEditor.apply(source, request.depType, request.name, request.toRange);
            planned.push({request, abs, rel, result});
            touched.add(abs);
        }

        const lockPath = path.join(this._projectRoot, 'package-lock.json');
        const backupPaths = [...touched];
        if (fs.existsSync(lockPath)) {
            backupPaths.push(lockPath);
        }
        const backup = this._backups.save(this._projectRoot, backupPaths);

        for (const p of planned) {
            if (p.result.changed) {
                fs.writeFileSync(p.abs, p.result.after);
            }
        }

        return {
            backup,
            results: planned.map((p) => ({request: p.request, path: p.abs, rel: p.rel, result: p.result}))
        };
    }

    /**
     * Spawn `npm install --ignore-scripts` in the project root and
     * pipe its output into `sink`. Returns the child handle so the
     * caller can hook abort/timeout policies; the sink already gets
     * the start/end events.
     */
    public runInstall(sink: StreamSink): ChildProcess {
        return this._runStreaming('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], sink);
    }

    /**
     * `npm rebuild <name>` — re-runs the install lifecycle for one
     * already-installed package. The right tool for the per-script
     * "Run" buttons after a `--ignore-scripts` install.
     */
    public runRebuild(name: string, sink: StreamSink): ChildProcess {
        return this._runStreaming('npm', ['rebuild', name], sink);
    }

    private _runStreaming(command: string, args: readonly string[], sink: StreamSink): ChildProcess {
        const cwd = this._projectRoot;
        const label = [command, ...args].join(' ');
        sink.onStart(label, cwd);
        let child: ChildProcess;
        try {
            child = this._spawn(command, args, {cwd, env: process.env});
        } catch (e) {
            sink.onError(`spawn failed: ${(e as Error).message}`);
            sink.onEnd(null);
            return Upgrader._deadProcess();
        }

        child.stdout?.setEncoding('utf-8');
        child.stderr?.setEncoding('utf-8');
        child.stdout?.on('data', (c: string) => sink.onStdout(c));
        child.stderr?.on('data', (c: string) => sink.onStderr(c));
        child.on('error', (err) => sink.onError(err.message));
        child.on('close', (code) => sink.onEnd(code));
        return child;
    }

    /**
     * Stand-in for the case where spawn itself threw. Used so the
     * route handlers can always return *something* awaitable.
     */
    private static _deadProcess(): ChildProcess {
        const noop = {
            kill(): boolean {
                return false;
            }
        };
        return noop as unknown as ChildProcess;
    }
}