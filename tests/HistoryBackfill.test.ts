import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {HistoryEntry} from '../History/History.js';
import {HistoryStore} from '../History/HistoryStore.js';

function gitEntry(ts: number, sha: string, added: {name: string; version: string}[]): HistoryEntry {
    return {
        timestamp: ts,
        lockfileSource: 'committed',
        added,
        removed: [],
        updated: [],
        source: 'git',
        commitSha: sha
    };
}

describe('HistoryStore.backfillFromGit', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-hbf-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('seeds entries and lastSnapshot on a fresh history file', () => {
        const store = new HistoryStore(dir);
        const summary = store.backfillFromGit(
            '/proj',
            'proj',
            [
                gitEntry(1000, 'aaa', [{name: 'foo', version: '1.0.0'}]),
                gitEntry(2000, 'bbb', [{name: 'bar', version: '2.0.0'}])
            ],
            'bbb',
            [{name: 'foo', version: '1.0.0'}, {name: 'bar', version: '2.0.0'}]
        );

        expect(summary.mergedCount).toBe(2);
        expect(summary.headSha).toBe('bbb');
        expect(summary.skippedReason).toBeNull();

        const file = store.read('/proj', 'proj');
        expect(file.entries).toHaveLength(2);
        expect(file.gitBackfilledHead).toBe('bbb');
        expect(file.lastSnapshot?.packages.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            {name: 'bar', version: '2.0.0'},
            {name: 'foo', version: '1.0.0'}
        ]);
    });

    it('short-circuits when HEAD has not moved', () => {
        const store = new HistoryStore(dir);
        const entries = [gitEntry(1000, 'aaa', [{name: 'foo', version: '1.0.0'}])];
        store.backfillFromGit('/p', 'p', entries, 'aaa', [{name: 'foo', version: '1.0.0'}]);

        const second = store.backfillFromGit('/p', 'p', entries, 'aaa', [{name: 'foo', version: '1.0.0'}]);
        expect(second.mergedCount).toBe(0);
        expect(second.skippedReason).toBe('head-unchanged');
    });

    it('recovers from a stale watermark with zero stored entries', () => {
        const store = new HistoryStore(dir);
        // Simulate a broken earlier run: watermark set, but no
        // entries were ever written. A naive `head === existing.head`
        // check would lock the project in this state forever.
        store.backfillFromGit('/p', 'p', [], 'aaa', [], false);
        const broken = store.read('/p', 'p');
        expect(broken.entries).toHaveLength(0);
        expect(broken.gitBackfilledHead).toBe('aaa');

        // Same HEAD, but now the walk produces entries — the store
        // must accept them instead of short-circuiting.
        const entries = [
            gitEntry(1000, 'c1', [{name: 'foo', version: '1.0.0'}]),
            gitEntry(2000, 'c2', [{name: 'bar', version: '2.0.0'}])
        ];
        const recovery = store.backfillFromGit('/p', 'p', entries, 'aaa', [
            {name: 'foo', version: '1.0.0'},
            {name: 'bar', version: '2.0.0'}
        ]);
        expect(recovery.mergedCount).toBe(2);
        expect(recovery.skippedReason).toBeNull();
        expect(store.read('/p', 'p').entries).toHaveLength(2);
    });

    it('does not overwrite lastSnapshot when nppm has already observed live state', () => {
        const store = new HistoryStore(dir);
        // Live snapshot first — installs not committed to git
        store.recordSnapshot('/p', 'p', 'hidden', [{name: 'live', version: '9.9.9'}]);

        const before = store.read('/p', 'p');
        expect(before.lastSnapshot?.packages).toEqual([{name: 'live', version: '9.9.9'}]);

        // Now backfill from git — git's final state was different
        store.backfillFromGit(
            '/p',
            'p',
            [gitEntry(1000, 'aaa', [{name: 'foo', version: '1.0.0'}])],
            'aaa',
            [{name: 'foo', version: '1.0.0'}]
        );

        const after = store.read('/p', 'p');
        // lastSnapshot stays as the live observation — git only added
        // to the timeline.
        expect(after.lastSnapshot?.packages).toEqual([{name: 'live', version: '9.9.9'}]);
        expect(after.entries).toHaveLength(1);
        expect(after.entries[0].source).toBe('git');
    });

    it('skips lastSnapshot seed when seedLastSnapshot is false', () => {
        const store = new HistoryStore(dir);
        store.backfillFromGit(
            '/p',
            'p',
            [gitEntry(1000, 'aaa', [{name: 'foo', version: '^1.0.0'}])],
            'aaa',
            [{name: 'foo', version: '^1.0.0'}],
            false  // package.json source — don't seed
        );

        const file = store.read('/p', 'p');
        expect(file.entries).toHaveLength(1);
        expect(file.lastSnapshot).toBeNull();
        expect(file.gitBackfilledHead).toBe('aaa');
    });

    it('next live recordSnapshot writes a clean baseline (no false diff) when not seeded', () => {
        const store = new HistoryStore(dir);
        // Backfill from package.json — no seed
        store.backfillFromGit(
            '/p',
            'p',
            [gitEntry(1000, 'aaa', [{name: 'foo', version: '^1.0.0'}])],
            'aaa',
            [{name: 'foo', version: '^1.0.0'}],
            false
        );

        // Live snapshot with resolved version → should be initial
        // baseline, NOT a "foo: ^1.0.0 → 1.0.5" update.
        const entry = store.recordSnapshot('/p', 'p', 'hidden', [
            {name: 'foo', version: '1.0.5'}
        ]);
        expect(entry).toBeNull();   // initial baseline = no entry written
        const file = store.read('/p', 'p');
        expect(file.lastSnapshot?.packages).toEqual([{name: 'foo', version: '1.0.5'}]);
    });

    it('dedupes by commit SHA on a second backfill run', () => {
        const store = new HistoryStore(dir);
        const e1 = gitEntry(1000, 'aaa', [{name: 'a', version: '1.0.0'}]);
        const e2 = gitEntry(2000, 'bbb', [{name: 'b', version: '2.0.0'}]);

        store.backfillFromGit('/p', 'p', [e1], 'aaa', [{name: 'a', version: '1.0.0'}]);
        const summary = store.backfillFromGit(
            '/p',
            'p',
            [e1, e2],
            'bbb',
            [{name: 'a', version: '1.0.0'}, {name: 'b', version: '2.0.0'}]
        );

        expect(summary.mergedCount).toBe(1);
        const file = store.read('/p', 'p');
        expect(file.entries.map((e) => e.commitSha)).toEqual(['aaa', 'bbb']);
    });
});
