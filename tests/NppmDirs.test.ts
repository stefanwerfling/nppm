import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {NppmDirs} from '../backend/Config/NppmDirs.js';

describe('NppmDirs', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-dirs-'));
        NppmDirs.resetForTests();
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
        NppmDirs.resetForTests();
    });

    it('returns the expected path for each bucket', () => {
        expect(NppmDirs.base(tmp)).toBe(path.join(tmp, '.nppm'));
        expect(NppmDirs.cache(tmp)).toBe(path.join(tmp, '.nppm', 'cache'));
        expect(NppmDirs.history(tmp)).toBe(path.join(tmp, '.nppm', 'history'));
        expect(NppmDirs.backups(tmp)).toBe(path.join(tmp, '.nppm', 'backups'));
    });

    it('migrates legacy folders on first access', () => {
        const legacyCache = path.join(tmp, '.nppm-cache');
        const legacyHistory = path.join(tmp, '.nppm-history');
        const legacyBackups = path.join(tmp, '.nppm-backups');
        fs.mkdirSync(legacyCache, {recursive: true});
        fs.mkdirSync(legacyHistory, {recursive: true});
        fs.mkdirSync(legacyBackups, {recursive: true});
        fs.writeFileSync(path.join(legacyCache, 'a.json'), '1');
        fs.writeFileSync(path.join(legacyHistory, 'b.json'), '2');
        fs.writeFileSync(path.join(legacyBackups, 'c.json'), '3');

        NppmDirs.cache(tmp);

        expect(fs.existsSync(legacyCache)).toBe(false);
        expect(fs.existsSync(legacyHistory)).toBe(false);
        expect(fs.existsSync(legacyBackups)).toBe(false);
        expect(fs.readFileSync(path.join(tmp, '.nppm', 'cache', 'a.json'), 'utf8')).toBe('1');
        expect(fs.readFileSync(path.join(tmp, '.nppm', 'history', 'b.json'), 'utf8')).toBe('2');
        expect(fs.readFileSync(path.join(tmp, '.nppm', 'backups', 'c.json'), 'utf8')).toBe('3');
    });

    it('is a no-op when nothing legacy exists', () => {
        NppmDirs.cache(tmp);

        expect(fs.existsSync(path.join(tmp, '.nppm'))).toBe(false);
    });

    it('leaves both sides alone when the target bucket already exists', () => {
        const legacyCache = path.join(tmp, '.nppm-cache');
        const newCache = path.join(tmp, '.nppm', 'cache');
        fs.mkdirSync(legacyCache, {recursive: true});
        fs.mkdirSync(newCache, {recursive: true});
        fs.writeFileSync(path.join(legacyCache, 'legacy.json'), 'L');
        fs.writeFileSync(path.join(newCache, 'new.json'), 'N');

        NppmDirs.cache(tmp);

        expect(fs.existsSync(legacyCache)).toBe(true);
        expect(fs.readFileSync(path.join(legacyCache, 'legacy.json'), 'utf8')).toBe('L');
        expect(fs.readFileSync(path.join(newCache, 'new.json'), 'utf8')).toBe('N');
    });

    it('migrates only the buckets whose target is empty', () => {
        fs.mkdirSync(path.join(tmp, '.nppm-cache'), {recursive: true});
        fs.mkdirSync(path.join(tmp, '.nppm-history'), {recursive: true});
        fs.mkdirSync(path.join(tmp, '.nppm', 'history'), {recursive: true});

        NppmDirs.cache(tmp);

        expect(fs.existsSync(path.join(tmp, '.nppm-cache'))).toBe(false);
        expect(fs.existsSync(path.join(tmp, '.nppm', 'cache'))).toBe(true);
        expect(fs.existsSync(path.join(tmp, '.nppm-history'))).toBe(true);
    });

    it('migrates each root only once per process', () => {
        const legacyCache = path.join(tmp, '.nppm-cache');
        fs.mkdirSync(legacyCache, {recursive: true});

        NppmDirs.cache(tmp);
        expect(fs.existsSync(legacyCache)).toBe(false);

        fs.mkdirSync(legacyCache, {recursive: true});
        fs.writeFileSync(path.join(legacyCache, 'second.json'), 'S');

        NppmDirs.cache(tmp);

        expect(fs.existsSync(legacyCache)).toBe(true);
        expect(fs.readFileSync(path.join(legacyCache, 'second.json'), 'utf8')).toBe('S');
    });
});