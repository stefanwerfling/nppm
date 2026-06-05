import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {ConfigProjectType} from '../backend/Config/Config.js';
import {DepGraphBuilder} from '../backend/DepGraph/DepGraphBuilder.js';
import {Lockfile, LockedPackage} from '../backend/Project/Lockfile.js';
import {DependencyType, PackageManifest} from '../backend/Project/PackageManifest.js';
import {Project} from '../backend/Project/Project.js';
import {Registry, RegistryPackage} from '../backend/Registry/Registry.js';

class FakeProject implements Project {
    constructor(
        private readonly _manifests: PackageManifest[],
        private readonly _lockfile: Lockfile|null
    ) {}
    public getName() {
        return 'fake';
    }
    public getKey() {
        return 'local:fake';
    }
    public getType() {
        return ConfigProjectType.local;
    }
    public async loadManifests() {
        return this._manifests;
    }
    public async loadLockfile() {
        return this._lockfile;
    }
    public isHidden() { return false; }
    public setHidden(_v: boolean) {}
    public getConfigIndex() { return -1; }
    public getTemplates() { return []; }
}

class FakeRegistry extends Registry {
    constructor(private readonly _data: Record<string, RegistryPackage|null>, dir: string) {
        super('unused', new JsonCache(dir, 60));
    }
    public async fetchOne(name: string) {
        return this._data[name] ?? null;
    }
    public async fetchMany(names: string[]) {
        const out = new Map<string, RegistryPackage|null>();
        for (const n of new Set(names)) {
            out.set(n, this._data[n] ?? null);
        }
        return out;
    }
}

function pkg(name: string, version: string, opts: Partial<LockedPackage> = {}): LockedPackage {
    return {
        name,
        version,
        path: opts.path ?? `node_modules/${name}`,
        dev: false,
        optional: false,
        peer: false,
        deps: {},
        peerDeps: {},
        optionalDeps: {},
        ...opts
    };
}

