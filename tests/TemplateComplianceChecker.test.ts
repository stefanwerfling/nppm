import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import {DependencyType, PackageManifest} from '../Project/PackageManifest.js';
import {ResolvedTemplate} from '../Templates/Template.js';
import {TemplateComplianceChecker} from '../Templates/TemplateComplianceChecker.js';

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

describe('TemplateComplianceChecker', () => {
    const checker = new TemplateComplianceChecker();

    it('reports nothing for the empty template', () => {
        const t: ResolvedTemplate = {
            id: '',
            name: '',
            mode: 'additive',
            packages: {runtime: {}, dev: {}, peer: {}, optional: {}},
            forbidden: [],
            root: {},
            files: [],
            workspaces: [],
            sourceIds: []
        };
        const r = checker.check([mkManifest()], t);
        expect(r.findings).toEqual([]);
        expect(r.worst).toBe(null);
    });

    it('flags a missing runtime package as warn', () => {
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5'}};
        const r = checker.check([mkManifest()], t);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('missing');
        expect(r.findings[0].severity).toBe('warn');
        expect(r.findings[0].target).toBe('runtime:express');
    });

    it('escalates missing-but-required to risk', () => {
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5', required: true}};
        const r = checker.check([mkManifest()], t);
        expect(r.findings[0].severity).toBe('risk');
        expect(r.worst).toBe('risk');
    });

    it('flags a divergent version as warn', () => {
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5.1.0'}};
        const m = mkManifest({
            dependencies: [{name: 'express', version: '^4.17.0', type: DependencyType.dependency}]
        });
        const r = checker.check([m], t);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('divergent');
        expect(r.findings[0].expected).toBe('^5.1.0');
        expect(r.findings[0].actual).toBe('^4.17.0');
    });

    it('is silent when versions match exactly', () => {
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5.1.0'}};
        const m = mkManifest({
            dependencies: [{name: 'express', version: '^5.1.0', type: DependencyType.dependency}]
        });
        const r = checker.check([m], t);
        expect(r.findings).toEqual([]);
    });

    it('ignores version drift when the template omits a version', () => {
        const t = emptyResolved();
        t.packages.runtime = {express: {}};
        const m = mkManifest({
            dependencies: [{name: 'express', version: '^5.0.0', type: DependencyType.dependency}]
        });
        const r = checker.check([m], t);
        expect(r.findings).toEqual([]);
    });

    it('flags package in the wrong bucket as bucket-wrong', () => {
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5'}};
        const m = mkManifest({
            // express is declared as dev when the template wants runtime
            dependencies: [{name: 'express', version: '^5', type: DependencyType.dev}]
        });
        const r = checker.check([m], t);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('bucket-wrong');
        expect(r.findings[0].actual).toMatch(/dev/);
    });

    it('flags forbidden packages as risk', () => {
        const t = emptyResolved();
        t.forbidden = ['moment'];
        const m = mkManifest({
            dependencies: [{name: 'moment', version: '^2', type: DependencyType.dependency}]
        });
        const r = checker.check([m], t);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('forbidden');
        expect(r.findings[0].severity).toBe('risk');
    });

    it('is silent on forbidden packages that are absent', () => {
        const t = emptyResolved();
        t.forbidden = ['moment'];
        const r = checker.check([mkManifest()], t);
        expect(r.findings).toEqual([]);
    });

    it('reports extras in strict mode only', () => {
        const additive = emptyResolved();
        const strict = {...emptyResolved(), mode: 'strict' as const};
        const m = mkManifest({
            dependencies: [{name: 'lodash', version: '^4', type: DependencyType.dependency}]
        });
        const r1 = checker.check([m], additive);
        expect(r1.findings).toEqual([]);

        const r2 = checker.check([m], strict);
        expect(r2.findings).toHaveLength(1);
        expect(r2.findings[0].kind).toBe('extra');
        expect(r2.findings[0].severity).toBe('info');
    });

    it('reports root engines drift', () => {
        const t = emptyResolved();
        t.root.engines = {node: '>=20'};
        const r1 = checker.check([mkManifest()], t);
        expect(r1.findings[0].kind).toBe('root-missing');

        const r2 = checker.check([mkManifest({engines: {node: '>=18'}})], t);
        expect(r2.findings[0].kind).toBe('root-divergent');
        expect(r2.findings[0].expected).toBe('>=20');
        expect(r2.findings[0].actual).toBe('>=18');

        const r3 = checker.check([mkManifest({engines: {node: '>=20'}})], t);
        expect(r3.findings).toEqual([]);
    });

    it('reports root scripts drift', () => {
        const t = emptyResolved();
        t.root.scripts = {test: 'vitest'};
        const r = checker.check([mkManifest({scripts: {test: 'jest'}})], t);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('root-divergent');
        expect(r.findings[0].target).toBe('scripts.test');
    });

    it('reports private / type / packageManager drift', () => {
        const t = emptyResolved();
        t.root.private = true;
        t.root.type = 'module';
        t.root.packageManager = 'npm@10';

        const m1 = mkManifest();
        const r1 = checker.check([m1], t);
        expect(r1.findings.map((f) => f.target).sort()).toEqual(['packageManager', 'private', 'type']);
        expect(r1.findings.every((f) => f.kind === 'root-missing')).toBe(true);

        const m2 = mkManifest({isPrivate: false, moduleType: 'commonjs', packageManager: 'pnpm@8'});
        const r2 = checker.check([m2], t);
        expect(r2.findings.every((f) => f.kind === 'root-divergent')).toBe(true);
    });

    it('collapses worst severity correctly across findings', () => {
        const t = emptyResolved();
        t.packages.runtime = {a: {version: '^1', required: true}}; // missing -> risk
        t.packages.dev = {b: {version: '^2'}}; // missing -> warn
        const r = checker.check([mkManifest()], t);
        expect(r.worst).toBe('risk');
    });

    it('matches a workspace-level dep against a template-runtime requirement', () => {
        const t = emptyResolved();
        t.packages.runtime = {express: {version: '^5'}};
        // root has no deps but a workspace declares express
        const root = mkManifest();
        const ws = mkManifest({
            workspace: 'packages/api',
            dependencies: [{name: 'express', version: '^5', type: DependencyType.dependency, workspace: 'packages/api'}]
        });
        const r = checker.check([root, ws], t);
        expect(r.findings).toEqual([]);
    });
});

