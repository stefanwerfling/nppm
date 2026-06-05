import {ChildProcess} from 'child_process';
import {EventEmitter} from 'events';
import {PassThrough, Readable} from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ApiUpgradeRequest} from '../shared/Api/ApiTypes.js';
import {SpawnFn, StreamSink, Upgrader} from '../backend/Upgrade/Upgrader.js';

/**
 * Build a fake `ChildProcess` whose stdout/stderr replay scripted
 * chunks and whose `close` event fires with a configured exit code.
 * Synchronous enough for one tick of the event loop — vitest awaits
 * the promise the runner returns from `runInstall`/`runRebuild`.
 */
function makeFakeProcess(scripted: {
    stdout?: string[];
    stderr?: string[];
    exitCode?: number|null;
}): ChildProcess {
    const proc = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    (proc as unknown as {stdout: Readable;}).stdout = stdout;
    (proc as unknown as {stderr: Readable;}).stderr = stderr;
    (proc as unknown as {kill: () => boolean;}).kill = () => true;

    setImmediate(() => {
        for (const c of scripted.stdout ?? []) {
            stdout.write(c);
        }
        for (const c of scripted.stderr ?? []) {
            stderr.write(c);
        }
        stdout.end();
        stderr.end();
        proc.emit('close', scripted.exitCode ?? 0);
    });

    return proc;
}

function collectSink(): {
    sink: StreamSink;
    started: {command: string; cwd: string;}|null;
    stdout: string;
    stderr: string;
    ended: number|null|undefined;
    error: string|null;
    } {
    const state = {
        started: null as null|{command: string; cwd: string;},
        stdout: '',
        stderr: '',
        ended: undefined as number|null|undefined,
        error: null as string|null
    };
    const sink: StreamSink = {
        onStart: (command, cwd) => {
            state.started = {command: command, cwd: cwd};
        },
        onStdout: (c) => {
            state.stdout += c;
        },
        onStderr: (c) => {
            state.stderr += c;
        },
        onEnd: (code) => {
            state.ended = code;
        },
        onError: (msg) => {
            state.error = msg;
        }
    };
    return {sink: sink, ...state, get stdout() { return state.stdout; }, get stderr() { return state.stderr; }, get ended() { return state.ended; }, get error() { return state.error; }, get started() { return state.started; }};
}

