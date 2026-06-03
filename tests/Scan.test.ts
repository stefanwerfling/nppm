import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BundlephobiaFetcher} from '../Bundle/BundlephobiaFetcher.js';
import {JsonCache} from '../Cache/JsonCache.js';
import {ConfigProjectType} from '../Config/Config.js';
import {LoadedConfig} from '../Config/ConfigLoader.js';
import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {Lockfile} from '../Project/Lockfile.js';
import {Project} from '../Project/Project.js';
import {PackageManifest} from '../Project/PackageManifest.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {Registry} from '../Registry/Registry.js';
import {DepsDevFetcher} from '../Security/External/DepsDevFetcher.js';
import {OpenSsfFetcher} from '../Security/External/OpenSsfFetcher.js';
import {SocketDevFetcher} from '../Security/External/SocketDevFetcher.js';
import {ExternalSourcesScanner} from '../Security/ExternalSourcesScanner.js';
import {OsvClient} from '../Security/OsvClient.js';
import {SecurityScanner} from '../Security/SecurityScanner.js';
import {UnusedDetector, UnusedFs} from '../Unused/UnusedDetector.js';
import {runScan, RunScanIO} from '../Cli/Scan.js';

/**
 * Buffered IO captures so each test can assert on the exact bytes
 * written to stdout/stderr. Helpers also supply the cwd + argv shape
 * `runScan` expects.
 */
function makeIO(overrides: Partial<RunScanIO> & Pick<RunScanIO, 'argv'>): RunScanIO & {
    out: () => string;
    err: () => string;
} {
    const outBuf: string[] = [];
    const errBuf: string[] = [];
    const io = {
        argv: overrides.argv,
        cwd: overrides.cwd ?? '/nonexistent',
        stdout: (s: string) => outBuf.push(s),
        stderr: (s: string) => errBuf.push(s),
        configOverride: overrides.configOverride,
        environmentOverride: overrides.environmentOverride
    };
    return Object.assign(io, {
        out: () => outBuf.join(''),
        err: () => errBuf.join('')
    });
}

/**
 * Minimal `ProjectLocal` test subclass — same trick as the one in
 * `UnusedDetector.test.ts`. Keeps the `instanceof ProjectLocal` check
 * happy so the detector takes the supported path; lets us hand it
 * crafted manifests and an empty lockfile without disk I/O.
 */
class FakeLocalProject extends ProjectLocal {
    private readonly _manifests: PackageManifest[];
    private readonly _lockfile: Lockfile|null;

    constructor(root: string, name: string, manifests: PackageManifest[], lockfile: Lockfile|null = null) {
        super(root, name);
        this._manifests = manifests;
        this._lockfile = lockfile;
    }

    public async loadManifests(): Promise<PackageManifest[]> {
        return this._manifests;
    }

    public async loadLockfile(): Promise<Lockfile|null> {
        return this._lockfile;
    }
}

function makeEnvironment(opts: {
    projects: Project[];
    unusedFs?: UnusedFs;
    cacheDir: string;
}): LoadedConfig {
    const registryCache = new JsonCache(path.join(opts.cacheDir, 'registry'), 60);
    const registry = new Registry('https://registry.npmjs.org', registryCache);
    const remoteCache = new JsonCache(path.join(opts.cacheDir, 'remote'), 60);
    const fingerprintCache = new JsonCache(path.join(opts.cacheDir, 'fingerprint'), 60, {permanent: true});
    const fingerprintBuilder = new FingerprintBuilder(fingerprintCache);
    const securityCache = new JsonCache(path.join(opts.cacheDir, 'security'), 60);
    const osvClient = new OsvClient(securityCache);
    const externalScanner = new ExternalSourcesScanner(
        registry,
        new SocketDevFetcher(new JsonCache(path.join(opts.cacheDir, 'external-socket'), 60)),
        new OpenSsfFetcher(new JsonCache(path.join(opts.cacheDir, 'external-openssf'), 60)),
        new DepsDevFetcher(new JsonCache(path.join(opts.cacheDir, 'external-depsdev'), 60)),
        {enabled: false}
    );
    const securityScanner = new SecurityScanner(osvClient, fingerprintBuilder, registry, {external: externalScanner});
    const unusedDetector = new UnusedDetector({}, opts.unusedFs);
    const bundleCache = new JsonCache(path.join(opts.cacheDir, 'bundlephobia'), 60, {permanent: true});
    const bundlephobiaFetcher = new BundlephobiaFetcher(bundleCache);

    return {
        projectRoot: opts.cacheDir,
        cacheDir: opts.cacheDir,
        cacheTtlMinutes: 60,
        registry,
        registryCache,
        remoteCache,
        fingerprintCache,
        fingerprintBuilder,
        osvClient,
        securityCache,
        securityScanner,
        unusedDetector,
        bundlephobiaFetcher,
        allowInstall: false,
        editor: undefined,
        projects: opts.projects,
        externalScanner
    };
}

