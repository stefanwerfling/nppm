import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ConfigLoader} from '../backend/Config/ConfigLoader.js';
import {NppmDirs} from '../backend/Config/NppmDirs.js';

/**
 * Focused on the resolved `proxy` bundle in `LoadedConfig` (step 18.1).
 * `ConfigLoader.build()` also constructs caches (which mkdir under the
 * project root) — every test therefore runs against a throwaway temp
 * dir that is removed afterwards.
 */
describe('ConfigLoader proxy resolution', () => {

    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-cfg-'));
        NppmDirs.resetForTests();
    });

    afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true});
        delete process.env.NPPM_TEST_PROXY_TOKEN;
    });

    it('defaults proxy off with npmjs upstream + /registry mount', () => {
        const {proxy} = ConfigLoader.build({projects: []}, root);
        expect(proxy.enabled).toBe(false);
        expect(proxy.upstream).toBe('https://registry.npmjs.org');
        expect(proxy.mountPath).toBe('/registry');
        expect(proxy.token).toBeUndefined();
        expect(proxy.storeDir).toBe(path.join(root, '.nppm', 'register'));
    });

    it('falls back to registry.url for the upstream when proxy.upstream is empty', () => {
        const {proxy} = ConfigLoader.build(
            {projects: [], registry: {url: 'https://npm.internal/'}, proxy: {enabled: true}},
            root
        );
        expect(proxy.enabled).toBe(true);
        expect(proxy.upstream).toBe('https://npm.internal/');
    });

    it('prefers an explicit proxy.upstream over registry.url', () => {
        const {proxy} = ConfigLoader.build(
            {
                projects: [],
                registry: {url: 'https://npm.internal/'},
                proxy: {upstream: 'https://mirror.example/'}
            },
            root
        );
        expect(proxy.upstream).toBe('https://mirror.example/');
    });

    it('normalises the mount path (adds leading slash, strips trailing)', () => {
        expect(ConfigLoader.build({projects: [], proxy: {mountPath: 'npm/'}}, root).proxy.mountPath)
        .toBe('/npm');
        NppmDirs.resetForTests();
        expect(ConfigLoader.build({projects: [], proxy: {mountPath: '/reg/'}}, root).proxy.mountPath)
        .toBe('/reg');
        NppmDirs.resetForTests();
        expect(ConfigLoader.build({projects: [], proxy: {mountPath: '/'}}, root).proxy.mountPath)
        .toBe('/');
    });

    it('expands a $ENV_VAR upstream token', () => {
        process.env.NPPM_TEST_PROXY_TOKEN = 'secret-123';
        const {proxy} = ConfigLoader.build(
            {projects: [], proxy: {token: '$NPPM_TEST_PROXY_TOKEN'}},
            root
        );
        expect(proxy.token).toBe('secret-123');
    });
});