import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ApiRegistryLogEntry} from '../shared/Api/ApiTypes.js';
import {RegistryProxyController} from '../backend/Api/RegistryProxyController.js';
import {RegistryActivity} from '../backend/Registry/RegistryActivity.js';
import {RegistryDay, RegistryHistoryStore} from '../backend/Registry/RegistryHistoryStore.js';

function tarball(project: string, name: string, result: 'hit'|'miss'): ApiRegistryLogEntry {
    return {time: Date.now(), method: 'GET', project: project, name: name, version: '1.0.0', kind: 'tarball', result: result};
}

function packument(project: string, name: string): ApiRegistryLogEntry {
    return {time: Date.now(), method: 'GET', project: project, name: name, kind: 'packument', result: 'hit'};
}

describe('RegistryHistoryStore', () => {

    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-reghist-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('round-trips a day through save/load', () => {
        const store = new RegistryHistoryStore(dir);
        const day: RegistryDay = {
            date: '2026-09-30',
            projects: {
                swipemeister: {hits: 3, misses: 1, packuments: 5, tarballs: 4, notFound: 0, errors: 0, packages: {lodash: {hits: 3, misses: 1}}}
            }
        };
        store.save(day);
        const back = store.load('2026-09-30');
        expect(back.projects.swipemeister.hits).toBe(3);
        expect(back.projects.swipemeister.packages.lodash.misses).toBe(1);
    });

    it('returns an empty day for a missing file', () => {
        const store = new RegistryHistoryStore(dir);
        const day = store.load('2000-01-01');
        expect(day.date).toBe('2000-01-01');
        expect(Object.keys(day.projects)).toHaveLength(0);
    });

    it('readRange filters by cutoff and sorts chronologically', () => {
        const store = new RegistryHistoryStore(dir);
        const mk = (date: string): RegistryDay => ({
            date: date,
            projects: {a: {hits: 1, misses: 0, packuments: 0, tarballs: 1, notFound: 0, errors: 0, packages: {}}}
        });
        const nowMs = Date.parse('2026-09-30T12:00:00Z');
        store.save(mk('2026-09-29'));
        store.save(mk('2026-09-25'));
        store.save(mk('2026-01-01')); // outside a 30-day window
        const days = store.readRange(30, nowMs);
        expect(days.map((d) => d.date)).toEqual(['2026-09-25', '2026-09-29']);
    });

    it('readRange projects to sorted per-project stats without the package map', () => {
        const store = new RegistryHistoryStore(dir);
        store.save({
            date: '2026-09-30',
            projects: {
                zulu: {hits: 1, misses: 0, packuments: 2, tarballs: 1, notFound: 0, errors: 0, packages: {x: {hits: 1, misses: 0}}},
                alpha: {hits: 0, misses: 2, packuments: 1, tarballs: 2, notFound: 1, errors: 0, packages: {}}
            }
        });
        const [day] = store.readRange(90, Date.parse('2026-09-30T12:00:00Z'));
        expect(day.projects.map((p) => p.project)).toEqual(['alpha', 'zulu']);
        expect((day.projects[1] as unknown as {packages?: unknown;}).packages).toBeUndefined();
    });
});

describe('RegistryActivity', () => {

    it('tallies per project and per package', () => {
        const act = new RegistryActivity();
        act.record(packument('web', 'lodash'));
        act.record(tarball('web', 'lodash', 'hit'));
        act.record(tarball('api', 'express', 'miss'));

        const stats = act.perProject();
        const web = stats.find((s) => s.project === 'web');
        const api = stats.find((s) => s.project === 'api');
        expect(web).toMatchObject({hits: 1, misses: 0, packuments: 1, tarballs: 1});
        expect(api).toMatchObject({hits: 0, misses: 1, tarballs: 1});

        expect(act.counters()).toEqual({hits: 1, misses: 1});
        expect(act.pkgHits().get('lodash')).toBe(1);
        // express was tarball-requested but only missed → 0 hits, not absent.
        expect(act.pkgHits().get('express')).toBe(0);
    });

    it('persists tallies and seeds them back on the next instance', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-regact-'));
        try {
            const store = new RegistryHistoryStore(dir);
            // Long flush delay → rely on explicit flush(), no timer races.
            const act = new RegistryActivity(store, 200, 10_000_000);
            act.record(tarball('web', 'lodash', 'hit'));
            act.record(tarball('web', 'lodash', 'miss'));
            act.flush();

            const reopened = new RegistryActivity(store);
            expect(reopened.counters()).toEqual({hits: 1, misses: 1});
            expect(reopened.perProject().find((s) => s.project === 'web')?.tarballs).toBe(2);
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    });
});

