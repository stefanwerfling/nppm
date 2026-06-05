import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {HistoryStore} from '../backend/History/HistoryStore.js';

describe('HistoryStore', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-hist-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns an empty record on first read', () => {
        const store = new HistoryStore(dir);
        const file = store.read('/proj', 'proj');
        expect(file.entries).toEqual([]);
        expect(file.lastSnapshot).toBeNull();
    });

    it('does not write an entry on the initial snapshot (only baseline)', () => {
        const store = new HistoryStore(dir);
        const entry = store.recordSnapshot('/proj', 'proj', 'hidden', [
            {name: 'foo', version: '1.0.0'}
        ]);
        expect(entry).toBeNull();

        const file = store.read('/proj', 'proj');
        expect(file.entries).toEqual([]);
        expect(file.lastSnapshot?.packages).toEqual([{name: 'foo', version: '1.0.0'}]);
    });

    it('records added/removed/updated against the prior snapshot', () => {
        const store = new HistoryStore(dir);
        store.recordSnapshot('/proj', 'proj', 'hidden', [
            {name: 'foo', version: '1.0.0'},
            {name: 'bar', version: '2.0.0'}
        ]);

        const entry = store.recordSnapshot('/proj', 'proj', 'hidden', [
            {name: 'foo', version: '1.0.1'},   // patch bump
            {name: 'baz', version: '0.1.0'}    // newly added; bar removed
        ]);

        expect(entry).not.toBeNull();
        expect(entry!.added).toEqual([{name: 'baz', version: '0.1.0'}]);
        expect(entry!.removed).toEqual([{name: 'bar', version: '2.0.0'}]);
        expect(entry!.updated).toHaveLength(1);
        expect(entry!.updated[0]).toMatchObject({
            name: 'foo',
            fromVersion: '1.0.0',
            toVersion: '1.0.1',
            bumpType: 'patch'
        });
        expect(entry!.updated[0].reason).toMatch(/patch-bump/);
    });

    it('returns null when nothing changed between snapshots', () => {
        const store = new HistoryStore(dir);
        store.recordSnapshot('/proj', 'proj', 'hidden', [{name: 'foo', version: '1.0.0'}]);
        const result = store.recordSnapshot('/proj', 'proj', 'hidden', [
            {name: 'foo', version: '1.0.0'}
        ]);
        expect(result).toBeNull();
        expect(store.read('/proj', 'proj').entries).toEqual([]);
    });

    it('annotates updated entries with CVE hints when the old version had vulns', () => {
        const store = new HistoryStore(dir);
        store.recordSnapshot('/proj', 'proj', 'hidden', [{name: 'lodash', version: '4.17.20'}]);

        const entry = store.recordSnapshot(
            '/proj',
            'proj',
            'hidden',
            [{name: 'lodash', version: '4.17.21'}],
            {
                cvesForOldVersion: (name, version) =>
                    name === 'lodash' && version === '4.17.20'
                        ? ['GHSA-29mw-wpgm-hmr9']
                        : null
            }
        );

        expect(entry!.updated[0].reason).toMatch(/GHSA-29mw-wpgm-hmr9/);
        expect(entry!.updated[0].reason).toMatch(/patch-bump/);
    });

    it('detects major/minor/patch bumps correctly', () => {
        const store = new HistoryStore(dir);
        store.recordSnapshot('/proj', 'proj', 'hidden', [
            {name: 'a', version: '1.0.0'},
            {name: 'b', version: '1.0.0'},
            {name: 'c', version: '1.0.0'}
        ]);
        const entry = store.recordSnapshot('/proj', 'proj', 'hidden', [
            {name: 'a', version: '2.0.0'},
            {name: 'b', version: '1.1.0'},
            {name: 'c', version: '1.0.1'}
        ]);

        const byName = new Map(entry!.updated.map((u) => [u.name, u.bumpType]));
        expect(byName.get('a')).toBe('major');
        expect(byName.get('b')).toBe('minor');
        expect(byName.get('c')).toBe('patch');
    });

    it('keeps two projects separate by key', () => {
        const store = new HistoryStore(dir);
        store.recordSnapshot('/a', 'a', 'hidden', [{name: 'x', version: '1.0.0'}]);
        store.recordSnapshot('/b', 'b', 'hidden', [{name: 'y', version: '2.0.0'}]);

        const a = store.read('/a', 'a');
        const b = store.read('/b', 'b');
        expect(a.lastSnapshot?.packages[0].name).toBe('x');
        expect(b.lastSnapshot?.packages[0].name).toBe('y');
    });
});
