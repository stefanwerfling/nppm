import {describe, expect, it} from 'vitest';
import {LockfileReader} from '../backend/Project/Lockfile.js';

/**
 * In-memory fs-like adapter for `scanNodeModules`. Keys are absolute
 * "paths" with forward slashes; values are either string (file
 * contents) or the magic marker `<dir>` (directory).
 */
function fakeFs(files: Record<string, string>) {
    return {
        existsSync: (p: string) => Object.hasOwn(files, p),
        readdirSync: (p: string) => {
            const prefix = `${p}/`;
            const out = new Set<string>();
            for (const key of Object.keys(files)) {
                if (key.startsWith(prefix)) {
                    out.add(key.slice(prefix.length).split('/')[0]);
                }
            }
            return Array.from(out);
        },
        readFileSync: (p: string) => {
            const v = files[p];
            if (v === undefined || v === '<dir>') {
                throw new Error(`ENOENT: ${p}`);
            }
            return v;
        },
        statSync: (p: string) => ({
            isDirectory: () => files[p] === '<dir>'
        })
    };
}

describe('LockfileReader.packageNameFromPath', () => {
    it('extracts simple top-level names', () => {
        expect(LockfileReader.packageNameFromPath('node_modules/foo')).toBe('foo');
    });

    it('extracts scoped names', () => {
        expect(LockfileReader.packageNameFromPath('node_modules/@scope/bar')).toBe('@scope/bar');
    });

    it('extracts the *inner* name from a nested install', () => {
        expect(LockfileReader.packageNameFromPath('node_modules/foo/node_modules/baz')).toBe('baz');
        expect(LockfileReader.packageNameFromPath('node_modules/foo/node_modules/@s/bar')).toBe('@s/bar');
    });

    it('returns null for malformed paths', () => {
        expect(LockfileReader.packageNameFromPath('node_modules')).toBeNull();
        expect(LockfileReader.packageNameFromPath('')).toBeNull();
        expect(LockfileReader.packageNameFromPath('some/other/path')).toBeNull();
    });
});

describe('LockfileReader.parse', () => {
    it('parses a minimal v3 lockfile and skips the root entry', () => {
        const lock = LockfileReader.parse(JSON.stringify({
            name: 'project',
            version: '1.0.0',
            lockfileVersion: 3,
            packages: {
                '': {name: 'project', version: '1.0.0'},
                'node_modules/foo': {version: '1.2.3', resolved: 'https://x/foo.tgz'},
                'node_modules/@scope/bar': {version: '2.0.0'}
            }
        }));

        expect(lock.lockfileVersion).toBe(3);
        expect(lock.source).toBe('committed');
        expect(lock.packages).toHaveLength(2);

        const foo = lock.packages.find((p) => p.name === 'foo')!;
        expect(foo.version).toBe('1.2.3');
        expect(foo.resolved).toBe('https://x/foo.tgz');
        expect(foo.dev).toBe(false);

        const bar = lock.packages.find((p) => p.name === '@scope/bar')!;
        expect(bar.version).toBe('2.0.0');
    });

    it('respects dev/optional/peer flags', () => {
        const lock = LockfileReader.parse(JSON.stringify({
            lockfileVersion: 3,
            packages: {
                '': {},
                'node_modules/d': {version: '1.0.0', dev: true},
                'node_modules/o': {version: '1.0.0', optional: true},
                'node_modules/p': {version: '1.0.0', peer: true},
                'node_modules/do': {version: '1.0.0', devOptional: true}
            }
        }));

        const by = (n: string) => lock.packages.find((p) => p.name === n)!;
        expect(by('d').dev).toBe(true);
        expect(by('o').optional).toBe(true);
        expect(by('p').peer).toBe(true);
        /*
         * devOptional collapses into both flags being true — npm sets
         * this when a package is *both* in devDependencies and is
         * marked optional. The UI shouldn't need to know about the
         * combined flag separately.
         */
        expect(by('do').dev).toBe(true);
        expect(by('do').optional).toBe(true);
    });

    it('captures nested installs (same package at two versions)', () => {
        const lock = LockfileReader.parse(JSON.stringify({
            lockfileVersion: 3,
            packages: {
                '': {},
                'node_modules/dep': {version: '1.0.0'},
                'node_modules/other/node_modules/dep': {version: '2.0.0'}
            }
        }));

        const deps = lock.packages.filter((p) => p.name === 'dep');
        expect(deps).toHaveLength(2);
        expect(deps.map((d) => d.version).sort()).toEqual(['1.0.0', '2.0.0']);
    });

    it('rejects lockfileVersion 1', () => {
        expect(() => LockfileReader.parse(JSON.stringify({lockfileVersion: 1}))).toThrow(/lockfileVersion/u);
    });

    it('extracts the direct dependency map from each entry', () => {
        const lock = LockfileReader.parse(JSON.stringify({
            lockfileVersion: 3,
            packages: {
                '': {},
                'node_modules/foo': {
                    version: '1.0.0',
                    dependencies: {bar: '^2.0.0'},
                    peerDependencies: {qux: '*'},
                    optionalDependencies: {opt: '~3'}
                },
                'node_modules/bar': {version: '2.0.0'}
            }
        }));
        const foo = lock.packages.find((p) => p.name === 'foo')!;
        expect(foo.deps).toEqual({bar: '^2.0.0'});
        expect(foo.peerDeps).toEqual({qux: '*'});
        expect(foo.optionalDeps).toEqual({opt: '~3'});
        const bar = lock.packages.find((p) => p.name === 'bar')!;
        expect(bar.deps).toEqual({});
    });

    it('honours the explicit source label (used for the hidden lockfile)', () => {
        const lock = LockfileReader.parse(
            JSON.stringify({
                lockfileVersion: 3,
                packages: {
                    '': {},
                    'node_modules/foo': {version: '1.0.0'}
                }
            }),
            'hidden'
        );
        expect(lock.source).toBe('hidden');
    });

    it('throws on missing packages map', () => {
        expect(() => LockfileReader.parse(JSON.stringify({lockfileVersion: 3}))).toThrow(/packages/u);
    });
});

