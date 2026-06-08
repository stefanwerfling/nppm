import {describe, expect, it} from 'vitest';
import {Lockfile} from '../backend/Project/Lockfile.js';
import {PackageManifest} from '../backend/Project/PackageManifest.js';
import {ProjectLocal} from '../backend/Project/ProjectLocal.js';
import {SourceGraphBuilder, SourceGraphFs} from '../backend/SourceGraph/SourceGraphBuilder.js';

class TestLocalProject extends ProjectLocal {

    private readonly _manifests: PackageManifest[];

    constructor(root: string, manifests: PackageManifest[] = []) {
        super(root, 'fixture');
        this._manifests = manifests;
    }

    public async loadManifests(): Promise<PackageManifest[]> {
        return this._manifests;
    }

    public async loadLockfile(): Promise<Lockfile|null> {
        return null;
    }

}

function workspaceManifest(name: string, workspace: string): PackageManifest {
    return {
        name: name,
        version: '1.0.0',
        workspace: workspace,
        scripts: {},
        dependencies: []
    };
}

/**
 * In-memory `SourceGraphFs`. Same `<dir>` magic marker convention as
 * `tests/UnusedDetector.test.ts`.
 */
function makeFs(files: Record<string, string>): SourceGraphFs {
    return {
        existsSync: (p) => Object.hasOwn(files, p),
        readdirSync: (p) => {
            const prefix = `${p}/`;
            const out = new Set<string>();
            for (const key of Object.keys(files)) {
                if (key.startsWith(prefix)) {
                    out.add(key.slice(prefix.length).split('/')[0]);
                }
            }
            return Array.from(out);
        },
        readFileSync: (p) => {
            const v = files[p];
            if (v === undefined || v === '<dir>') {
                throw new Error(`ENOENT: ${p}`);
            }
            return v;
        },
        statSync: (p) => ({
            isDirectory: () => files[p] === '<dir>',
            isFile: () => files[p] !== undefined && files[p] !== '<dir>',
            mtimeMs: 0
        })
    };
}

