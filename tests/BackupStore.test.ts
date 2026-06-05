import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BackupStore} from '../backend/Upgrade/BackupStore.js';

describe('BackupStore.save', () => {
    let tmp: string;
    let store: BackupStore;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-backup-'));
        store = new BackupStore(path.join(tmp, '.nppm', 'backups'));
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('snapshots existing files under a timestamped folder', () => {
        const pkg = path.join(tmp, 'package.json');
        fs.writeFileSync(pkg, '{"name":"x"}');

        const stamp = store.save(tmp, [pkg]);
        expect(stamp.files).toEqual(['package.json']);
        expect(fs.existsSync(path.join(stamp.dir, 'package.json'))).toBe(true);
        expect(fs.readFileSync(path.join(stamp.dir, 'package.json'), 'utf-8')).toBe('{"name":"x"}');
    });

    it('preserves the workspace-relative path inside the backup', () => {
        const wsDir = path.join(tmp, 'apps', 'api');
        fs.mkdirSync(wsDir, {recursive: true});
        const pkg = path.join(wsDir, 'package.json');
        fs.writeFileSync(pkg, '{}');

        const stamp = store.save(tmp, [pkg]);
        expect(stamp.files).toEqual([path.join('apps', 'api', 'package.json')]);
        expect(fs.existsSync(path.join(stamp.dir, 'apps', 'api', 'package.json'))).toBe(true);
    });

    it('silently skips files that do not exist', () => {
        const stamp = store.save(tmp, [path.join(tmp, 'ghost.json')]);
        expect(stamp.files).toEqual([]);
    });

    it('refuses to copy paths outside the base dir', () => {
        const outside = path.join(os.tmpdir(), `nppm-outside-${Date.now()}.json`);
        fs.writeFileSync(outside, '{}');
        try {
            const stamp = store.save(tmp, [outside]);
            expect(stamp.files).toEqual([]);
        } finally {
            fs.rmSync(outside, {force: true});
        }
    });
});