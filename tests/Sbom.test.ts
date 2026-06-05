import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BundlephobiaFetcher} from '../backend/Bundle/BundlephobiaFetcher.js';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {LoadedConfig} from '../backend/Config/ConfigLoader.js';
import {FingerprintBuilder} from '../backend/Fingerprint/FingerprintBuilder.js';
import {Lockfile} from '../backend/Project/Lockfile.js';
import {PackageManifest} from '../backend/Project/PackageManifest.js';
import {ProjectLocal} from '../backend/Project/ProjectLocal.js';
import {Project} from '../backend/Project/Project.js';
import {Registry} from '../backend/Registry/Registry.js';
import {DepsDevFetcher} from '../backend/Security/External/DepsDevFetcher.js';
import {OpenSsfFetcher} from '../backend/Security/External/OpenSsfFetcher.js';
import {SocketDevFetcher} from '../backend/Security/External/SocketDevFetcher.js';
import {ExternalSourcesScanner} from '../backend/Security/ExternalSourcesScanner.js';
import {OsvClient} from '../backend/Security/OsvClient.js';
import {SecurityScanner} from '../backend/Security/SecurityScanner.js';
import {UnusedDetector} from '../backend/Unused/UnusedDetector.js';
import {SbomCliArgsError, SbomCliArgsParser, SbomFormat, SbomIO, SbomRunner} from '../Cli/Sbom.js';

class FakeLocalProject extends ProjectLocal {
    private readonly _manifests: PackageManifest[];
    private readonly _lockfile: Lockfile|null;

