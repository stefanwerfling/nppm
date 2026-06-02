import fs from 'fs';
import os from 'os';
import path from 'path';
import {describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {ConfigProjectType} from '../Config/Config.js';
import {MatrixRowStatus} from '../Matrix/MatrixBuilder.js';
import {ProjectMatrixBuilder} from '../Matrix/ProjectMatrixBuilder.js';
import {DependencyType, PackageManifest} from '../Project/PackageManifest.js';
import {Project} from '../Project/Project.js';
import {Registry, RegistryPackage} from '../Registry/Registry.js';

function manifest(name: string, deps: Record<string, string>, workspace?: string): PackageManifest {
    return {
        name,
        version: '1.0.0',
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
    public setHidden(_v: boolean) {}
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
    it('puts root first and one column per workspace', async () => {
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

    it('marks drift when two workspaces declare different versions', async () => {
        const project = new FakeProject('p', [
            manifest('root', {foo: '^1.0.0'}),
            manifest('child', {foo: '^2.0.0'}, 'packages/child')
        ]);

        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({
            foo: {name: 'foo', latest: '2.0.0', versions: ['1.0.0', '2.0.0']}
        }));

        expect(matrix.rows[0].status).toBe(MatrixRowStatus.drift);
    });

    it('marks aligned when every workspace agrees with latest', async () => {
        const project = new FakeProject('p', [
            manifest('root', {foo: '^1.2.3'}),
            manifest('child', {foo: '^1.2.3'}, 'packages/child')
        ]);
        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({
            foo: {name: 'foo', latest: '1.2.3', versions: ['1.2.3']}
        }));
        expect(matrix.rows[0].status).toBe(MatrixRowStatus.aligned);
    });

    it('emits sparse cells (missing workspace dep absent from row.cells)', async () => {
        const project = new FakeProject('p', [
            manifest('root', {foo: '^1'}),
            manifest('child', {}, 'packages/child')
        ]);
        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({}));
        const row = matrix.rows[0];
        expect(row.cells['root']).toBeDefined();
        expect(row.cells['packages/child']).toBeUndefined();
    });

    it('handles a single-manifest project (only the root column)', async () => {
        const project = new FakeProject('p', [manifest('root', {foo: '^1.0.0'})]);
        const matrix = await ProjectMatrixBuilder.build('UNID', project, new FakeRegistry({}));
        expect(matrix.workspaces).toEqual([{label: 'root'}]);
        expect(matrix.rows).toHaveLength(1);
    });
});