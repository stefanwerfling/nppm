import {describe, expect, it} from 'vitest';
import {ConfigProjectType} from '../backend/Config/Config.js';
import {ProjectRemote, RemoteCommit} from '../backend/Project/ProjectRemote.js';

/**
 * Minimal test double that fills the abstract transport hooks from
 * in-memory maps. Lets the suite exercise the parsing + workspace
 * logic without any network.
 */
class FakeRemote extends ProjectRemote {

    constructor(
        private readonly _files: Map<string, string>,
        private readonly _dirs: Map<string, string[]>
    ) {
        super('fake');
    }

    public getType(): ConfigProjectType {
        return ConfigProjectType.github;
    }

    public getKey(): string {
        return 'github:fake';
    }

    protected async fetchFile(repoPath: string): Promise<string|null> {
        return this._files.get(repoPath) ?? null;
    }

    protected async listDirectory(repoPath: string): Promise<string[]> {
        return this._dirs.get(repoPath) ?? [];
    }

    public async listCommitsForFile(_repoPath: string): Promise<RemoteCommit[]|null> {
        return [];
    }

    public async fetchFileAtRef(repoPath: string, _ref: string): Promise<string|null> {
        return this._files.get(repoPath) ?? null;
    }

    public async getHeadSha(): Promise<string|null> {
        return null;
    }
}

describe('ProjectRemote', () => {

    it('throws when the root package.json is missing', async () => {
        const r = new FakeRemote(new Map(), new Map());
        await expect(r.loadManifests()).rejects.toThrow(/package.json missing/);
    });

    it('reads the root manifest and splits deps into buckets', async () => {
        const files = new Map<string, string>([
            ['package.json', JSON.stringify({
                name: 'r',
                version: '1.0.0',
                dependencies: {a: '^1'},
                devDependencies: {b: '^2'}
            })]
        ]);

        const r = new FakeRemote(files, new Map());
        const manifests = await r.loadManifests();
        expect(manifests).toHaveLength(1);
        expect(manifests[0].dependencies.map((d) => `${d.name}@${d.type}`).sort())
            .toEqual(['a@dependency', 'b@dev']);
    });

    it('expands packages/* workspaces via listDirectory', async () => {
        const files = new Map<string, string>([
            ['package.json', JSON.stringify({
                name: 'root',
                version: '1.0.0',
                workspaces: ['packages/*']
            })],
            ['packages/a/package.json', JSON.stringify({
                name: 'a',
                version: '0.1.0',
                dependencies: {x: '^1'}
            })],
            ['packages/b/package.json', JSON.stringify({
                name: 'b',
                version: '0.1.0',
                dependencies: {y: '^1'}
            })]
        ]);
        const dirs = new Map<string, string[]>([['packages', ['a', 'b']]]);

        const r = new FakeRemote(files, dirs);
        const manifests = await r.loadManifests();
        expect(manifests.map((m) => m.workspace ?? 'root').sort()).toEqual([
            'packages/a',
            'packages/b',
            'root'
        ]);
    });

    it('silently drops workspaces whose package.json is missing', async () => {
        const files = new Map<string, string>([
            ['package.json', JSON.stringify({
                name: 'root',
                version: '1.0.0',
                workspaces: ['only-here']
            })]
        ]);

        const r = new FakeRemote(files, new Map());
        const manifests = await r.loadManifests();
        expect(manifests).toHaveLength(1);
    });
});