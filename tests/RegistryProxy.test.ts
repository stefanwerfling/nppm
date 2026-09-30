import {describe, expect, it} from 'vitest';
import {RegistryProxy, TarballStore, UpstreamFetcher} from '../backend/Registry/RegistryProxy.js';

/**
 * In-memory upstream so the proxy is exercised without a network. Each
 * packument mirrors the shape npm serves: `versions[v].dist.{tarball,
 * shasum,integrity}`.
 */
class FakeUpstream implements UpstreamFetcher {

    public packumentCalls = 0;
    public tarballCalls: string[] = [];

    public constructor(
        private readonly _docs: Record<string, unknown>,
        private readonly _tarballs: Record<string, Buffer> = {}
    ) {}

    public async packument(name: string): Promise<{status: number; json: unknown;}> {
        this.packumentCalls++;
        const doc = this._docs[name];
        return doc ? {status: 200, json: doc} : {status: 404, json: null};
    }

    public async tarball(url: string): Promise<{status: number; body: Buffer|null;}> {
        this.tarballCalls.push(url);
        const body = this._tarballs[url];
        return body ? {status: 200, body: body} : {status: 404, body: null};
    }

}

/**
 * In-memory tarball store keyed by `name@version`, tracking writes so
 * tests can assert store-hit vs upstream-miss behaviour.
 */
class FakeStore implements TarballStore {

    public writes: string[] = [];

    public constructor(private readonly _mem: Map<string, Buffer> = new Map()) {}

    public async has(name: string, version: string): Promise<boolean> {
        return this._mem.has(`${name}@${version}`);
    }

    public async read(name: string, version: string): Promise<Buffer|null> {
        return this._mem.get(`${name}@${version}`) ?? null;
    }

    public async write(name: string, version: string, tarball: Buffer): Promise<void> {
        this.writes.push(`${name}@${version}`);
        this._mem.set(`${name}@${version}`, tarball);
    }

}

function packument(name: string, versions: Record<string, {tarball: string; integrity: string;}>): unknown {
    const out: Record<string, unknown> = {};
    for (const [v, dist] of Object.entries(versions)) {
        out[v] = {name: name, version: v, dist: {tarball: dist.tarball, integrity: dist.integrity, shasum: 'sha1'}};
    }
    return {'name': name, 'dist-tags': {latest: Object.keys(versions).at(-1)}, 'versions': out};
}

const BASE = 'http://localhost:5190/registry';

