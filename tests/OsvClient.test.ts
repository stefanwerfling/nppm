import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {OsvClient} from '../backend/Security/OsvClient.js';

describe('OsvClient', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-osv-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('normalises an OSV response into compact records', async () => {
        const fetcher = async () => ({
            vulns: [
                {
                    id: 'GHSA-xxxx-yyyy-zzzz',
                    summary: 'Prototype pollution',
                    details: 'Long details ...',
                    severity: [{type: 'CVSS_V3', score: '7.5'}],
                    references: [{type: 'WEB', url: 'https://example.com/advisory'}],
                    published: '2024-01-01T00:00:00Z',
                    modified: '2024-02-01T00:00:00Z'
                }
            ]
        });

        const client = new OsvClient(null, fetcher);
        const vulns = await client.query('lodash', '4.17.20');

        expect(vulns).not.toBeNull();
        expect(vulns).toHaveLength(1);
        expect(vulns![0].id).toBe('GHSA-xxxx-yyyy-zzzz');
        expect(vulns![0].severity[0]).toEqual({type: 'CVSS_V3', score: '7.5'});
        expect(vulns![0].references[0]).toEqual({type: 'WEB', url: 'https://example.com/advisory'});
    });

    it('returns [] when OSV reports no known vulns', async () => {
        const client = new OsvClient(null, async () => ({vulns: []}));
        const vulns = await client.query('clean-pkg', '1.0.0');
        expect(vulns).toEqual([]);
    });

    it('returns null when the OSV request throws', async () => {
        const client = new OsvClient(null, async () => {
            throw new Error('network down');
        });
        expect(await client.query('foo', '1.0.0')).toBeNull();
    });

    it('caches successful answers (no second fetch)', async () => {
        let calls = 0;
        const cache = new JsonCache(dir, 60);
        const client = new OsvClient(cache, async () => {
            calls++;
            return {vulns: []};
        });

        await client.query('foo', '1.0.0');
        await client.query('foo', '1.0.0');
        expect(calls).toBe(1);
    });

    it('caches the failure case under the {data: null} envelope', async () => {
        let calls = 0;
        const cache = new JsonCache(dir, 60);
        const client = new OsvClient(cache, async () => {
            calls++;
            throw new Error('boom');
        });

        const first = await client.query('foo', '1.0.0');
        const second = await client.query('foo', '1.0.0');
        expect(first).toBeNull();
        expect(second).toBeNull();
        expect(calls).toBe(1);
    });

    describe('queryBatch', () => {
        it('batches misses into one /v1/querybatch call and returns IDs', async () => {
            const calls: object[] = [];
            const batchFetcher = async (body: object) => {
                calls.push(body);
                return {
                    results: [
                        {vulns: [{id: 'GHSA-aaa'}, {id: 'GHSA-bbb'}]},
                        {vulns: []}
                    ]
                };
            };

            const client = new OsvClient(null, undefined, 'https://api.osv.dev', batchFetcher);
            const result = await client.queryBatch([
                {name: 'a', version: '1.0.0'},
                {name: 'b', version: '2.0.0'}
            ]);

            expect(result.get('a@1.0.0')).toEqual(['GHSA-aaa', 'GHSA-bbb']);
            expect(result.get('b@2.0.0')).toEqual([]);
            expect(calls).toHaveLength(1);
        });

        it('reuses the single-query cache (full records → just take IDs)', async () => {
            let batchCalls = 0;
            const cache = new JsonCache(dir, 60);

            // Seed the single-query cache via query().
            const single = new OsvClient(cache, async () => ({
                vulns: [{id: 'GHSA-zzz', summary: 'x'}]
            }));
            await single.query('warm', '1.0.0');

            const batchFetcher = async () => {
                batchCalls++;
                return {results: []};
            };
            const client = new OsvClient(cache, undefined, 'https://api.osv.dev', batchFetcher);
            const result = await client.queryBatch([{name: 'warm', version: '1.0.0'}]);

            expect(result.get('warm@1.0.0')).toEqual(['GHSA-zzz']);
            expect(batchCalls).toBe(0); // never hit the batch endpoint
        });

        it('caches batch results so a second call does not refetch', async () => {
            let batchCalls = 0;
            const cache = new JsonCache(dir, 60);
            const batchFetcher = async () => {
                batchCalls++;
                return {results: [{vulns: []}]};
            };

            const client = new OsvClient(cache, undefined, 'https://api.osv.dev', batchFetcher);
            await client.queryBatch([{name: 'foo', version: '1.0.0'}]);
            await client.queryBatch([{name: 'foo', version: '1.0.0'}]);

            expect(batchCalls).toBe(1);
        });

        it('stores null for failed chunks', async () => {
            const cache = new JsonCache(dir, 60);
            const batchFetcher = async () => {
                throw new Error('boom');
            };

            const client = new OsvClient(cache, undefined, 'https://api.osv.dev', batchFetcher);
            const result = await client.queryBatch([{name: 'foo', version: '1.0.0'}]);
            expect(result.get('foo@1.0.0')).toBeNull();
        });
    });
});