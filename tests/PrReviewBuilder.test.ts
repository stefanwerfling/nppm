import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {ConfigProjectType} from '../backend/Config/Config.js';
import {PrReviewBuilder, GitFileReader} from '../backend/PrReview/PrReviewBuilder.js';
import {OsvClient} from '../backend/Security/OsvClient.js';

/**
 * In-memory `GitFileReader` for the suite. `files` is keyed by
 * `<ref>:<path>` to keep the lookup table flat and obvious.
 */
function fakeReader(refs: Set<string>, files: Map<string, string>): GitFileReader {
    return {
        isRepo: () => true,
        refExists: (_cwd, ref) => refs.has(ref),
        show: (_cwd, ref, file) => {
            const v = files.get(`${ref}:${file}`);
            if (v === undefined) {
                throw new Error(`missing: ${ref}:${file}`);
            }
            return v;
        }
    };
}

/** Build a `package.json` blob with the four standard buckets. */
function pkgJson(deps: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}): string {
    return JSON.stringify({name: 'x', version: '1.0.0', ...deps});
}

function lockfile(packages: Record<string, string>): string {
    const out: Record<string, unknown> = {};
    for (const [name, version] of Object.entries(packages)) {
        out[`node_modules/${name}`] = {version: version};
    }
    return JSON.stringify({
        lockfileVersion: 3,
        packages: {'': {name: 'x', version: '1.0.0'}, ...out}
    });
}

const META = {unid: 'u', name: 'demo', type: ConfigProjectType.local};