describe('RegistryProxy.getPackument', () => {

    it('rewrites dist.tarball to the mount path but preserves integrity', async() => {
        const up = new FakeUpstream({
            lodash: packument('lodash', {
                '4.17.21': {tarball: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', integrity: 'sha512-AAA'}
            })
        });
        const proxy = new RegistryProxy(up);
        const {status, body} = await proxy.getPackument('lodash', BASE);
        expect(status).toBe(200);
        const dist = (((body as Record<string, unknown>).versions as Record<string, {dist: {tarball: string; integrity: string;};}>))['4.17.21'].dist;
        expect(dist.tarball).toBe('http://localhost:5190/registry/lodash/-/lodash-4.17.21.tgz');
        expect(dist.integrity).toBe('sha512-AAA');
    });

    it('uses the unscoped filename but keeps the scope in the path for scoped names', async() => {
        const up = new FakeUpstream({
            '@babel/core': packument('@babel/core', {
                '7.0.0': {tarball: 'https://x/whatever.tgz', integrity: 'sha512-B'}
            })
        });
        const proxy = new RegistryProxy(up);
        const {body} = await proxy.getPackument('@babel/core', BASE);
        const dist = (((body as Record<string, unknown>).versions as Record<string, {dist: {tarball: string;};}>))['7.0.0'].dist;
        expect(dist.tarball).toBe('http://localhost:5190/registry/@babel/core/-/core-7.0.0.tgz');
    });

    it('mirrors the upstream 404 with a null body', async() => {
        const proxy = new RegistryProxy(new FakeUpstream({}));
        const {status, body} = await proxy.getPackument('nope', BASE);
        expect(status).toBe(404);
        expect(body).toBeNull();
    });

    it('rewritten tarball URL round-trips back to name@version through the route parser', async() => {
        const up = new FakeUpstream({
            '@babel/core': packument('@babel/core', {'7.0.0': {tarball: 'https://x/y.tgz', integrity: 'sha512-B'}})
        });
        const {body} = await new RegistryProxy(up).getPackument('@babel/core', BASE);
        const versions = (body as Record<string, unknown>).versions as Record<string, {dist: {tarball: string;};}>;
        const url = versions['7.0.0'].dist.tarball;

        /* Mirror the controller's path parse: strip base, split on /-/. */
        const rel = url.slice(`${BASE}/`.length);
        const tarIdx = rel.indexOf('/-/');
        const name = decodeURIComponent(rel.slice(0, tarIdx));
        const file = rel.slice(tarIdx + 3);
        expect(name).toBe('@babel/core');
        expect(RegistryProxy.versionFromTarballFile(name, file)).toBe('7.0.0');
    });
});

describe('RegistryProxy.getTarball', () => {

    it('resolves the upstream tarball URL from the packument and returns bytes', async() => {
        const url = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';
        const bytes = Buffer.from('tgz-bytes');
        const up = new FakeUpstream(
            {lodash: packument('lodash', {'4.17.21': {tarball: url, integrity: 'sha512-A'}})},
            {[url]: bytes}
        );
        const proxy = new RegistryProxy(up);
        const {status, body} = await proxy.getTarball('lodash', '4.17.21');
        expect(status).toBe(200);
        expect(body).toEqual(bytes);
        expect(up.tarballCalls).toEqual([url]);
    });

    it('reuses a memoised packument across packument + tarball calls', async() => {
        const url = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';
        const up = new FakeUpstream(
            {lodash: packument('lodash', {'4.17.21': {tarball: url, integrity: 'sha512-A'}})},
            {[url]: Buffer.from('x')}
        );
        const proxy = new RegistryProxy(up);
        await proxy.getPackument('lodash', BASE);
        await proxy.getTarball('lodash', '4.17.21');
        expect(up.packumentCalls).toBe(1);
    });

    it('resolves the ORIGINAL upstream tarball URL even after getPackument rewrote the response', async() => {
        const url = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';
        const bytes = Buffer.from('real-bytes');
        const up = new FakeUpstream(
            {lodash: packument('lodash', {'4.17.21': {tarball: url, integrity: 'sha512-A'}})},
            {[url]: bytes}
        );
        const proxy = new RegistryProxy(up);
        /*
         * getPackument rewrites dist.tarball to BASE in its response, but
         * getTarball must still fetch the ORIGINAL upstream URL, not the
         * rewritten BASE one (else the proxy would fetch itself).
         */
        await proxy.getPackument('lodash', BASE);
        const {status, body} = await proxy.getTarball('lodash', '4.17.21');
        expect(status).toBe(200);
        expect(Buffer.compare(body as Buffer, bytes)).toBe(0);
        expect(up.tarballCalls).toEqual([url]);
    });

    it('returns 404 for an unknown version', async() => {
        const up = new FakeUpstream({
            lodash: packument('lodash', {'4.17.21': {tarball: 'https://x/a.tgz', integrity: 'sha512-A'}})
        });
        const proxy = new RegistryProxy(up);
        const {status, body} = await proxy.getTarball('lodash', '9.9.9');
        expect(status).toBe(404);
        expect(body).toBeNull();
    });
});

describe('RegistryProxy with a tarball store', () => {

    const url = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';

    function withUpstream(bytes: Buffer): FakeUpstream {
        return new FakeUpstream(
            {lodash: packument('lodash', {'4.17.21': {tarball: url, integrity: 'sha512-A'}})},
            {[url]: bytes}
        );
    }

    it('serves from the store and skips the upstream on a hit', async() => {
        const cached = Buffer.from('cached-bytes');
        const store = new FakeStore(new Map([['lodash@4.17.21', cached]]));
        const up = withUpstream(Buffer.from('upstream-bytes'));
        const proxy = new RegistryProxy(up, store);
        const {status, body, source} = await proxy.getTarball('lodash', '4.17.21');
        expect(status).toBe(200);
        expect(source).toBe('store');
        expect(Buffer.compare(body as Buffer, cached)).toBe(0);
        expect(up.tarballCalls).toEqual([]);
    });

    it('fetches upstream on a miss and writes it back to the store', async() => {
        const bytes = Buffer.from('upstream-bytes');
        const store = new FakeStore();
        const proxy = new RegistryProxy(withUpstream(bytes), store);
        const first = await proxy.getTarball('lodash', '4.17.21');
        expect(first.source).toBe('upstream');
        expect(Buffer.compare(first.body as Buffer, bytes)).toBe(0);
        expect(store.writes).toEqual(['lodash@4.17.21']);

        /* Second call is now a store hit. */
        const second = await proxy.getTarball('lodash', '4.17.21');
        expect(second.source).toBe('store');
    });

    it('self-heals a corrupt store hit by re-fetching upstream and overwriting', async() => {
        const writes: string[] = [];
        const corruptStore: TarballStore = {
            has: async(): Promise<boolean> => true,
            read: async(): Promise<Buffer|null> => null,
            write: async(n: string, v: string): Promise<void> => {
                writes.push(`${n}@${v}`);
            }
        };
        const bytes = Buffer.from('upstream-bytes');
        const proxy = new RegistryProxy(withUpstream(bytes), corruptStore);
        const {source, body} = await proxy.getTarball('lodash', '4.17.21');
        expect(source).toBe('upstream');
        expect(Buffer.compare(body as Buffer, bytes)).toBe(0);
        expect(writes).toEqual(['lodash@4.17.21']);
    });
});

describe('RegistryProxy static helpers', () => {

    it('unscopedName strips the scope', () => {
        expect(RegistryProxy.unscopedName('@babel/core')).toBe('core');
        expect(RegistryProxy.unscopedName('lodash')).toBe('lodash');
    });

    it('versionFromTarballFile parses unscoped + scoped filenames', () => {
        expect(RegistryProxy.versionFromTarballFile('lodash', 'lodash-4.17.21.tgz')).toBe('4.17.21');
        expect(RegistryProxy.versionFromTarballFile('@babel/core', 'core-7.0.0.tgz')).toBe('7.0.0');
        expect(RegistryProxy.versionFromTarballFile('lodash', 'lodash-1.0.0-beta.1.tgz')).toBe('1.0.0-beta.1');
    });

    it('versionFromTarballFile rejects a mismatched prefix or suffix', () => {
        expect(RegistryProxy.versionFromTarballFile('lodash', 'other-1.0.0.tgz')).toBeNull();
        expect(RegistryProxy.versionFromTarballFile('lodash', 'lodash-1.0.0.zip')).toBeNull();
    });
});