describe('RegistryProxyController.resolveProject', () => {

    const labels = new Map<string, string>([['swipemeister', 'swipemeister']]);

    it('treats a bare package name as the default bucket', () => {
        expect(RegistryProxyController.resolveProject(labels, 'lodash')).toEqual({project: 'default', segment: null, rest: 'lodash'});
    });

    it('buckets a known project segment and strips it', () => {
        expect(RegistryProxyController.resolveProject(labels, 'swipemeister/lodash')).toEqual({project: 'swipemeister', segment: 'swipemeister', rest: 'lodash'});
    });

    it('keeps the /-/ tarball split intact after stripping the project', () => {
        const r = RegistryProxyController.resolveProject(labels, 'swipemeister/lodash/-/lodash-1.0.0.tgz');
        expect(r.project).toBe('swipemeister');
        expect(r.rest).toBe('lodash/-/lodash-1.0.0.tgz');
    });

    it('leaves a scoped packument in the default bucket', () => {
        expect(RegistryProxyController.resolveProject(labels, '@babel%2fcore')).toEqual({project: 'default', segment: null, rest: '@babel%2fcore'});
    });

    it('buckets a scoped packument under a project segment', () => {
        const r = RegistryProxyController.resolveProject(labels, 'swipemeister/@babel%2fcore');
        expect(r.project).toBe('swipemeister');
        expect(r.rest).toBe('@babel%2fcore');
    });

    it('matches the project label case-insensitively', () => {
        expect(RegistryProxyController.resolveProject(labels, 'SwipeMeister/lodash').project).toBe('swipemeister');
    });

    it('resolves a project ping (segment only, no package)', () => {
        expect(RegistryProxyController.resolveProject(labels, 'swipemeister')).toEqual({project: 'swipemeister', segment: 'swipemeister', rest: ''});
    });

    it('does NOT bucket an unknown segment when allowAny is off', () => {
        expect(RegistryProxyController.resolveProject(labels, 'foobar/lodash', false))
        .toEqual({project: 'default', segment: null, rest: 'foobar/lodash'});
    });

    describe('allowAny (free-form buckets)', () => {
        it('buckets any unknown first segment', () => {
            expect(RegistryProxyController.resolveProject(labels, 'foobar/lodash', true))
            .toEqual({project: 'foobar', segment: 'foobar', rest: 'lodash'});
        });

        it('still resolves configured names to their canonical form', () => {
            expect(RegistryProxyController.resolveProject(labels, 'SwipeMeister/lodash', true).project).toBe('swipemeister');
        });

        it('keeps a single-segment bare packument in the default bucket', () => {
            expect(RegistryProxyController.resolveProject(labels, 'lodash', true))
            .toEqual({project: 'default', segment: null, rest: 'lodash'});
        });

        it('keeps a bare unscoped tarball (rest starts with -/) in the default bucket', () => {
            expect(RegistryProxyController.resolveProject(labels, 'lodash/-/lodash-1.0.0.tgz', true))
            .toEqual({project: 'default', segment: null, rest: 'lodash/-/lodash-1.0.0.tgz'});
        });

        it('keeps a scoped (@) first segment in the default bucket', () => {
            expect(RegistryProxyController.resolveProject(labels, '@babel/core/-/core-1.0.0.tgz', true).project).toBe('default');
        });

        it('buckets an ad-hoc project in front of a scoped package', () => {
            const r = RegistryProxyController.resolveProject(labels, 'foobar/@babel%2fcore', true);
            expect(r.project).toBe('foobar');
            expect(r.rest).toBe('@babel%2fcore');
        });

        it('buckets an ad-hoc project in front of an unscoped tarball', () => {
            const r = RegistryProxyController.resolveProject(labels, 'foobar/lodash/-/lodash-1.0.0.tgz', true);
            expect(r.project).toBe('foobar');
            expect(r.rest).toBe('lodash/-/lodash-1.0.0.tgz');
        });
    });
});