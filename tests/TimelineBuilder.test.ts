import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {JsonCache} from '../backend/Cache/JsonCache.js';
import {ConfigProjectType} from '../backend/Config/Config.js';
import {HistoryEntry, HistoryFile} from '../backend/History/History.js';
import {OsvVulnerability} from '../backend/Security/OsvClient.js';
import {TimelineBuilder} from '../backend/Vulnerability/TimelineBuilder.js';

/**
 * Helper for the OSV single-query cache pocket — TimelineBuilder reads
 * it raw via `osv_<name>@<version>`. Tests seed it directly so we don't
 * need to spin up an OSV client.
 */
function seedOsv(cache: JsonCache, name: string, version: string, vulns: OsvVulnerability[]|null): void {
    cache.set(`osv_${name}@${version}`, {data: vulns});
}

function entry(args: Partial<HistoryEntry> & {timestamp: number;}): HistoryEntry {
    return {
        timestamp: args.timestamp,
        lockfileSource: args.lockfileSource ?? 'committed',
        added: args.added ?? [],
        removed: args.removed ?? [],
        updated: args.updated ?? [],
        source: args.source ?? 'git',
        commitSha: args.commitSha
    };
}

const FAKE_PROJECT = {unid: 'unid-1', name: 'demo', type: ConfigProjectType.local};