function makeFs(files: Record<string, string>): UnusedFs {
    return {
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
        readdirSync: (p) => {
            const prefix = `${p}/`;
            const out = new Set<string>();
            for (const k of Object.keys(files)) {
                if (k.startsWith(prefix)) {
                    out.add(k.slice(prefix.length).split('/')[0]);
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

function emptyManifest(name: string, deps: Record<string, string> = {}): PackageManifest {
    return {
        name,
        version: '1.0.0',
        scripts: {},
        dependencies: Object.entries(deps).map(([n, v]) => ({
            name: n,
            version: v,
            type: 'dependency' as PackageManifest['dependencies'][number]['type']
        }))
    };
}

describe('runScan — surface behaviour', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-scan-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('exits 0 and prints help on --help', async () => {
        const io = makeIO({argv: ['--help'], cwd: tmp});
        const code = await runScan(io);
        expect(code).toBe(0);
        expect(io.out()).toMatch(/nppm scan/);
    });

    it('exits 2 with usage when the config is missing', async () => {
        const io = makeIO({argv: [], cwd: tmp});
        const code = await runScan(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/config file not found/);
    });

    it('exits 2 when the config fails schema validation', async () => {
        const io = makeIO({
            argv: [],
            cwd: tmp,
            configOverride: {projects: 'not-an-array'}
        });
        const code = await runScan(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/invalid structure/);
    });

    it('exits 2 when --project filter matches nothing', async () => {
        const env = makeEnvironment({
            projects: [new FakeLocalProject('/p', 'alpha', [emptyManifest('alpha')])],
            unusedFs: makeFs({'/p': '<dir>'}),
            cacheDir: tmp
        });
        const io = makeIO({
            argv: ['--project=ghost'],
            cwd: tmp,
            environmentOverride: env
        });
        const code = await runScan(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/no projects matched/);
    });

    it('exits 0 on a clean environment with no projects', async () => {
        const env = makeEnvironment({
            projects: [],
            cacheDir: tmp
        });
        const io = makeIO({argv: ['--json'], cwd: tmp, environmentOverride: env});
        const code = await runScan(io);
        expect(code).toBe(0);
        const parsed = JSON.parse(io.out());
        expect(parsed.summary.totalProjects).toBe(0);
        expect(parsed.summary.maxSeverity).toBeNull();
    });

    it('exits 1 when unused findings reach the risk threshold', async () => {
        // Project declares `dangling-dep` but no source file imports
        // it → unused/risk → breach `--fail-on=risk`.
        const project = new FakeLocalProject(
            '/p',
            'alpha',
            [emptyManifest('alpha', {'dangling-dep': '^1.0.0'})]
        );
        const env = makeEnvironment({
            projects: [project],
            unusedFs: makeFs({
                '/p': '<dir>',
                '/p/src': '<dir>',
                '/p/src/index.ts': '// no imports\n'
            }),
            cacheDir: tmp
        });
        const io = makeIO({argv: ['--fail-on=risk'], cwd: tmp, environmentOverride: env});
        const code = await runScan(io);
        expect(code).toBe(1);
        expect(io.out()).toMatch(/Result: FAIL/);
    });

    it('--fail-on=none never trips the gate', async () => {
        const project = new FakeLocalProject(
            '/p',
            'alpha',
            [emptyManifest('alpha', {'dangling-dep': '^1.0.0'})]
        );
        const env = makeEnvironment({
            projects: [project],
            unusedFs: makeFs({
                '/p': '<dir>',
                '/p/src': '<dir>',
                '/p/src/index.ts': '// no imports\n'
            }),
            cacheDir: tmp
        });
        const io = makeIO({argv: ['--fail-on=none'], cwd: tmp, environmentOverride: env});
        const code = await runScan(io);
        expect(code).toBe(0);
    });

    it('--json emits a parseable payload to stdout and nothing to stderr', async () => {
        const env = makeEnvironment({
            projects: [],
            cacheDir: tmp
        });
        const io = makeIO({argv: ['--json'], cwd: tmp, environmentOverride: env});
        const code = await runScan(io);
        expect(code).toBe(0);
        expect(() => JSON.parse(io.out())).not.toThrow();
        expect(io.err()).toBe('');
    });

    it('--sarif emits a SARIF 2.1.0 envelope to stdout', async () => {
        const env = makeEnvironment({
            projects: [],
            cacheDir: tmp
        });
        const io = makeIO({argv: ['--sarif'], cwd: tmp, environmentOverride: env});
        const code = await runScan(io);
        expect(code).toBe(0);
        const parsed = JSON.parse(io.out());
        expect(parsed.version).toBe('2.1.0');
        expect(parsed.runs[0].tool.driver.name).toBe('nppm');
        expect(io.err()).toBe('');
    });

    it('--project filter scans only matching projects', async () => {
        const projects = [
            new FakeLocalProject('/p/a', 'alpha', [emptyManifest('alpha')]),
            new FakeLocalProject('/p/b', 'beta', [emptyManifest('beta')])
        ];
        const env = makeEnvironment({
            projects,
            unusedFs: makeFs({'/p/a': '<dir>', '/p/b': '<dir>'}),
            cacheDir: tmp
        });
        const io = makeIO({
            argv: ['--project=alpha', '--json', '--fail-on=none'],
            cwd: tmp,
            environmentOverride: env
        });
        await runScan(io);
        const parsed = JSON.parse(io.out());
        expect(parsed.projects).toHaveLength(1);
        expect(parsed.projects[0].project.name).toBe('alpha');
    });

    it('rejects --json + --sarif at the argument layer', async () => {
        const io = makeIO({argv: ['--json', '--sarif'], cwd: tmp});
        const code = await runScan(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/mutually exclusive/);
    });

    it('loads a config from disk and runs against an empty project list', async () => {
        const configPath = path.join(tmp, 'nppm.json');
        fs.writeFileSync(configPath, JSON.stringify({projects: []}));
        const io = makeIO({argv: ['--json'], cwd: tmp});
        const code = await runScan(io);
        expect(code).toBe(0);
        const parsed = JSON.parse(io.out());
        expect(parsed.summary.totalProjects).toBe(0);
    });
});