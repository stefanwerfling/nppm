import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DependencyType} from '../Project/PackageManifest.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';

describe('ProjectLocal', () => {
    let root: string;

    const writePkg = (rel: string, body: unknown): void => {
        const dir = path.join(root, rel);
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify(body)
        );
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-project-'));
    });

    afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true});
    });

    it('throws if the root has no package.json', async () => {
        const project = new ProjectLocal(root, 'empty');
        await expect(project.loadManifests()).rejects.toThrow(/package.json not found/);
    });

    it('loads the root manifest and splits deps into typed buckets', async () => {
        writePkg('.', {
            name: 'root',
            version: '1.0.0',
            dependencies: {a: '^1', b: '^2'},
            devDependencies: {c: '^3'},
            peerDependencies: {d: '^4'},
            optionalDependencies: {e: '^5'}
        });

        const project = new ProjectLocal(root, 'root');
        const manifests = await project.loadManifests();

        expect(manifests).toHaveLength(1);
        const deps = manifests[0].dependencies;
        const byType = Object.fromEntries(
            Object.values(DependencyType).map((t) => [
                t,
                deps.filter((d) => d.type === t).map((d) => d.name).sort()
            ])
        );
        expect(byType).toEqual({
            [DependencyType.dependency]: ['a', 'b'],
            [DependencyType.dev]: ['c'],
            [DependencyType.peer]: ['d'],
            [DependencyType.optional]: ['e']
        });
    });

    it('expands packages/* workspaces and tags each manifest', async () => {
        writePkg('.', {
            name: 'root',
            version: '1.0.0',
            workspaces: ['packages/*'],
            dependencies: {shared: '^1'}
        });
        writePkg('packages/api', {
            name: 'api',
            version: '0.1.0',
            dependencies: {express: '^5'}
        });
        writePkg('packages/web', {
            name: 'web',
            version: '0.1.0',
            dependencies: {react: '^19'}
        });

        const project = new ProjectLocal(root, 'mono');
        const manifests = await project.loadManifests();

        const labels = manifests.map((m) => m.workspace ?? 'root').sort();
        expect(labels).toEqual(['packages/api', 'packages/web', 'root']);

        const api = manifests.find((m) => m.workspace === 'packages/api')!;
        expect(api.dependencies.map((d) => d.name)).toEqual(['express']);
        expect(api.dependencies[0].workspace).toBe('packages/api');
    });

    it('accepts the npm `{packages: [...]}` workspaces shape', async () => {
        writePkg('.', {
            name: 'root',
            version: '1.0.0',
            workspaces: {packages: ['sub']}
        });
        writePkg('sub', {name: 'sub', version: '0.0.1'});

        const project = new ProjectLocal(root, 'm');
        const manifests = await project.loadManifests();
        expect(manifests.map((m) => m.workspace ?? 'root').sort()).toEqual(['root', 'sub']);
    });

    it('skips a workspace pattern whose parent does not exist', async () => {
        writePkg('.', {
            name: 'root',
            version: '1.0.0',
            workspaces: ['packages/*']
        });

        const project = new ProjectLocal(root, 'r');
        const manifests = await project.loadManifests();
        expect(manifests).toHaveLength(1);
    });

    it('skips a workspace whose package.json is missing', async () => {
        writePkg('.', {
            name: 'root',
            version: '1.0.0',
            workspaces: ['only-here']
        });
        fs.mkdirSync(path.join(root, 'only-here'));

        const project = new ProjectLocal(root, 'r');
        const manifests = await project.loadManifests();
        expect(manifests).toHaveLength(1);
    });

    it('reports invalid root JSON', async () => {
        fs.writeFileSync(path.join(root, 'package.json'), 'not json');
        const project = new ProjectLocal(root, 'r');
        await expect(project.loadManifests()).rejects.toThrow(/invalid JSON/);
    });
});