describe('SourceGraphBuilder.build', () => {
    const ROOT = '/p';

    it('resolves a simple relative import to a node + edge', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]: 'import {a} from \'./util.js\';\n',
            [`${ROOT}/src/util.ts`]: 'export const a = 1;\n'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        expect(data.supported).toBe(true);
        expect(data.files.map((f) => f.id).sort()).toEqual(['src/index.ts', 'src/util.ts']);
        expect(data.edges).toHaveLength(1);
        expect(data.edges[0]).toEqual({from: 'src/index.ts', to: 'src/util.ts'});
    });

    it('classifies test, config, and entry files by name', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/main.ts`]: '',
            [`${ROOT}/vite.config.ts`]: '',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/Foo.test.ts`]: '',
            [`${ROOT}/src/Foo.ts`]: ''
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        const kindOf = (id: string): string|undefined =>
            data.files.find((f) => f.id === id)?.kind;
        expect(kindOf('main.ts')).toBe('entry');
        expect(kindOf('vite.config.ts')).toBe('config');
        expect(kindOf('src/Foo.test.ts')).toBe('test');
        expect(kindOf('src/Foo.ts')).toBe('source');
    });

    it('falls back to TS when the import spec ends in .js', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: 'import {b} from \'./b.js\';\n',
            [`${ROOT}/src/b.ts`]: 'export const b = 2;\n'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        expect(data.edges).toEqual([{from: 'src/a.ts', to: 'src/b.ts'}]);
    });

    it('resolves a directory import to its index file', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: 'import {c} from \'./c\';\n',
            [`${ROOT}/src/c`]: '<dir>',
            [`${ROOT}/src/c/index.ts`]: 'export const c = 3;\n'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        expect(data.edges).toEqual([{from: 'src/a.ts', to: 'src/c/index.ts'}]);
    });

    it('ignores bare specifiers (npm package deps) — no edge', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: 'import {z} from \'lodash\';\n'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        expect(data.edges).toEqual([]);
        expect(data.files.map((f) => f.id)).toEqual(['src/a.ts']);
    });

    it('counts a dynamic variable import() as unresolved', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: 'const m = await import(name);\n'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        expect(data.unresolved).toBeGreaterThan(0);
        expect(data.edges).toEqual([]);
    });

    it('counts a relative import to a missing file as unresolved', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: 'import \'./does-not-exist\';\n'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        expect(data.unresolved).toBe(1);
        expect(data.edges).toEqual([]);
    });

    it('bridges a bare-specifier import into the matching workspace entry file', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/packages`]: '<dir>',
            [`${ROOT}/packages/api`]: '<dir>',
            [`${ROOT}/packages/api/src`]: '<dir>',
            [`${ROOT}/packages/api/src/index.ts`]:
                'import {x} from \'@swipe/shared\';\nexport {x};\n',
            [`${ROOT}/packages/shared`]: '<dir>',
            [`${ROOT}/packages/shared/src`]: '<dir>',
            [`${ROOT}/packages/shared/src/index.ts`]: 'export const x = 1;\n'
        }));

        const project = new TestLocalProject(ROOT, [
            workspaceManifest('@swipe/api', 'packages/api'),
            workspaceManifest('@swipe/shared', 'packages/shared')
        ]);

        const data = await builder.build(project);

        expect(data.edges).toContainEqual({
            from: 'packages/api/src/index.ts',
            to: 'packages/shared/src/index.ts'
        });
    });

    it('bridges a sub-path workspace import', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/packages`]: '<dir>',
            [`${ROOT}/packages/api`]: '<dir>',
            [`${ROOT}/packages/api/main.ts`]:
                'import {y} from \'@swipe/shared/util/y\';\nexport {y};\n',
            [`${ROOT}/packages/shared`]: '<dir>',
            [`${ROOT}/packages/shared/util`]: '<dir>',
            [`${ROOT}/packages/shared/util/y.ts`]: 'export const y = 2;\n'
        }));

        const project = new TestLocalProject(ROOT, [
            workspaceManifest('@swipe/api', 'packages/api'),
            workspaceManifest('@swipe/shared', 'packages/shared')
        ]);

        const data = await builder.build(project);

        expect(data.edges).toContainEqual({
            from: 'packages/api/main.ts',
            to: 'packages/shared/util/y.ts'
        });
    });

    it('traces a named import through a barrel re-export to the defining file', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/packages`]: '<dir>',
            [`${ROOT}/packages/api`]: '<dir>',
            [`${ROOT}/packages/api/src`]: '<dir>',
            [`${ROOT}/packages/api/src/main.ts`]:
                'import {Appointment} from \'@swipe/schemas\';\nexport {Appointment};\n',
            [`${ROOT}/packages/schemas`]: '<dir>',
            [`${ROOT}/packages/schemas/src`]: '<dir>',
            [`${ROOT}/packages/schemas/src/index.ts`]:
                'export {Appointment} from \'./Models/Appointment.js\';\nexport {User} from \'./Models/User.js\';\n',
            [`${ROOT}/packages/schemas/src/Models`]: '<dir>',
            [`${ROOT}/packages/schemas/src/Models/Appointment.ts`]: 'export class Appointment {}\n',
            [`${ROOT}/packages/schemas/src/Models/User.ts`]: 'export class User {}\n'
        }));

        const project = new TestLocalProject(ROOT, [
            workspaceManifest('@swipe/api', 'packages/api'),
            workspaceManifest('@swipe/schemas', 'packages/schemas')
        ]);

        const data = await builder.build(project);

        // Edge goes to Appointment.ts, NOT to schemas/src/index.ts.
        expect(data.edges).toContainEqual({
            from: 'packages/api/src/main.ts',
            to: 'packages/schemas/src/Models/Appointment.ts'
        });
        // The barrel itself is not the named-import target.
        expect(data.edges).not.toContainEqual({
            from: 'packages/api/src/main.ts',
            to: 'packages/schemas/src/index.ts'
        });
    });

    it('falls back to the entry file for a default import (no symbol info)', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/packages`]: '<dir>',
            [`${ROOT}/packages/api`]: '<dir>',
            [`${ROOT}/packages/api/main.ts`]:
                'import App from \'@swipe/schemas\';\nexport {App};\n',
            [`${ROOT}/packages/schemas`]: '<dir>',
            [`${ROOT}/packages/schemas/src`]: '<dir>',
            [`${ROOT}/packages/schemas/src/index.ts`]:
                'export {default} from \'./Default.js\';\n',
            [`${ROOT}/packages/schemas/src/Default.ts`]: 'export default class App {}\n'
        }));

        const project = new TestLocalProject(ROOT, [
            workspaceManifest('@swipe/api', 'packages/api'),
            workspaceManifest('@swipe/schemas', 'packages/schemas')
        ]);

        const data = await builder.build(project);

        expect(data.edges).toContainEqual({
            from: 'packages/api/main.ts',
            to: 'packages/schemas/src/index.ts'
        });
    });

    it('still ignores bare specifiers that do not match a workspace', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: 'import {x} from \'lodash\';\n'
        }));

        const project = new TestLocalProject(ROOT, [
            workspaceManifest('@swipe/shared', 'packages/shared')
        ]);

        const data = await builder.build(project);

        expect(data.edges).toEqual([]);
        expect(data.unresolved).toBe(0);
    });

    it('counts functions, classes, todos and complexity per file', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: [
                '// TODO: revisit later',
                'export class Foo {}',
                'export class Bar {}',
                'export function baz() {',
                '    if (x) return 1;',
                '    for (let i = 0; i < 10; i++) {}',
                '    return x && y || z;',
                '}',
                'export const fn = () => x ? 1 : 2;'
            ].join('\n')
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        const a = data.files[0];
        expect(a.classes).toBe(2);
        expect(a.functions).toBeGreaterThanOrEqual(2); // baz + fn arrow
        expect(a.todos).toBe(1);
        // 1 base + if + for + && + || + ?: = 6
        expect(a.complexity).toBeGreaterThanOrEqual(5);
    });

    it('flags hasTest when a sibling .test file exists', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/Foo.ts`]: 'export class Foo {}',
            [`${ROOT}/src/Foo.test.ts`]: 'import {Foo} from \'./Foo.js\';\n',
            [`${ROOT}/src/Bar.ts`]: 'export class Bar {}'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        const foo = data.files.find((f) => f.id === 'src/Foo.ts')!;
        const bar = data.files.find((f) => f.id === 'src/Bar.ts')!;
        const fooTest = data.files.find((f) => f.id === 'src/Foo.test.ts')!;
        expect(foo.hasTest).toBe(true);
        expect(bar.hasTest).toBe(false);
        // Test files themselves report false.
        expect(fooTest.hasTest).toBe(false);
    });

    it('hasTest also catches the parallel src/ ↔ test/ layout', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/backend`]: '<dir>',
            [`${ROOT}/backend/src`]: '<dir>',
            [`${ROOT}/backend/src/Application`]: '<dir>',
            [`${ROOT}/backend/src/Application/OAuth`]: '<dir>',
            [`${ROOT}/backend/src/Application/OAuth/OAuthState.ts`]: 'export class OAuthState {}',
            [`${ROOT}/backend/test`]: '<dir>',
            [`${ROOT}/backend/test/Application`]: '<dir>',
            [`${ROOT}/backend/test/Application/OAuth`]: '<dir>',
            [`${ROOT}/backend/test/Application/OAuth/OAuthState.test.ts`]: 'import {} from \'../../../src/Application/OAuth/OAuthState.js\';\n'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        const src = data.files.find((f) => f.id === 'backend/src/Application/OAuth/OAuthState.ts')!;
        expect(src.hasTest).toBe(true);
    });

    it('records external npm packages a file imports', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: [
                'import {x} from \'lodash\';',
                'import * as ax from \'axios\';',
                'import {Foo} from \'@scope/pkg/sub\';',
                'import fs from \'node:fs\';',
                'import \'./local.js\';'
            ].join('\n'),
            [`${ROOT}/src/local.ts`]: 'export const x = 1;'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        const a = data.files.find((f) => f.id === 'src/a.ts')!;
        expect(a.externalDeps).toEqual(['@scope/pkg', 'axios', 'lodash']);
    });

    it('exposes per-file re-exports', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]:
                'export {Foo} from \'./Foo.js\';\nexport * from \'./Bar.js\';\n',
            [`${ROOT}/src/Foo.ts`]: 'export class Foo {}',
            [`${ROOT}/src/Bar.ts`]: 'export class Bar {}'
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        const idx = data.files.find((f) => f.id === 'src/index.ts')!;
        expect(idx.reExports.sort()).toEqual(['*', 'Foo']);
    });

    it('skips node_modules and other build directories', async() => {
        const builder = new SourceGraphBuilder(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: '',
            [`${ROOT}/node_modules`]: '<dir>',
            [`${ROOT}/node_modules/lodash`]: '<dir>',
            [`${ROOT}/node_modules/lodash/index.js`]: '',
            [`${ROOT}/dist`]: '<dir>',
            [`${ROOT}/dist/bundle.js`]: ''
        }));

        const data = await builder.build(new TestLocalProject(ROOT));

        expect(data.files.map((f) => f.id)).toEqual(['src/a.ts']);
    });

});