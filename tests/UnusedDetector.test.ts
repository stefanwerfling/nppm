import {describe, expect, it} from 'vitest';
import {DependencyType, PackageManifest} from '../backend/Project/PackageManifest.js';
import {ProjectLocal} from '../backend/Project/ProjectLocal.js';
import {Lockfile} from '../backend/Project/Lockfile.js';
import {ProjectGithub} from '../backend/Project/ProjectGithub.js';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {UnusedDetector, UnusedFs} from '../backend/Unused/UnusedDetector.js';
import {UnusedSeverity} from '../backend/Unused/UnusedReport.js';

/**
 * Lightweight `ProjectLocal` test subclass: keeps the real
 * `instanceof ProjectLocal` check happy but bypasses disk by serving
 * the manifests injected at construction time.
 */
class TestLocalProject extends ProjectLocal {

    private readonly _manifests: PackageManifest[];

    constructor(root: string, manifests: PackageManifest[]) {
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

/**
 * In-memory `UnusedFs`. `<dir>` is the magic marker for directory
 * entries (matches `tests/Lockfile.test.ts`'s `fakeFs` convention).
 */
function makeFs(files: Record<string, string>): UnusedFs {
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
            isFile: () => files[p] !== undefined && files[p] !== '<dir>'
        })
    };
}

function manifest(
    name: string,
    deps: Record<string, DependencyType>,
    workspace?: string,
    scripts: Record<string, string> = {}
): PackageManifest {
    return {
        name: name,
        version: '1.0.0',
        workspace: workspace,
        scripts: scripts,
        dependencies: Object.entries(deps).map(([n, t]) => ({
            name: n,
            version: '^1.0.0',
            type: t,
            workspace: workspace
        }))
    };
}

