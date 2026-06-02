import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DependencyType, PackageManifest} from '../Project/PackageManifest.js';
import {ResolvedTemplate} from '../Templates/Template.js';
import {TemplateApplier} from '../Templates/TemplateApplier.js';
import {BackupStore} from '../Upgrade/BackupStore.js';

function mkManifest(extras: Partial<PackageManifest> = {}): PackageManifest {
    return {
        name: 'p',
        version: '0.0.0',
        scripts: {},
        dependencies: [],
        ...extras
    };
}

function emptyResolved(): ResolvedTemplate {
    return {
        id: 'tpl',
        name: 'tpl',
        mode: 'additive',
        packages: {runtime: {}, dev: {}, peer: {}, optional: {}},
        forbidden: [],
        root: {},
        files: [],
        workspaces: [],
        sourceIds: ['tpl']
    };
}

describe('TemplateApplier', () => {
    let tmp = '';
    let projectRoot = '';
    let tplFiles = '';
    let backupStore: BackupStore;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-apl-'));
        projectRoot = path.join(tmp, 'project');
        tplFiles = path.join(tmp, 'tpl-files');
        fs.mkdirSync(projectRoot, {recursive: true});
        fs.mkdirSync(tplFiles, {recursive: true});
        backupStore = new BackupStore(path.join(tmp, 'backups'));
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('adds a missing dep to root package.json', () => {
        fs.writeFileSync(path.join(projectRoot, 'package.json'),
            JSON.stringify({name: 'p', dependencies: {}}, null, 2) + '\n');
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5.1.0'}};

        const r = new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest()],
            template: t,
            selectedTargets: ['runtime:express'],
            backupStore
        });
        const written = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        expect(written.dependencies.express).toBe('^5.1.0');
        expect(r.outcomes[0].status).toBe('applied');
    });

    it('updates a divergent version', () => {
        fs.writeFileSync(path.join(projectRoot, 'package.json'),
            JSON.stringify({name: 'p', dependencies: {express: '^4.0.0'}}, null, 2) + '\n');
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5.1.0'}};

        new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest({dependencies: [{name: 'express', version: '^4.0.0', type: DependencyType.dependency}]})],
            template: t,
            selectedTargets: ['runtime:express'],
            backupStore
        });
        const written = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        expect(written.dependencies.express).toBe('^5.1.0');
    });

    it('removes a forbidden dep from package.json', () => {
        fs.writeFileSync(path.join(projectRoot, 'package.json'),
            JSON.stringify({name: 'p', dependencies: {moment: '^2.30.1'}}, null, 2) + '\n');
        const t = emptyResolved();
        t.forbidden = ['moment'];

        new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest()],
            template: t,
            selectedTargets: ['forbidden:moment'],
            backupStore
        });
        const written = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        expect(written.dependencies).toBeUndefined();
    });

    it('moves a dep from the wrong bucket to the expected one', () => {
        fs.writeFileSync(path.join(projectRoot, 'package.json'),
            JSON.stringify({name: 'p', devDependencies: {express: '^5'}}, null, 2) + '\n');
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5.1.0'}};

        new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest()],
            template: t,
            selectedTargets: ['runtime:express'],
            backupStore
        });
        const written = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        expect(written.dependencies.express).toBe('^5.1.0');
        expect(written.devDependencies).toBeUndefined();
    });

    it('sets root metadata (engines.node + private)', () => {
        fs.writeFileSync(path.join(projectRoot, 'package.json'),
            JSON.stringify({name: 'p'}, null, 2) + '\n');
        const t = emptyResolved();
        t.root = {engines: {node: '>=20'}, private: true};

        new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest()],
            template: t,
            selectedTargets: ['engines.node', 'private'],
            backupStore
        });
        const written = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        expect(written.engines).toEqual({node: '>=20'});
        expect(written.private).toBe(true);
    });

    it('copies a missing template file in mode=create', () => {
        fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"p"}\n');
        fs.writeFileSync(path.join(tplFiles, 'eslint.config.js'), '// shared rules\n');
        const t = emptyResolved();
        t.files = [{path: 'eslint.config.js', mode: 'create', sourcePath: path.join(tplFiles, 'eslint.config.js')}];

        new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest()],
            template: t,
            selectedTargets: ['file:eslint.config.js'],
            backupStore
        });
        const written = fs.readFileSync(path.join(projectRoot, 'eslint.config.js'), 'utf-8');
        expect(written).toBe('// shared rules\n');
    });

    it('does not overwrite present-but-drifted files in mode=create', () => {
        fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"p"}\n');
        fs.writeFileSync(path.join(projectRoot, 'eslint.config.js'), '// local\n');
        fs.writeFileSync(path.join(tplFiles, 'eslint.config.js'), '// shared\n');
        const t = emptyResolved();
        t.files = [{path: 'eslint.config.js', mode: 'create', sourcePath: path.join(tplFiles, 'eslint.config.js')}];

        const r = new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest()],
            template: t,
            selectedTargets: ['file:eslint.config.js'],
            backupStore
        });
        const written = fs.readFileSync(path.join(projectRoot, 'eslint.config.js'), 'utf-8');
        expect(written).toBe('// local\n');
        expect(r.outcomes[0].status).toBe('skipped');
    });

    it('deep-merges json files in mode=merge-json', () => {
        fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"p"}\n');
        fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'),
            JSON.stringify({compilerOptions: {strict: false, target: 'ES2020'}}, null, 2) + '\n');
        fs.writeFileSync(path.join(tplFiles, 'tsconfig.json'),
            JSON.stringify({compilerOptions: {strict: true, module: 'ESNext'}}, null, 2) + '\n');

        const t = emptyResolved();
        t.files = [{path: 'tsconfig.json', mode: 'merge-json', sourcePath: path.join(tplFiles, 'tsconfig.json')}];

        new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest()],
            template: t,
            selectedTargets: ['file:tsconfig.json'],
            backupStore
        });

        const written = JSON.parse(fs.readFileSync(path.join(projectRoot, 'tsconfig.json'), 'utf-8'));
        // Template wins on conflicts, project keys survive otherwise.
        expect(written).toEqual({compilerOptions: {strict: true, target: 'ES2020', module: 'ESNext'}});
    });

    it('snapshots affected files into the backup store before mutating', () => {
        const pkgPath = path.join(projectRoot, 'package.json');
        const before = JSON.stringify({name: 'p', dependencies: {express: '^4'}}, null, 2) + '\n';
        fs.writeFileSync(pkgPath, before);
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5'}};

        const r = new TemplateApplier().apply({
            projectRoot,
            manifests: [mkManifest({dependencies: [{name: 'express', version: '^4', type: DependencyType.dependency}]})],
            template: t,
            selectedTargets: ['runtime:express'],
            backupStore
        });
        expect(r.backup).not.toBeNull();
        const backupPkg = path.join(r.backup!.dir, 'package.json');
        expect(fs.readFileSync(backupPkg, 'utf-8')).toBe(before);
    });

    it('writes to workspace package.json for workspace-scoped targets', () => {
        const rootPkg = path.join(projectRoot, 'package.json');
        const wsPkg = path.join(projectRoot, 'packages', 'api', 'package.json');
        fs.writeFileSync(rootPkg, JSON.stringify({name: 'p'}, null, 2) + '\n');
        fs.mkdirSync(path.dirname(wsPkg), {recursive: true});
        fs.writeFileSync(wsPkg, JSON.stringify({name: 'api', dependencies: {}}, null, 2) + '\n');

        const t = emptyResolved();
        t.workspaces = [{
            path: 'packages/api',
            sourceId: 'tpl',
            packages: {
                runtime: {express: {version: '^5'}},
                dev: {}, peer: {}, optional: {}
            },
            forbidden: [],
            root: {},
            files: []
        }];

        new TemplateApplier().apply({
            projectRoot,
            manifests: [
                mkManifest(),
                mkManifest({workspace: 'packages/api'})
            ],
            template: t,
            selectedTargets: ['workspace:packages/api:runtime:express'],
            backupStore
        });

        const written = JSON.parse(fs.readFileSync(wsPkg, 'utf-8'));
        expect(written.dependencies.express).toBe('^5');
        const rootStillEmpty = JSON.parse(fs.readFileSync(rootPkg, 'utf-8'));
        expect(rootStillEmpty.dependencies).toBeUndefined();
    });
});