describe('LockfileReader.scanNodeModules', () => {
    it('returns null when node_modules is missing', () => {
        const fs = fakeFs({});
        expect(LockfileReader.scanNodeModules('/proj', fs)).toBeNull();
    });

    it('walks top-level packages and reads name/version from manifest', () => {
        const fs = fakeFs({
            '/proj/node_modules': '<dir>',
            '/proj/node_modules/foo': '<dir>',
            '/proj/node_modules/foo/package.json': JSON.stringify({name: 'foo', version: '1.2.3'}),
            '/proj/node_modules/bar': '<dir>',
            '/proj/node_modules/bar/package.json': JSON.stringify({name: 'bar', version: '0.9.0'})
        });

        const lock = LockfileReader.scanNodeModules('/proj', fs)!;
        expect(lock.lockfileVersion).toBe(0);
        expect(lock.source).toBe('synthesized');
        expect(lock.packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual([
            'bar@0.9.0',
            'foo@1.2.3'
        ]);
    });

    it('handles scoped packages (@scope/pkg)', () => {
        const fs = fakeFs({
            '/proj/node_modules': '<dir>',
            '/proj/node_modules/@scope': '<dir>',
            '/proj/node_modules/@scope/pkg': '<dir>',
            '/proj/node_modules/@scope/pkg/package.json': JSON.stringify({version: '2.0.0'})
        });

        const lock = LockfileReader.scanNodeModules('/proj', fs)!;
        expect(lock.packages).toHaveLength(1);
        expect(lock.packages[0].name).toBe('@scope/pkg');
        expect(lock.packages[0].path).toBe('node_modules/@scope/pkg');
    });

    it('skips hidden entries (.bin, .cache, .package-lock.json)', () => {
        const fs = fakeFs({
            '/proj/node_modules': '<dir>',
            '/proj/node_modules/.bin': '<dir>',
            '/proj/node_modules/.cache': '<dir>',
            '/proj/node_modules/foo': '<dir>',
            '/proj/node_modules/foo/package.json': JSON.stringify({version: '1.0.0'})
        });

        const lock = LockfileReader.scanNodeModules('/proj', fs)!;
        expect(lock.packages.map((p) => p.name)).toEqual(['foo']);
    });

    it('survives a broken individual package.json', () => {
        const fs = fakeFs({
            '/proj/node_modules': '<dir>',
            '/proj/node_modules/broken': '<dir>',
            '/proj/node_modules/broken/package.json': 'not json',
            '/proj/node_modules/ok': '<dir>',
            '/proj/node_modules/ok/package.json': JSON.stringify({version: '1.0.0'})
        });

        const lock = LockfileReader.scanNodeModules('/proj', fs)!;
        expect(lock.packages.map((p) => p.name)).toEqual(['ok']);
    });
});