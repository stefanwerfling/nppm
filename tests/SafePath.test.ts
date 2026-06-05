import path from 'path';
import {describe, expect, it} from 'vitest';
import {SafePath} from '../backend/Project/SafePath.js';

describe('SafePath.join', () => {
    const root = '/srv/project';

    it('returns the root itself when no parts are appended', () => {
        expect(SafePath.join(root)).toBe(path.resolve(root));
    });

    it('joins a plain relative subpath', () => {
        expect(SafePath.join(root, 'package.json')).toBe(path.resolve(root, 'package.json'));
        expect(SafePath.join(root, 'src', 'index.ts')).toBe(path.resolve(root, 'src/index.ts'));
    });

    it('collapses `.` segments without escaping', () => {
        expect(SafePath.join(root, './package.json')).toBe(path.resolve(root, 'package.json'));
    });

    it('rejects a `..` segment that escapes the root', () => {
        expect(() => SafePath.join(root, '..', 'evil.json')).toThrow(/escapes project root/);
    });

    it('rejects a deep `..` chain that escapes via a workspace prefix', () => {
        /*
         * Models the upgrade-apply attack: workspace=`../../etc/cron.d/evil`,
         * segment=`package.json` — the resolved path lands outside `root`.
         */
        expect(() => SafePath.join(root, '../../etc/cron.d/evil', 'package.json'))
        .toThrow(/escapes project root/);
    });

    it('rejects an absolute segment that bypasses the root', () => {
        expect(() => SafePath.join(root, '/etc/passwd')).toThrow(/escapes project root/);
    });

    it('rejects a sibling whose path string accidentally starts with the root', () => {
        /*
         * `/srv/project-evil` is NOT inside `/srv/project` even though its
         * string starts with the same prefix. Naive `startsWith(root)`
         * would let it through; the `+ path.sep` boundary check stops it.
         */
        expect(() => SafePath.join('/srv/project', '../project-evil', 'package.json'))
        .toThrow(/escapes project root/);
    });

    it('treats a relative root the same way as an absolute one', () => {
        const rel = 'srv/project';
        const abs = path.resolve(rel);
        expect(SafePath.join(rel, 'package.json')).toBe(path.resolve(abs, 'package.json'));
        expect(() => SafePath.join(rel, '..', 'evil')).toThrow(/escapes project root/);
    });
});