describe('DepGraphBuilder.build', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-dg-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns null when the project has no lockfile AND no manifests', async () => {
        const project = new FakeProject([], null);
        const graph = await DepGraphBuilder.build('UNID', project, new FakeRegistry({}, dir), new JsonCache(dir, 60));
        expect(graph).toBeNull();
    });

    it('falls back to the manifest when no lockfile is present (remote projects without committed package-lock.json)', async () => {
        // Models a github-hosted project that committed package.json
        // but not the lockfile. The graph should still surface the
        // declared top-level deps so the Tree view is not empty.
        const project = new FakeProject(
            [{
                name: 'root',
                version: '1.0.0',
                dependencies: [
                    {name: 'foo', version: '^1.0.0', type: DependencyType.dependency, workspace: undefined},
                    {name: 'bar', version: '^2.0.0', type: DependencyType.dev, workspace: undefined}
                ],
                scripts: {}
            }],
            null
        );
        const graph = await DepGraphBuilder.build('UNID', project, new FakeRegistry({
            foo: {name: 'foo', latest: '1.2.3', versions: ['1.2.3']},
            bar: {name: 'bar', latest: '2.0.0', versions: ['2.0.0']}
        }, dir), new JsonCache(dir, 60));

        expect(graph).not.toBeNull();
        expect(graph!.fromManifestOnly).toBe(true);
        expect(graph!.rootDeps).toEqual([
            {name: 'foo', version: '^1.0.0'},
            {name: 'bar', version: '^2.0.0'}
        ]);
        // Nodes carry the registry latest and no transitive deps.
        expect(graph!.packages['foo@^1.0.0'].latestVersion).toBe('1.2.3');
        expect(graph!.packages['foo@^1.0.0'].deps).toEqual([]);
        expect(graph!.packages['bar@^2.0.0'].latestVersion).toBe('2.0.0');
        expect(graph!.packages['bar@^2.0.0'].deps).toEqual([]);
    });

    it('resolves root deps to hoisted lockfile entries', async () => {
        const project = new FakeProject(
            [{
                name: 'root',
                version: '1.0.0',
                dependencies: [
                    {name: 'foo', version: '^1', type: DependencyType.dependency, workspace: undefined}
                ],
                scripts: {}
            }],
            {
                lockfileVersion: 3,
                source: 'committed',
                packages: [pkg('foo', '1.2.3', {deps: {bar: '^2'}}), pkg('bar', '2.0.0')]
            }
        );

        const graph = await DepGraphBuilder.build('UNID', project, new FakeRegistry({}, dir), new JsonCache(dir, 60));
        expect(graph!.rootDeps).toEqual([{name: 'foo', version: '1.2.3'}]);
        expect(graph!.packages['foo@1.2.3'].deps).toEqual([{name: 'bar', version: '2.0.0'}]);
    });

    it('uses nested node_modules when both nested and hoisted exist', async () => {
        const project = new FakeProject(
            [{name: 'root', version: '1.0.0', dependencies: [], scripts: {}}],
            {
                lockfileVersion: 3,
                source: 'committed',
                packages: [
                    pkg('a', '1.0.0', {path: 'node_modules/a', deps: {b: '^1'}}),
                    pkg('b', '1.0.0', {path: 'node_modules/b'}),
                    // nested b at 2.0.0 underneath a — should win over hoisted 1.0.0
                    pkg('b', '2.0.0', {path: 'node_modules/a/node_modules/b'})
                ]
            }
        );

        const graph = await DepGraphBuilder.build('UNID', project, new FakeRegistry({}, dir), new JsonCache(dir, 60));
        expect(graph!.packages['a@1.0.0'].deps).toEqual([{name: 'b', version: '2.0.0'}]);
    });

    it('emits empty-version placeholders for unresolved deps', async () => {
        const project = new FakeProject(
            [{name: 'root', version: '1.0.0', dependencies: [], scripts: {}}],
            {
                lockfileVersion: 3,
                source: 'committed',
                packages: [pkg('a', '1.0.0', {peerDeps: {missing: '*'}})]
            }
        );

        const graph = await DepGraphBuilder.build('UNID', project, new FakeRegistry({}, dir), new JsonCache(dir, 60));
        expect(graph!.packages['a@1.0.0'].deps).toEqual([{name: 'missing', version: ''}]);
    });

    it('marks status from CVE cache and registry latest', async () => {
        const project = new FakeProject(
            [{name: 'root', version: '1.0.0', dependencies: [], scripts: {}}],
            {
                lockfileVersion: 3,
                source: 'committed',
                packages: [
                    pkg('clean', '1.0.0'),
                    pkg('outdated', '1.0.0'),
                    pkg('vulnerable', '1.0.0'),
                    pkg('unknown', '1.0.0')
                ]
            }
        );

        const osvCache = new JsonCache(dir, 60);
        osvCache.set('osv_vulnerable@1.0.0', {data: [{id: 'GHSA-xxx'}]});

        const registry = new FakeRegistry(
            {
                clean: {name: 'clean', latest: '1.0.0', versions: ['1.0.0']},
                outdated: {name: 'outdated', latest: '2.0.0', versions: ['1.0.0', '2.0.0']},
                vulnerable: {name: 'vulnerable', latest: '1.0.0', versions: ['1.0.0']},
                unknown: null
            },
            dir
        );

        const graph = await DepGraphBuilder.build('UNID', project, registry, osvCache);
        expect(graph!.packages['clean@1.0.0'].status).toBe('aligned');
        expect(graph!.packages['outdated@1.0.0'].status).toBe('outdated');
        expect(graph!.packages['vulnerable@1.0.0'].status).toBe('cve');
        expect(graph!.packages['vulnerable@1.0.0'].vulnCount).toBe(1);
        expect(graph!.packages['unknown@1.0.0'].status).toBe('unknown');
    });
});