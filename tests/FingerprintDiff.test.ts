import {describe, expect, it} from 'vitest';
import {PackageFingerprint} from '../Fingerprint/Fingerprint.js';
import {FingerprintDiffer} from '../Fingerprint/FingerprintDiff.js';

function fp(name: string, version: string, files: {path: string; sha256: string}[]): PackageFingerprint {
    return {
        name,
        version,
        files: files.map((f) => ({path: f.path, sha256: f.sha256, size: 1})),
        manifest: null,
        fetchedAt: 0
    };
}

describe('FingerprintDiffer.diff', () => {
    it('reports added, removed and modified files', () => {
        const before = fp('x', '1.0.0', [
            {path: 'a.js', sha256: 'aaa'},
            {path: 'b.js', sha256: 'bbb'},
            {path: 'c.js', sha256: 'ccc'}
        ]);
        const after = fp('x', '1.0.1', [
            {path: 'a.js', sha256: 'aaa'},          // unchanged
            {path: 'b.js', sha256: 'BBB_CHANGED'},  // modified
            {path: 'd.js', sha256: 'ddd'}           // added (c removed)
        ]);

        const diff = FingerprintDiffer.diff(before, after);

        expect(diff.added.map((f) => f.path)).toEqual(['d.js']);
        expect(diff.removed.map((f) => f.path)).toEqual(['c.js']);
        expect(diff.modified).toHaveLength(1);
        expect(diff.modified[0].path).toBe('b.js');
        expect(diff.modified[0].before.sha256).toBe('bbb');
        expect(diff.modified[0].after.sha256).toBe('BBB_CHANGED');
    });

    it('returns empty lists for identical fingerprints', () => {
        const a = fp('x', '1.0.0', [{path: 'a.js', sha256: 'aaa'}]);
        const diff = FingerprintDiffer.diff(a, a);

        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.modified).toEqual([]);
    });

    it('sorts results by path for deterministic output', () => {
        const before = fp('x', '1.0.0', []);
        const after = fp('x', '1.0.1', [
            {path: 'z.js', sha256: 'z'},
            {path: 'a.js', sha256: 'a'},
            {path: 'm.js', sha256: 'm'}
        ]);

        const diff = FingerprintDiffer.diff(before, after);
        expect(diff.added.map((f) => f.path)).toEqual(['a.js', 'm.js', 'z.js']);
    });
});