describe('TimelineBuilder', () => {
    let dir: string;
    let cache: JsonCache;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-tl-'));
        cache = new JsonCache(dir, 60);
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('emits no exposures when no version has cached OSV data', () => {
        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {timestamp: 5000, packages: [{name: 'foo', version: '1.0.0'}]},
            entries: [entry({timestamp: 1000, added: [{name: 'foo', version: '1.0.0'}]})]
        };
        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);

        expect(out.totalVersions).toBe(1);
        expect(out.scannedVersions).toBe(0);
        expect(out.exposures).toEqual([]);
        expect(out.needsScan).toBe(true);
    });

    it('classifies known-at-install when CVE pre-dates the install', () => {
        seedOsv(cache, 'lodash', '4.17.20', [{
            id: 'GHSA-29mw',
            summary: 's',
            details: 'd',
            severity: [],
            references: [],
            published: '2020-01-01T00:00:00Z',
            modified: '2020-01-01T00:00:00Z'
        }]);

        const installAt = Date.parse('2021-06-01T00:00:00Z');
        const removeAt = Date.parse('2021-12-01T00:00:00Z');

        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {timestamp: removeAt, packages: []},
            entries: [
                entry({timestamp: installAt, added: [{name: 'lodash', version: '4.17.20'}]}),
                entry({timestamp: removeAt, removed: [{name: 'lodash', version: '4.17.20'}]})
            ]
        };

        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);

        expect(out.exposures).toHaveLength(1);
        const e = out.exposures[0];
        expect(e.vulnId).toBe('GHSA-29mw');
        expect(e.classification).toBe('known-at-install');
        expect(e.exposedFrom).toBe(installAt);
        expect(e.exposedTo).toBe(removeAt);
        expect(e.exposureDurationMs).toBe(removeAt - installAt);
    });

    it('classifies disclosed-during-use when CVE was filed mid-interval', () => {
        const installAt = Date.parse('2020-01-01T00:00:00Z');
        const publishAt = Date.parse('2020-06-01T00:00:00Z');
        const removeAt = Date.parse('2020-12-01T00:00:00Z');

        seedOsv(cache, 'pkg', '1.0.0', [{
            id: 'CVE-2020-x',
            summary: '',
            details: '',
            severity: [],
            references: [],
            published: new Date(publishAt).toISOString(),
            modified: null
        }]);

        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {timestamp: removeAt, packages: []},
            entries: [
                entry({timestamp: installAt, added: [{name: 'pkg', version: '1.0.0'}]}),
                entry({timestamp: removeAt, removed: [{name: 'pkg', version: '1.0.0'}]})
            ]
        };

        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);

        expect(out.exposures).toHaveLength(1);
        const e = out.exposures[0];
        expect(e.classification).toBe('disclosed-during-use');
        expect(e.exposedFrom).toBe(publishAt);
        expect(e.exposedTo).toBe(removeAt);
    });

    it('drops exposures where the CVE landed after the user already upgraded away', () => {
        const installAt = Date.parse('2019-01-01T00:00:00Z');
        const upgradeAt = Date.parse('2019-06-01T00:00:00Z');
        const publishAt = Date.parse('2020-06-01T00:00:00Z');  // long after upgrade

        seedOsv(cache, 'pkg', '1.0.0', [{
            id: 'CVE-late',
            summary: '',
            details: '',
            severity: [],
            references: [],
            published: new Date(publishAt).toISOString(),
            modified: null
        }]);

        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {timestamp: upgradeAt, packages: [{name: 'pkg', version: '2.0.0'}]},
            entries: [
                entry({timestamp: installAt, added: [{name: 'pkg', version: '1.0.0'}]}),
                entry({timestamp: upgradeAt, updated: [{
                    name: 'pkg',
                    fromVersion: '1.0.0',
                    toVersion: '2.0.0',
                    bumpType: 'major',
                    reason: 'major-bump'
                }]})
            ]
        };

        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);

        /*
         * pkg@1.0.0 was upgraded away before the CVE was disclosed —
         * no exposure should be reported for that version.
         */
        const v1 = out.exposures.filter((e) => e.version === '1.0.0');
        expect(v1).toEqual([]);
    });

    it('handles ongoing intervals — current version of a project still in lastSnapshot', () => {
        seedOsv(cache, 'pkg', '1.0.0', [{
            id: 'GHSA-now',
            summary: '',
            details: '',
            severity: [],
            references: [],
            published: '2020-01-01T00:00:00Z',
            modified: null
        }]);

        const installAt = Date.parse('2021-01-01T00:00:00Z');
        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {timestamp: installAt, packages: [{name: 'pkg', version: '1.0.0'}]},
            entries: [
                entry({timestamp: installAt, added: [{name: 'pkg', version: '1.0.0'}]})
            ]
        };

        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);

        expect(out.exposures).toHaveLength(1);
        const e = out.exposures[0];
        expect(e.exposedTo).toBeNull();
        expect(e.exposureDurationMs).toBeNull();
        expect(e.classification).toBe('known-at-install');
    });

    it('marks packages from lastSnapshot with no entry as pre-tracking', () => {
        seedOsv(cache, 'oldpkg', '1.0.0', [{
            id: 'GHSA-old',
            summary: '',
            details: '',
            severity: [],
            references: [],
            published: '2010-01-01T00:00:00Z',
            modified: null
        }]);

        /*
         * Package is in lastSnapshot but never explicitly added by an
         * entry — simulating "was already in node_modules when nppm
         * first ran on this project, no git backfill yet".
         */
        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {timestamp: 5000, packages: [{name: 'oldpkg', version: '1.0.0'}]},
            entries: []
        };

        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);

        expect(out.exposures).toHaveLength(1);
        expect(out.exposures[0].classification).toBe('pre-tracking');
    });

    it('drops range-shaped versions from totalVersions / coverage stats', () => {
        // Mix of concrete + ranges, as a package-json backfill produces
        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {
                timestamp: 5000,
                packages: [
                    {name: 'concrete', version: '1.0.0'},
                    {name: 'ranged', version: '^1.0.0'},
                    {name: 'wild', version: '*'},
                    {name: 'tilde', version: '~2.0.0'}
                ]
            },
            entries: [
                entry({timestamp: 1000, added: [
                    {name: 'concrete', version: '1.0.0'},
                    {name: 'ranged', version: '^1.0.0'},
                    {name: 'wild', version: '*'},
                    {name: 'tilde', version: '~2.0.0'}
                ]})
            ]
        };

        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);

        // Only the concrete version counts toward total/scanned
        expect(out.totalVersions).toBe(1);
        expect(out.scannedVersions).toBe(0);
        expect(out.needsScan).toBe(true);
    });

    it('keeps pre-release + build-metadata as concrete versions', () => {
        // Strict semver covers pre-release and build metadata
        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {
                timestamp: 5000,
                packages: [
                    {name: 'a', version: '1.0.0-rc.1'},
                    {name: 'b', version: '1.0.0+build.5'}
                ]
            },
            entries: [
                entry({timestamp: 1000, added: [
                    {name: 'a', version: '1.0.0-rc.1'},
                    {name: 'b', version: '1.0.0+build.5'}
                ]})
            ]
        };

        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);
        expect(out.totalVersions).toBe(2);
    });

    it('falls back to id-only batch cache when full record is missing', () => {
        // Only the batch-id pocket has data; full-record cache is empty.
        cache.set('osv_b_v1_pkg@1.0.0', {data: ['GHSA-fromids']});

        const installAt = Date.parse('2021-01-01T00:00:00Z');
        const history: HistoryFile = {
            projectKey: 'k',
            projectName: 'demo',
            lastSnapshot: {timestamp: installAt, packages: [{name: 'pkg', version: '1.0.0'}]},
            entries: [
                entry({timestamp: installAt, added: [{name: 'pkg', version: '1.0.0'}]})
            ]
        };

        const builder = new TimelineBuilder(cache);
        const out = builder.build(FAKE_PROJECT, history, false);

        expect(out.scannedVersions).toBe(1);
        expect(out.exposures).toHaveLength(1);
        // No published date in id-only entries → conservative "known-at-install"
        expect(out.exposures[0].classification).toBe('known-at-install');
        expect(out.exposures[0].publishedAt).toBeNull();
    });
});