    constructor(root: string, name: string, manifests: PackageManifest[], lockfile: Lockfile|null) {
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

function makeEnvironment(projects: Project[], cacheDir: string): LoadedConfig {
    const registryCache = new JsonCache(path.join(cacheDir, 'registry'), 60);
    const registry = new Registry('https://registry.npmjs.org', registryCache);
    const remoteCache = new JsonCache(path.join(cacheDir, 'remote'), 60);
    const fingerprintCache = new JsonCache(path.join(cacheDir, 'fingerprint'), 60, {permanent: true});
    const fingerprintBuilder = new FingerprintBuilder(fingerprintCache);
    const securityCache = new JsonCache(path.join(cacheDir, 'security'), 60);
    const osvClient = new OsvClient(securityCache);
    const externalScanner = new ExternalSourcesScanner(
        registry,
        new SocketDevFetcher(new JsonCache(path.join(cacheDir, 'external-socket'), 60)),
        new OpenSsfFetcher(new JsonCache(path.join(cacheDir, 'external-openssf'), 60)),
        new DepsDevFetcher(new JsonCache(path.join(cacheDir, 'external-depsdev'), 60)),
        {enabled: false}
    );
    const securityScanner = new SecurityScanner(osvClient, fingerprintBuilder, registry, {external: externalScanner});
    const unusedDetector = new UnusedDetector({});
    const bundleCache = new JsonCache(path.join(cacheDir, 'bundlephobia'), 60, {permanent: true});
    const bundlephobiaFetcher = new BundlephobiaFetcher(bundleCache);
    return {
        projectRoot: cacheDir,
        cacheDir,
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
        projects,
        externalScanner
    };
}

function makeIO(over: Partial<SbomIO> & Pick<SbomIO, 'argv'>): SbomIO & {out: () => string; err: () => string} {
    const outBuf: string[] = [];
    const errBuf: string[] = [];
    const io = {
        argv: over.argv,
        cwd: over.cwd ?? '/nonexistent',
        stdout: (s: string) => outBuf.push(s),
        stderr: (s: string) => errBuf.push(s),
        configOverride: over.configOverride,
        environmentOverride: over.environmentOverride
    };
    return Object.assign(io, {out: () => outBuf.join(''), err: () => errBuf.join('')});
}

function emptyLockfile(): Lockfile {
    return {lockfileVersion: 3, source: 'committed', packages: []};
}

function emptyManifest(name: string): PackageManifest {
    return {name, version: '1.0.0', scripts: {}, dependencies: []};
}

describe('SbomCliArgsParser', () => {
    it('returns defaults for an empty argv', () => {
        const a = SbomCliArgsParser.parse([]);
        expect(a.configPath).toBe('nppm.json');
        expect(a.project).toBeNull();
        expect(a.format).toBe(SbomFormat.cyclonedx);
        expect(a.output).toBeNull();
        expect(a.help).toBe(false);
    });

    it('accepts both `--key=value` and `--key value`', () => {
        const a = SbomCliArgsParser.parse(['--project=alpha', '--format', 'spdx']);
        expect(a.project).toBe('alpha');
        expect(a.format).toBe(SbomFormat.spdx);
    });

    it('rejects unknown formats', () => {
        expect(() => SbomCliArgsParser.parse(['--format=junit'])).toThrow(SbomCliArgsError);
    });

    it('rejects unknown flags', () => {
        expect(() => SbomCliArgsParser.parse(['--bogus'])).toThrow(SbomCliArgsError);
    });
});

describe('SbomRunner.run', () => {
    let tmp: string;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-sbom-'));
    });
    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('exits 0 and prints help on --help', async () => {
        const io = makeIO({argv: ['--help'], cwd: tmp});
        const code = await SbomRunner.run(io);
        expect(code).toBe(0);
        expect(io.out()).toMatch(/nppm sbom/);
    });

    it('exits 2 when no projects are configured', async () => {
        const env = makeEnvironment([], tmp);
        const io = makeIO({argv: [], cwd: tmp, environmentOverride: env});
        const code = await SbomRunner.run(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/no projects configured/);
    });

    it('exits 2 when more than one project is configured without --project', async () => {
        const env = makeEnvironment([
            new FakeLocalProject('/p/a', 'alpha', [emptyManifest('alpha')], emptyLockfile()),
            new FakeLocalProject('/p/b', 'beta', [emptyManifest('beta')], emptyLockfile())
        ], tmp);
        const io = makeIO({argv: [], cwd: tmp, environmentOverride: env});
        const code = await SbomRunner.run(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/more than one project/);
    });

    it('exits 2 when --project does not match', async () => {
        const env = makeEnvironment([
            new FakeLocalProject('/p/a', 'alpha', [emptyManifest('alpha')], emptyLockfile())
        ], tmp);
        const io = makeIO({argv: ['--project=ghost'], cwd: tmp, environmentOverride: env});
        const code = await SbomRunner.run(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/not found/);
    });

    it('emits CycloneDX to stdout for a single-project setup', async () => {
        const env = makeEnvironment([
            new FakeLocalProject('/p/a', 'alpha', [emptyManifest('alpha')], emptyLockfile())
        ], tmp);
        const io = makeIO({argv: [], cwd: tmp, environmentOverride: env});
        const code = await SbomRunner.run(io);
        expect(code).toBe(0);
        const parsed = JSON.parse(io.out());
        expect(parsed.bomFormat).toBe('CycloneDX');
        expect(parsed.specVersion).toBe('1.6');
    });

    it('emits SPDX with --format=spdx', async () => {
        const env = makeEnvironment([
            new FakeLocalProject('/p/a', 'alpha', [emptyManifest('alpha')], emptyLockfile())
        ], tmp);
        const io = makeIO({argv: ['--format=spdx'], cwd: tmp, environmentOverride: env});
        const code = await SbomRunner.run(io);
        expect(code).toBe(0);
        const parsed = JSON.parse(io.out());
        expect(parsed.spdxVersion).toBe('SPDX-2.3');
    });

    it('writes to --output instead of stdout', async () => {
        const env = makeEnvironment([
            new FakeLocalProject('/p/a', 'alpha', [emptyManifest('alpha')], emptyLockfile())
        ], tmp);
        const outFile = path.join(tmp, 'bom.json');
        const io = makeIO({
            argv: ['--output', outFile],
            cwd: tmp,
            environmentOverride: env
        });
        const code = await SbomRunner.run(io);
        expect(code).toBe(0);
        expect(io.out()).toBe('');
        expect(fs.existsSync(outFile)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
        expect(parsed.bomFormat).toBe('CycloneDX');
    });

    it('loads from disk when no environmentOverride is given', async () => {
        const configPath = path.join(tmp, 'nppm.json');
        fs.writeFileSync(configPath, JSON.stringify({projects: []}));
        const io = makeIO({argv: [], cwd: tmp});
        const code = await SbomRunner.run(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/no projects configured/);
    });

    it('exits 2 when the config is missing', async () => {
        const io = makeIO({argv: [], cwd: tmp});
        const code = await SbomRunner.run(io);
        expect(code).toBe(2);
        expect(io.err()).toMatch(/config file not found/);
    });
});