describe('PrReviewBuilder', () => {
    let dir: string;
    let cache: JsonCache;
    let osv: OsvClient;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-pr-'));
        cache = new JsonCache(dir, 60);
        /*
         * OsvClient with a fetcher that always errors; the queryBatch
         * path will fall back to the empty-record cache after one
         * failed chunk. Tests that need OSV data seed the cache
         * directly.
         */
        osv = new OsvClient(cache, async() => ({vulns: []}), 'http://test', async() => ({results: []}));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns an empty report when not a git repo', async() => {
        const reader: GitFileReader = {
            isRepo: () => false,
            refExists: () => false,
            show: () => { throw new Error('not called'); }
        };
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);
        expect(r.changes).toEqual([]);
        expect(r.baseExists).toBe(false);
        expect(r.headExists).toBe(false);
        expect(r.notes[0]).toMatch(/Not a git repository/);
    });

    it('marks ref as missing when it does not resolve', async() => {
        const reader = fakeReader(new Set(['HEAD']), new Map([
            ['HEAD:package.json', pkgJson({dependencies: {foo: '^1.0.0'}})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);
        expect(r.baseExists).toBe(false);
        expect(r.headExists).toBe(true);
        expect(r.notes.some((n) => /main/.test(n))).toBe(true);
    });

    it('reports added deps when the head adds one', async() => {
        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {foo: '^1.0.0'}})],
            ['HEAD:package.json', pkgJson({dependencies: {foo: '^1.0.0', bar: '^2.0.0'}})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]).toMatchObject({
            name: 'bar',
            kind: 'added',
            declaredRangeAfter: '^2.0.0'
        });
        expect(r.summary.added).toBe(1);
    });

    it('reports removed deps when the head drops one', async() => {
        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {foo: '^1.0.0', bar: '^2.0.0'}})],
            ['HEAD:package.json', pkgJson({dependencies: {foo: '^1.0.0'}})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]).toMatchObject({name: 'bar', kind: 'removed'});
        expect(r.summary.removed).toBe(1);
    });

    it('reports updated deps with new and old ranges', async() => {
        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {foo: '^1.0.0'}})],
            ['HEAD:package.json', pkgJson({dependencies: {foo: '^2.0.0'}})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]).toMatchObject({
            name: 'foo',
            kind: 'updated',
            declaredRangeBefore: '^1.0.0',
            declaredRangeAfter: '^2.0.0'
        });
    });

    it('detects bucket-only moves (dependencies → devDependencies)', async() => {
        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {foo: '^1.0.0'}})],
            ['HEAD:package.json', pkgJson({devDependencies: {foo: '^1.0.0'}})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]).toMatchObject({
            name: 'foo',
            kind: 'bucket-changed',
            declaredBucketBefore: 'dependency',
            declaredBucketAfter: 'dev'
        });
    });

    it('skips deps that look identical on both sides', async() => {
        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {foo: '^1.0.0'}})],
            ['HEAD:package.json', pkgJson({dependencies: {foo: '^1.0.0'}})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);
        expect(r.changes).toEqual([]);
    });

    it('annotates resolved-version delta from lockfile when present', async() => {
        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {lodash: '^4.0.0'}})],
            ['HEAD:package.json', pkgJson({dependencies: {lodash: '^4.0.0'}})],
            ['main:package-lock.json', lockfile({lodash: '4.17.20'})],
            ['HEAD:package-lock.json', lockfile({lodash: '4.17.21'})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]).toMatchObject({
            name: 'lodash',
            kind: 'updated',
            resolvedBefore: '4.17.20',
            resolvedAfter: '4.17.21'
        });
    });

    it('computes CVE delta when both sides have OSV cache entries', async() => {
        /*
         * Seed OSV id-only batch cache: 4.17.20 has two CVEs, 4.17.21
         * has only one (the other was fixed by the upgrade).
         */
        cache.set('osv_b_v1_lodash@4.17.20', {data: ['GHSA-a', 'GHSA-b']});
        cache.set('osv_b_v1_lodash@4.17.21', {data: ['GHSA-a']});

        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {lodash: '^4.0.0'}})],
            ['HEAD:package.json', pkgJson({dependencies: {lodash: '^4.0.0'}})],
            ['main:package-lock.json', lockfile({lodash: '4.17.20'})],
            ['HEAD:package-lock.json', lockfile({lodash: '4.17.21'})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);

        expect(r.changes).toHaveLength(1);
        expect(r.changes[0].vulnsBefore?.sort()).toEqual(['GHSA-a', 'GHSA-b']);
        expect(r.changes[0].vulnsAfter).toEqual(['GHSA-a']);
        expect(r.changes[0].vulnsAdded).toEqual([]);
        expect(r.changes[0].vulnsRemoved).toEqual(['GHSA-b']);
        expect(r.summary.totalVulnsRemoved).toBe(1);
        expect(r.summary.totalVulnsAdded).toBe(0);
    });

    it('reports a new exposure when the head version pulls in a fresh CVE', async() => {
        cache.set('osv_b_v1_evil@1.0.0', {data: []});
        cache.set('osv_b_v1_evil@2.0.0', {data: ['GHSA-fresh']});

        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {evil: '^1.0.0'}})],
            ['HEAD:package.json', pkgJson({dependencies: {evil: '^2.0.0'}})],
            ['main:package-lock.json', lockfile({evil: '1.0.0'})],
            ['HEAD:package-lock.json', lockfile({evil: '2.0.0'})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);

        expect(r.changes[0].vulnsAdded).toEqual(['GHSA-fresh']);
        expect(r.summary.totalVulnsAdded).toBe(1);
    });

    it('sorts changes by added-vuln count first, then name', async() => {
        cache.set('osv_b_v1_a@1.0.0', {data: []});
        cache.set('osv_b_v1_a@2.0.0', {data: ['x', 'y']});  // 2 added
        cache.set('osv_b_v1_b@1.0.0', {data: []});
        cache.set('osv_b_v1_b@2.0.0', {data: ['z']});       // 1 added
        cache.set('osv_b_v1_c@1.0.0', {data: []});
        cache.set('osv_b_v1_c@2.0.0', {data: []});          // 0 added

        const reader = fakeReader(new Set(['main', 'HEAD']), new Map([
            ['main:package.json', pkgJson({dependencies: {a: '^1', b: '^1', c: '^1'}})],
            ['HEAD:package.json', pkgJson({dependencies: {a: '^2', b: '^2', c: '^2'}})],
            ['main:package-lock.json', lockfile({a: '1.0.0', b: '1.0.0', c: '1.0.0'})],
            ['HEAD:package-lock.json', lockfile({a: '2.0.0', b: '2.0.0', c: '2.0.0'})]
        ]));
        const b = new PrReviewBuilder(osv, reader);
        const r = await b.build('/x', 'main', 'HEAD', META);

        expect(r.changes.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    });
});