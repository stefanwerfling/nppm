import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {Registry, RegistryPackage} from '../backend/Registry/Registry.js';
import {InstalledSize} from '../backend/Dashboard/InstalledSize.js';

describe('InstalledSize.compute', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-isz-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    const mkRegistry = (entries: Record<string, RegistryPackage>): Registry => {
        const cache = new JsonCache(dir, 60);
        for (const [name, pkg] of Object.entries(entries)) {
            cache.set(name, pkg);
        }
        return new Registry('http://unused', cache);
    };

    const pkgWithSizes = (name: string, sizes: Record<string, number>): RegistryPackage => ({
        name,
        latest: Object.keys(sizes)[0] ?? null,
        versions: Object.keys(sizes),
        dist: Object.fromEntries(
            Object.entries(sizes).map(([v, sz]) => [v, {tarball: 'http://t', unpackedSize: sz}])
        )
    });

    it('sums unpackedSize across the package list', async () => {
        const reg = mkRegistry({
            'a': pkgWithSizes('a', {'1.0.0': 1000, '2.0.0': 2000}),
            'b': pkgWithSizes('b', {'1.0.0': 500})
        });
        const result = await InstalledSize.compute([
            {name: 'a', version: '1.0.0'},
            {name: 'b', version: '1.0.0'}
        ], reg);
        expect(result.totalBytes).toBe(1500);
        expect(result.coveredCount).toBe(2);
        expect(result.totalCount).toBe(2);
    });

    it('skips packages without a size record but counts them in totalCount', async () => {
        const reg = mkRegistry({
            'a': pkgWithSizes('a', {'1.0.0': 1000}),
            'b': {
                name: 'b', latest: '1.0.0', versions: ['1.0.0'],
                dist: {'1.0.0': {tarball: 'http://t'}}  // no unpackedSize
            }
        });
        const result = await InstalledSize.compute([
            {name: 'a', version: '1.0.0'},
            {name: 'b', version: '1.0.0'}
        ], reg);
        expect(result.totalBytes).toBe(1000);
        expect(result.coveredCount).toBe(1);
        expect(result.totalCount).toBe(2);
    });

    it('returns zero/zero/zero on empty input', async () => {
        const reg = mkRegistry({});
        const result = await InstalledSize.compute([], reg);
        expect(result).toEqual({totalBytes: 0, coveredCount: 0, totalCount: 0});
    });

    it('skips packages whose version is not in the dist map', async () => {
        const reg = mkRegistry({
            'a': pkgWithSizes('a', {'1.0.0': 1000})
        });
        const result = await InstalledSize.compute(
            [{name: 'a', version: '99.0.0'}],
            reg
        );
        expect(result.totalBytes).toBe(0);
        expect(result.coveredCount).toBe(0);
        expect(result.totalCount).toBe(1);
    });
});