describe('UnusedDetector.scan', () => {
    const ROOT = '/p';

    it('flags a dep that nothing imports as unused/risk', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]: 'import {a} from \'lodash\';\n'
        }));
        const project = new TestLocalProject(ROOT, [
            manifest('app', {lodash: DependencyType.dependency, unused: DependencyType.dependency})
        ]);

        const report = await detector.scan(project);

        expect(report.supported).toBe(true);
        const names = report.unused.map((u) => u.name);
        expect(names).toContain('unused');
        expect(names).not.toContain('lodash');
        const unusedEntry = report.unused.find((u) => u.name === 'unused')!;
        expect(unusedEntry.severity).toBe(UnusedSeverity.risk);
    });

    it('suppresses a default-allowlisted bin tool to severity=info', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]: '// no imports\n'
        }));
        const project = new TestLocalProject(ROOT, [
            manifest('app', {vite: DependencyType.dev})
        ]);

        const report = await detector.scan(project);

        const vite = report.unused.find((u) => u.name === 'vite')!;
        expect(vite).toBeDefined();
        expect(vite.severity).toBe(UnusedSeverity.info);
        expect(vite.reason).toMatch(/allowlist/);
    });

    it('suppresses a dep referenced from a `scripts:` body', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]: '// no imports\n'
        }));
        const project = new TestLocalProject(ROOT, [
            manifest(
                'app',
                {'my-bin': DependencyType.dev},
                undefined,
                {build: 'my-bin --watch'}
            )
        ]);

        const report = await detector.scan(project);

        const finding = report.unused.find((u) => u.name === 'my-bin')!;
        expect(finding.severity).toBe(UnusedSeverity.info);
        expect(finding.reason).toMatch(/scripts/);
    });

    it('honors the `tsc → typescript` bin alias', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]: ''
        }));
        const project = new TestLocalProject(ROOT, [
            manifest(
                'app',
                {typescript: DependencyType.dev},
                undefined,
                {build: 'tsc -p .'}
            )
        ]);

        const report = await detector.scan(project);

        const ts = report.unused.find((u) => u.name === 'typescript')!;
        expect(ts.severity).toBe(UnusedSeverity.info);
    });

    it('reports a dep only used in dev-paths as misplaced', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/foo.test.ts`]: 'import f from \'devonly\';\n'
        }));
        const project = new TestLocalProject(ROOT, [
            manifest('app', {devonly: DependencyType.dependency})
        ]);

        const report = await detector.scan(project);

        const m = report.misplaced.find((x) => x.name === 'devonly');
        expect(m).toBeDefined();
        expect(m!.firstImport).toBe('src/foo.test.ts');
    });

    it('reports an undeclared import as missing', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]: 'import x from \'leaked-transitive\';\n'
        }));
        const project = new TestLocalProject(ROOT, [
            manifest('app', {})
        ]);

        const report = await detector.scan(project);

        const m = report.missing.find((x) => x.name === 'leaked-transitive');
        expect(m).toBeDefined();
    });

    it('does not report `@types/X` as unused when X is imported', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]: 'import React from \'react\';\n'
        }));
        const project = new TestLocalProject(ROOT, [
            manifest('app', {
                'react': DependencyType.dependency,
                '@types/react': DependencyType.dev
            })
        ]);

        const report = await detector.scan(project);

        const t = report.unused.find((u) => u.name === '@types/react');
        /*
         * @types/react is "unused with severity=info, transitively used"
         * — it stays in the list but is downgraded, not silently dropped.
         */
        expect(t).toBeDefined();
        expect(t!.severity).toBe(UnusedSeverity.info);
        expect(t!.reason).toMatch(/@types/);
    });

    it('flags dynamic `import(varName)` via scanLimits without losing the file', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]:
                'const name = \'lodash\'; const m = await import(name);\n'
        }));
        const project = new TestLocalProject(ROOT, [
            manifest('app', {lodash: DependencyType.dependency})
        ]);

        const report = await detector.scan(project);

        expect(report.scanLimits.length).toBeGreaterThan(0);
        expect(report.scanLimits[0].file).toBe('src/index.ts');
        /*
         * lodash got no static hit, so it shows up as risk (not the
         * dynamic spec's fault we can't see the link).
         */
        const lodash = report.unused.find((u) => u.name === 'lodash')!;
        expect(lodash.severity).toBe(UnusedSeverity.risk);
    });

    it('does not flag a workspace package name as missing', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/apps`]: '<dir>',
            [`${ROOT}/apps/web`]: '<dir>',
            [`${ROOT}/apps/web/index.ts`]: 'import x from \'@scope/api\';\n'
        }));
        const project = new TestLocalProject(ROOT, [
            manifest('@scope/root', {}),
            manifest('@scope/api', {}, 'packages/api'),
            manifest('@scope/web', {}, 'apps/web')
        ]);

        const report = await detector.scan(project);

        expect(report.missing.find((m) => m.name === '@scope/api')).toBeUndefined();
    });

    it('does not flag Node built-ins as missing', async() => {
        const detector = new UnusedDetector({}, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/index.ts`]:
                'import fs from \'fs\';\nimport path from \'node:path\';\n'
        }));
        const project = new TestLocalProject(ROOT, [manifest('app', {})]);

        const report = await detector.scan(project);

        expect(report.missing.find((m) => m.name === 'fs')).toBeUndefined();
        expect(report.missing.find((m) => m.name === 'path')).toBeUndefined();
    });

    it('returns supported:false for remote projects', async() => {
        const detector = new UnusedDetector({}, makeFs({}));
        const cache = new JsonCache('/tmp/nppm-test-unused-remote-cache', 1);
        const remote = new ProjectGithub('owner/repo', 'demo', undefined, undefined, cache);

        const report = await detector.scan(remote);

        expect(report.supported).toBe(false);
        expect(report.unsupportedReason).toBeDefined();
        expect(report.unused).toEqual([]);
        expect(report.misplaced).toEqual([]);
        expect(report.missing).toEqual([]);
    });

    it('honours a user allowlist on top of the default', async() => {
        const detector = new UnusedDetector(
            {allowlist: ['my-custom-cli']},
            makeFs({
                [ROOT]: '<dir>',
                [`${ROOT}/src`]: '<dir>',
                [`${ROOT}/src/index.ts`]: ''
            })
        );
        const project = new TestLocalProject(ROOT, [
            manifest('app', {'my-custom-cli': DependencyType.dev})
        ]);

        const report = await detector.scan(project);

        const f = report.unused.find((u) => u.name === 'my-custom-cli')!;
        expect(f.severity).toBe(UnusedSeverity.info);
    });
});