describe('Upgrader', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-upgrader-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('preview() returns a planned diff without touching disk', async() => {
        const pkgPath = path.join(tmp, 'package.json');
        const before = '{\n  "dependencies": {\n    "lodash": "^4.17.20"\n  }\n}\n';
        fs.writeFileSync(pkgPath, before);
        const upgrader = new Upgrader(tmp);
        const req: ApiUpgradeRequest = {
            name: 'lodash',
            depType: 'dependency',
            fromRange: '^4.17.20',
            toRange: '^4.17.21'
        };
        const {result, rel, path: abs} = upgrader.preview(req);
        expect(result.changed).toBe(true);
        expect(result.after).toContain('"lodash": "^4.17.21"');
        expect(rel).toBe('package.json');
        expect(abs).toBe(pkgPath);
        // Disk untouched.
        expect(fs.readFileSync(pkgPath, 'utf-8')).toBe(before);
    });

    it('applyEdit() writes the file + snapshots a backup', () => {
        const pkgPath = path.join(tmp, 'package.json');
        fs.writeFileSync(pkgPath, '{"dependencies":{"lodash":"^4.17.20"}}');
        const upgrader = new Upgrader(tmp);
        const out = upgrader.applyEdit({
            name: 'lodash',
            depType: 'dependency',
            fromRange: '^4.17.20',
            toRange: '^4.17.21'
        });
        expect(out.result.changed).toBe(true);
        expect(fs.readFileSync(pkgPath, 'utf-8')).toContain('"lodash": "^4.17.21"');
        expect(out.backup.files).toEqual(['package.json']);
        expect(fs.existsSync(path.join(out.backup.dir, 'package.json'))).toBe(true);
    });

    it('applyEdit() throws when the preview is a no-op', () => {
        const pkgPath = path.join(tmp, 'package.json');
        fs.writeFileSync(pkgPath, '{"dependencies":{"lodash":"^4.17.20"}}');
        const upgrader = new Upgrader(tmp);
        expect(() => upgrader.applyEdit({
            name: 'lodash',
            depType: 'dependency',
            fromRange: '^4.17.20',
            toRange: '^4.17.20'
        })).toThrow(/already at/);
    });

    it('applyEdit() targets a workspace package.json when `workspace` is set', () => {
        const wsDir = path.join(tmp, 'apps', 'api');
        fs.mkdirSync(wsDir, {recursive: true});
        const pkgPath = path.join(wsDir, 'package.json');
        fs.writeFileSync(pkgPath, '{"devDependencies":{"vitest":"^3.0.0"}}');
        const upgrader = new Upgrader(tmp);
        const out = upgrader.applyEdit({
            workspace: 'apps/api',
            name: 'vitest',
            depType: 'dev',
            fromRange: '^3.0.0',
            toRange: '^4.0.0'
        });
        expect(out.rel).toBe(path.join('apps', 'api', 'package.json'));
        expect(fs.readFileSync(pkgPath, 'utf-8')).toContain('"vitest": "^4.0.0"');
    });

    it('runInstall() streams stdout/stderr and emits exit code via the sink', async() => {
        const pkgPath = path.join(tmp, 'package.json');
        fs.writeFileSync(pkgPath, '{}');
        const spawnStub: SpawnFn = (cmd, args) => {
            expect(cmd).toBe('npm');
            expect(args).toEqual(['install', '--ignore-scripts', '--no-audit', '--no-fund']);
            return makeFakeProcess({stdout: ['ok\n'], stderr: [], exitCode: 0});
        };
        const upgrader = new Upgrader(tmp, spawnStub);
        const c = collectSink();
        upgrader.runInstall(c.sink);
        await new Promise((r) => setTimeout(r, 20));
        expect(c.started?.command).toBe('npm install --ignore-scripts --no-audit --no-fund');
        expect(c.stdout).toBe('ok\n');
        expect(c.ended).toBe(0);
    });

    it('runRebuild() invokes `npm rebuild <pkg>`', async() => {
        const spawnStub: SpawnFn = (cmd, args) => {
            expect(cmd).toBe('npm');
            expect(args).toEqual(['rebuild', 'sharp']);
            return makeFakeProcess({stdout: ['rebuilt sharp\n'], exitCode: 0});
        };
        const upgrader = new Upgrader(tmp, spawnStub);
        const c = collectSink();
        upgrader.runRebuild('sharp', c.sink);
        await new Promise((r) => setTimeout(r, 20));
        expect(c.stdout).toContain('rebuilt sharp');
        expect(c.ended).toBe(0);
    });

    it('applyMany() bundles multiple edits + lockfile into one backup', () => {
        const rootPkg = path.join(tmp, 'package.json');
        const wsDir = path.join(tmp, 'apps', 'api');
        fs.mkdirSync(wsDir, {recursive: true});
        const wsPkg = path.join(wsDir, 'package.json');
        fs.writeFileSync(rootPkg, '{"dependencies":{"lodash":"^4.17.20"}}');
        fs.writeFileSync(wsPkg, '{"devDependencies":{"vitest":"^3.0.0"}}');
        fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{"lockfileVersion":3}');

        const upgrader = new Upgrader(tmp);
        const out = upgrader.applyMany([
            {name: 'lodash', depType: 'dependency', fromRange: '^4.17.20', toRange: '^4.17.21'},
            {workspace: 'apps/api', name: 'vitest', depType: 'dev', fromRange: '^3.0.0', toRange: '^4.0.0'}
        ]);

        expect(out.results).toHaveLength(2);
        expect(out.results.every((r) => r.result.changed)).toBe(true);
        expect(fs.readFileSync(rootPkg, 'utf-8')).toContain('"lodash": "^4.17.21"');
        expect(fs.readFileSync(wsPkg, 'utf-8')).toContain('"vitest": "^4.0.0"');

        // Single backup folder, all three files snapshotted.
        const snapshotted = new Set(out.backup.files);
        expect(snapshotted.has('package.json')).toBe(true);
        expect(snapshotted.has(path.join('apps', 'api', 'package.json'))).toBe(true);
        expect(snapshotted.has('package-lock.json')).toBe(true);
    });

    it('applyMany() reports unchanged picks without aborting', () => {
        const rootPkg = path.join(tmp, 'package.json');
        fs.writeFileSync(rootPkg, '{"dependencies":{"lodash":"^4.17.20"}}');

        const upgrader = new Upgrader(tmp);
        const out = upgrader.applyMany([
            {name: 'missing-pkg', depType: 'dependency', fromRange: '^1', toRange: '^2'},
            {name: 'lodash', depType: 'dependency', fromRange: '^4.17.20', toRange: '^4.17.21'}
        ]);

        expect(out.results[0].result.changed).toBe(false);
        expect(out.results[1].result.changed).toBe(true);
        expect(fs.readFileSync(rootPkg, 'utf-8')).toContain('"lodash": "^4.17.21"');
    });

    it('runInstall() routes spawn errors to onError + onEnd(null)', () => {
        const spawnStub: SpawnFn = () => {
            throw new Error('npm: not found');
        };
        const upgrader = new Upgrader(tmp, spawnStub);
        const c = collectSink();
        upgrader.runInstall(c.sink);
        expect(c.error).toMatch(/npm: not found/);
        expect(c.ended).toBeNull();
    });
});