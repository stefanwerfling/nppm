import fs from 'fs';
import os from 'os';
import path from 'path';
import {describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {ConfigProjectType} from '../backend/Config/Config.js';
import {MatrixRowStatus} from '../backend/Matrix/MatrixBuilder.js';
import {ProjectMatrixBuilder} from '../backend/Matrix/ProjectMatrixBuilder.js';
import {DependencyType, PackageManifest} from '../backend/Project/PackageManifest.js';
import {Project} from '../backend/Project/Project.js';
import {Registry, RegistryPackage} from '../backend/Registry/Registry.js';

function manifest(name: string, deps: Record<string, string>, workspace?: string): PackageManifest {
    return {
        name: name,
        version: '1.0.0',
        workspace: workspace,
        dependencies: Object.entries(deps).map(([n, v]) => ({
            name: n,
            version: v,
            type: DependencyType.dependency,
            workspace: workspace
        })),
        scripts: {}
    };
}

class FakeProject implements Project {

    constructor(private readonly _name: string, private readonly _manifests: PackageManifest[]) {}

    public getName(): string {
        return this._name;
    }
    public getKey(): string {
        return `local:fake:${this._name}`;
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
    public isHidden() { return false; }
    public setHidden(_v: boolean) { /* no-op: stub satisfies Project interface */ }
    public getConfigIndex() { return -1; }
    public getTemplates() { return []; }

}

class FakeRegistry extends Registry {

    constructor(private readonly _data: Record<string, RegistryPackage|null>) {
        super('unused', new JsonCache(fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-pmr-')), 60));
    }
    public async fetchMany(names: string[]): Promise<Map<string, RegistryPackage|null>> {
        const out = new Map<string, RegistryPackage|null>();
        for (const n of new Set(names)) {
            out.set(n, this._data[n] ?? null);
        }
        return out;
    }

}

describe('ProjectMatrixBuilder.build', () => {
    it('puts root first and one column per workspace', async() => {
        const project = new FakeProject('p', [
            manifest('root', {foo: '^1.0.0'}),
            manifest('api', {foo: '^1.0.0', bar: '^2.0.0'}, 'packages/api'),
            manifest('web', {bar: '^2.0.0'}, 'apps/web')
        ]);

        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({}));
        expect(matrix.workspaces.map((w) => w.label)).toEqual([
            'root',
            'packages/api',
            'apps/web'
        ]);
        expect(matrix.rows.map((r) => r.name)).toEqual(['bar', 'foo']);
    });

    it('marks drift when two workspaces declare different versions', async() => {
        const project = new FakeProject('p', [
            manifest('root', {foo: '^1.0.0'}),
            manifest('child', {foo: '^2.0.0'}, 'packages/child')
        ]);

        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({
            foo: {name: 'foo', latest: '2.0.0', versions: ['1.0.0', '2.0.0']}
        }));

        expect(matrix.rows[0].status).toBe(MatrixRowStatus.drift);
    });

    it('marks aligned when every workspace agrees with latest', async() => {
        const project = new FakeProject('p', [
            manifest('root', {foo: '^1.2.3'}),
            manifest('child', {foo: '^1.2.3'}, 'packages/child')
        ]);
        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({
            foo: {name: 'foo', latest: '1.2.3', versions: ['1.2.3']}
        }));
        expect(matrix.rows[0].status).toBe(MatrixRowStatus.aligned);
    });

    it('emits sparse cells (missing workspace dep absent from row.cells)', async() => {
        const project = new FakeProject('p', [
            manifest('root', {foo: '^1'}),
            manifest('child', {}, 'packages/child')
        ]);
        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({}));
        const row = matrix.rows[0];
        expect(row.cells.root).toBeDefined();
        expect(row.cells['packages/child']).toBeUndefined();
    });

    it('handles a single-manifest project (only the root column)', async() => {
        const project = new FakeProject('p', [manifest('root', {foo: '^1.0.0'})]);
        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({}));
        expect(matrix.workspaces).toEqual([{label: 'root'}]);
        expect(matrix.rows).toHaveLength(1);
    });

    it('forces latest=null on git-only rows so a foreign npm package of the same name cannot leak in', async() => {
        /*
         * The user's `figtree` is a git dep; npm has an unrelated
         * `figtree@0.0.0` from another author. The per-project matrix
         * must not surface fundon's 0.0.0 as latest just because the
         * registry returns it for that name.
         */
        const project = new FakeProject('p', [
            manifest('root', {figtree: 'git+https://github.com/me/figtree.git#v1.0.20'}),
            manifest('api', {figtree: 'git+https://github.com/me/figtree.git#main'}, 'packages/api')
        ]);
        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({
            figtree: {name: 'figtree', latest: '0.0.0', versions: ['0.0.0']}
        }));
        const row = matrix.rows.find((r) => r.name === 'figtree');
        expect(row).toBeDefined();
        expect(row!.latest).toBeNull();
        expect(row!.gitLatest).toBeDefined();
        expect(row!.gitLatest!.sourceUrl).toBe('git+https://github.com/me/figtree.git');
    });

    it('resolves git HEAD info once per distinct origin and stamps version + shortSha on the row', async() => {
        const project = new FakeProject('p', [
            manifest('root', {figtree: 'git+https://github.com/me/figtree.git#v1.0.20'}),
            manifest('api', {figtree: 'git+https://github.com/me/figtree.git#main'}, 'packages/api')
        ]);

        let calls = 0;
        const headFetcher = {
            fetch: async(url: string) => {
                calls++;
                expect(url).toBe('git+https://github.com/me/figtree.git');
                return {version: '1.0.28', sha: 'a'.repeat(40), shortSha: 'aaaaaaa'};
            }
        };
        const matrix = await ProjectMatrixBuilder.build(
            'UNID',
            project,
            new FakeRegistry({}),
            headFetcher as any
        );

        expect(calls).toBe(1);
        const row = matrix.rows.find((r) => r.name === 'figtree')!;
        expect(row.gitLatest?.version).toBe('1.0.28');
        expect(row.gitLatest?.shortSha).toBe('aaaaaaa');
    });
});