describe('TemplateComplianceChecker — files', () => {
    const checker = new TemplateComplianceChecker();
    let tmp = '';
    let tplFiles = '';

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-tpl-'));
        tplFiles = path.join(tmp, 'tpl-files');
        fs.mkdirSync(tplFiles, {recursive: true});
        fs.mkdirSync(path.join(tmp, 'project'), {recursive: true});
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('reports missing project file for mode=create', () => {
        const t = emptyResolved();
        fs.writeFileSync(path.join(tplFiles, '.eslintrc.json'), '{"x":1}\n');
        t.files = [{path: '.eslintrc.json', mode: 'create', sourcePath: path.join(tplFiles, '.eslintrc.json')}];
        const r = checker.check([mkManifest()], t, {projectRoot: path.join(tmp, 'project')});
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('file-missing');
        expect(r.findings[0].target).toBe('file:.eslintrc.json');
    });

    it('silent on missing project file for mode=report-only', () => {
        const t = emptyResolved();
        fs.writeFileSync(path.join(tplFiles, '.eslintrc.json'), '{"x":1}\n');
        t.files = [{path: '.eslintrc.json', mode: 'report-only', sourcePath: path.join(tplFiles, '.eslintrc.json')}];
        const r = checker.check([mkManifest()], t, {projectRoot: path.join(tmp, 'project')});
        expect(r.findings).toEqual([]);
    });

    it('reports byte-exact file drift as warn', () => {
        const t = emptyResolved();
        fs.writeFileSync(path.join(tplFiles, '.eslintrc.json'), '{"x":1}\n');
        fs.writeFileSync(path.join(tmp, 'project', '.eslintrc.json'), '{"x":2}\n');
        t.files = [{path: '.eslintrc.json', mode: 'create', sourcePath: path.join(tplFiles, '.eslintrc.json')}];
        const r = checker.check([mkManifest()], t, {projectRoot: path.join(tmp, 'project')});
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('file-drift');
        expect(r.findings[0].severity).toBe('warn');
    });

    it('reports file drift as info when mode=report-only', () => {
        const t = emptyResolved();
        fs.writeFileSync(path.join(tplFiles, '.eslintrc.json'), '{"x":1}\n');
        fs.writeFileSync(path.join(tmp, 'project', '.eslintrc.json'), '{"x":2}\n');
        t.files = [{path: '.eslintrc.json', mode: 'report-only', sourcePath: path.join(tplFiles, '.eslintrc.json')}];
        const r = checker.check([mkManifest()], t, {projectRoot: path.join(tmp, 'project')});
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].severity).toBe('info');
    });

    it('silent when bytes are identical', () => {
        const t = emptyResolved();
        const body = '{"x":1}\n';
        fs.writeFileSync(path.join(tplFiles, '.eslintrc.json'), body);
        fs.writeFileSync(path.join(tmp, 'project', '.eslintrc.json'), body);
        t.files = [{path: '.eslintrc.json', mode: 'create', sourcePath: path.join(tplFiles, '.eslintrc.json')}];
        const r = checker.check([mkManifest()], t, {projectRoot: path.join(tmp, 'project')});
        expect(r.findings).toEqual([]);
    });

    it('flags template source missing as warn drift', () => {
        const t = emptyResolved();
        // Don't create the template file on disk.
        t.files = [{path: '.eslintrc.json', mode: 'create', sourcePath: path.join(tplFiles, 'missing.json')}];
        const r = checker.check([mkManifest()], t, {projectRoot: path.join(tmp, 'project')});
        expect(r.findings[0].kind).toBe('file-missing');
        expect(r.findings[0].actual).toMatch(/template source/);
    });

    it('skips file checks when no projectRoot is provided', () => {
        const t = emptyResolved();
        fs.writeFileSync(path.join(tplFiles, '.eslintrc.json'), '{"x":1}\n');
        t.files = [{path: '.eslintrc.json', mode: 'create', sourcePath: path.join(tplFiles, '.eslintrc.json')}];
        const r = checker.check([mkManifest()], t);
        expect(r.findings).toEqual([]);
    });
});

