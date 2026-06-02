import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {ConfigProjectType} from '../Config/Config.js';
import {MatrixBuilder, MatrixRowStatus} from '../Matrix/MatrixBuilder.js';
import {DependencyType, PackageManifest} from '../Project/PackageManifest.js';
import {Project} from '../Project/Project.js';
import {Registry, RegistryPackage} from '../Registry/Registry.js';

/**
 * A fake Project whose manifests are inlined. Lets the matrix
 * builder run without touching disk.
 */
class FakeProject implements Project {

    private _hidden = false;

    constructor(
        private readonly _name: string,
        private readonly _manifests: PackageManifest[]
    ) {}

    public getName(): string {
        return this._name;
    }

    public getType(): ConfigProjectType {
        return ConfigProjectType.local;
    }

    public async loadManifests(): Promise<PackageManifest[]> {
        return this._manifests;
    }

    public async loadLockfile() {
        return null;
    }

    public getKey() {
        return `local:fake:${this._name}`;
    }

    public isHidden() { return this._hidden; }
    public setHidden(v: boolean) { this._hidden = v; }
    public getConfigIndex() { return -1; }
    public getTemplates() { return []; }
}

/**
 * Registry subclass whose `fetchMany` returns canned data — never
 * touches the network.
 */
class FakeRegistry extends Registry {
    constructor(private readonly _data: Record<string, RegistryPackage|null>) {
        super(
            'unused',
            new JsonCache(fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-fr-')), 60)
        );
    }

    public async fetchMany(names: string[]): Promise<Map<string, RegistryPackage|null>> {
        const out = new Map<string, RegistryPackage|null>();
        for (const n of new Set(names)) {
            out.set(n, this._data[n] ?? null);
        }
        return out;
    }
}

function manifest(
    name: string,
    deps: Record<string, string>,
    workspace?: string
): PackageManifest {
    return {
        name,
        version: '0.0.0',
        workspace,
        dependencies: Object.entries(deps).map(([n, v]) => ({
            name: n,
            version: v,
            type: DependencyType.dependency,
            workspace
        })),
        scripts: {}
    };
}

describe('MatrixBuilder.build', () => {
    let tmps: string[] = [];

    beforeEach(() => {
        tmps = [];
    });

    afterEach(() => {
        for (const t of tmps) {
            fs.rmSync(t, {recursive: true, force: true});
        }
    });

    it('produces one row per unique package across projects', async () => {
        const a = new FakeProject('a', [manifest('a', {foo: '^1', bar: '^2'})]);
        const b = new FakeProject('b', [manifest('b', {foo: '^1', baz: '^3'})]);

        const projects = new Map<string, Project>([['1', a], ['2', b]]);
        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({}));

        expect(matrix.rows.map((r) => r.name).sort()).toEqual(['bar', 'baz', 'foo']);
    });

    it('skips hidden projects from columns and from the row union', async () => {
        const visible = new FakeProject('visible', [manifest('visible', {shared: '^1', only: '^2'})]);
        const hidden = new FakeProject('hidden', [manifest('hidden', {shared: '^1', secret: '^3'})]);
        hidden.setHidden(true);

        const projects = new Map<string, Project>([['1', visible], ['2', hidden]]);
        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({}));

        // Only one project column survives.
        expect(matrix.projects).toHaveLength(1);
        expect(matrix.projects[0].name).toBe('visible');
        // The hidden project's exclusive package never appears.
        expect(matrix.rows.map((r) => r.name).sort()).toEqual(['only', 'shared']);
    });

