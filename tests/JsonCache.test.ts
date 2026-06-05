import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';

describe('JsonCache', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-cache-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns null on miss', () => {
        const cache = new JsonCache(dir, 60);
        expect(cache.get('missing')).toBeNull();
    });

    it('round-trips a value within the TTL', () => {
        const cache = new JsonCache(dir, 60);
        cache.set('foo', {hello: 'world'});
        expect(cache.get('foo')).toEqual({hello: 'world'});
    });

    it('treats stale entries as misses', () => {
        // 0 TTL means every read is past TTL.
        const cache = new JsonCache(dir, 0);
        cache.set('foo', 1);

        // wait at least one ms so Date.now() - t > 0
        const target = Date.now() + 5;
        while (Date.now() < target) { /* spin */ }

        expect(cache.get('foo')).toBeNull();
    });

    it('survives scoped names (sanitises filenames)', () => {
        const cache = new JsonCache(dir, 60);
        cache.set('@scope/pkg-name', 'value');
        expect(cache.get('@scope/pkg-name')).toBe('value');
    });

    it('treats a corrupt cache file as a miss', () => {
        const cache = new JsonCache(dir, 60);
        cache.set('foo', 1);

        const filename = fs.readdirSync(dir)[0];
        fs.writeFileSync(path.join(dir, filename), 'not json');

        expect(cache.get('foo')).toBeNull();
    });

    it('ignores TTL when permanent is enabled', () => {
        const cache = new JsonCache(dir, 0, {permanent: true});
        cache.set('foo', 'bar');

        const target = Date.now() + 5;
        while (Date.now() < target) { /* spin */ }

        expect(cache.get('foo')).toBe('bar');
    });
});