describe('TemplateComplianceChecker — workspaces', () => {
    const checker = new TemplateComplianceChecker();

    it('reports workspace-missing when the template ws does not exist on the project', () => {
        const t = emptyResolved();
        t.workspaces = [{
            path: 'packages/api',
            sourceId: 'tpl',
            packages: {runtime: {}, dev: {}, peer: {}, optional: {}},
            forbidden: [],
            root: {},
            files: []
        }];
        const r = checker.check([mkManifest()], t);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('workspace-missing');
        expect(r.findings[0].target).toBe('workspace:packages/api');
    });

    it('runs per-workspace package check independent of root deps', () => {
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
        // root has express but the workspace doesn't — workspace
        // contract independently requires it
        const root = mkManifest({
            dependencies: [{name: 'express', version: '^5', type: DependencyType.dependency}]
        });
        const ws = mkManifest({
            workspace: 'packages/api',
            dependencies: []
        });
        const r = checker.check([root, ws], t);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('missing');
        expect(r.findings[0].target).toBe('workspace:packages/api:runtime:express');
    });

    it('matches workspace dep that the ws-level template requires', () => {
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
        const root = mkManifest();
        const ws = mkManifest({
            workspace: 'packages/api',
            dependencies: [{
                name: 'express', version: '^5',
                type: DependencyType.dependency, workspace: 'packages/api'
            }]
        });
        const r = checker.check([root, ws], t);
        expect(r.findings).toEqual([]);
    });

    it('reports ws root-metadata drift', () => {
        const t = emptyResolved();
        t.workspaces = [{
            path: 'packages/api',
            sourceId: 'tpl',
            packages: {runtime: {}, dev: {}, peer: {}, optional: {}},
            forbidden: [],
            root: {scripts: {test: 'vitest'}},
            files: []
        }];
        const ws = mkManifest({
            workspace: 'packages/api',
            scripts: {test: 'jest'}
        });
        const r = checker.check([mkManifest(), ws], t);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].kind).toBe('root-divergent');
        expect(r.findings[0].target).toBe('workspace:packages/api:scripts.test');
    });
});