    it('marks the row as aligned when all cells equal latest', async () => {
        const a = new FakeProject('a', [manifest('a', {foo: '^1.0.0'})]);
        const b = new FakeProject('b', [manifest('b', {foo: '^1.0.0'})]);

        const projects = new Map<string, Project>([['1', a], ['2', b]]);
        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({
            foo: {name: 'foo', latest: '1.0.0', versions: ['1.0.0']}
        }));

        expect(matrix.rows[0].status).toBe(MatrixRowStatus.aligned);
    });

    it('marks the row as outdated when all cells agree but latest differs', async () => {
        const a = new FakeProject('a', [manifest('a', {foo: '^1.0.0'})]);
        const projects = new Map<string, Project>([['1', a]]);

        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({
            foo: {name: 'foo', latest: '2.0.0', versions: ['1.0.0', '2.0.0']}
        }));

        expect(matrix.rows[0].status).toBe(MatrixRowStatus.outdated);
        expect(matrix.rows[0].latest).toBe('2.0.0');
    });

    it('marks the row as drift when projects disagree on the version', async () => {
        const a = new FakeProject('a', [manifest('a', {foo: '^1.0.0'})]);
        const b = new FakeProject('b', [manifest('b', {foo: '^2.0.0'})]);

        const projects = new Map<string, Project>([['1', a], ['2', b]]);
        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({
            foo: {name: 'foo', latest: '2.0.0', versions: ['1.0.0', '2.0.0']}
        }));

        expect(matrix.rows[0].status).toBe(MatrixRowStatus.drift);
    });

    it('forces latest=null for git-only rows even when the registry has an unrelated package with the same name', async () => {
        // The figtree / fundon collision: the user's `figtree` is a
        // git dep, but `figtree@0.0.0` exists on npm (by a different
        // author). Without the git-only guard the matrix would
        // mis-attribute fundon's 0.0.0 as "latest" and flag the row
        // as outdated against a foreign package.
        const a = new FakeProject('a', [manifest('a', {
            figtree: 'git+https://github.com/me/figtree.git#main'
        })]);
        const b = new FakeProject('b', [manifest('b', {
            figtree: 'git+https://github.com/me/figtree.git#claude'
        })]);

        const projects = new Map<string, Project>([['1', a], ['2', b]]);
        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({
            figtree: {name: 'figtree', latest: '0.0.0', versions: ['0.0.0']}
        }));

        expect(matrix.rows[0].latest).toBeNull();
        expect(matrix.rows[0].latestPublishedAt).toBeNull();
        // Two different refs → drift (not outdated against a foreign latest).
        expect(matrix.rows[0].status).toBe(MatrixRowStatus.drift);
    });

    it('marks the row as unknown when registry has no data', async () => {
        const a = new FakeProject('a', [manifest('a', {foo: '^1'})]);
        const projects = new Map<string, Project>([['1', a]]);

        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({foo: null}));
        expect(matrix.rows[0].status).toBe(MatrixRowStatus.unknown);
    });

    it('flags internalDrift when workspaces of one project disagree', async () => {
        const root = manifest('root', {foo: '^1.0.0'});
        const ws = manifest('child', {foo: '^2.0.0'}, 'packages/child');
        const a = new FakeProject('a', [root, ws]);

        const projects = new Map<string, Project>([['1', a]]);
        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({
            foo: {name: 'foo', latest: '1.0.0', versions: ['1.0.0', '2.0.0']}
        }));

        const cell = matrix.rows[0].cells['1'];
        expect(cell.internalDrift).toBe(true);
        // displayed version prefers the root manifest
        expect(cell.version).toBe('^1.0.0');
        // workspace is `undefined` because root declared the dep
        expect(cell.workspace).toBeUndefined();
    });

    it('records the workspace on the cell when a dep lives only in a workspace', async () => {
        // The webpack / bulk-upgrade case: webpack is declared in
        // <proj>/frontend/package.json but not in the root. Without
        // the workspace marker the Bulk-Upgrade Wizard would aim its
        // pick at root/package.json and silently skip.
        const root = manifest('root', {});
        const front = manifest('front', {webpack: '^5.97.1'}, 'frontend');
        const a = new FakeProject('a', [root, front]);

        const projects = new Map<string, Project>([['1', a]]);
        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({
            webpack: {name: 'webpack', latest: '5.99.0', versions: ['5.97.1', '5.99.0']}
        }));

        const cell = matrix.rows[0].cells['1'];
        expect(cell.workspace).toBe('frontend');
        expect(cell.internalDrift).toBe(false);
        expect(cell.version).toBe('^5.97.1');
    });

    it('surfaces a per-project error without breaking the rest', async () => {
        const broken: Project = {
            getName: () => 'broken',
            getKey: () => 'local:fake:broken',
            getType: () => ConfigProjectType.local,
            loadManifests: async () => {
                throw new Error('boom');
            },
            loadLockfile: async () => null,
            isHidden: () => false,
            setHidden: () => {},
            getConfigIndex: () => -1,
            getTemplates: () => []
        };
        const good = new FakeProject('good', [manifest('g', {x: '^1'})]);
        const projects = new Map<string, Project>([['1', broken], ['2', good]]);

        const matrix = await MatrixBuilder.build(projects, new FakeRegistry({}));
        const brokenMeta = matrix.projects.find((p) => p.unid === '1')!;
        expect(brokenMeta.error).toMatch(/boom/);
        expect(matrix.rows.map((r) => r.name)).toEqual(['x']);
    });
});