import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {TemplateLoader} from '../Templates/TemplateLoader.js';

describe('TemplateLoader', () => {
    let tmp = '';
    let localDir = '';
    let remoteDir = '';

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-tplldr-'));
        localDir = path.join(tmp, 'nppm-templates');
        remoteDir = path.join(tmp, '.nppm', 'cache', 'templates-remote');
        fs.mkdirSync(localDir, {recursive: true});
    });

    afterEach(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    function writeTemplate(dir: string, id: string, body: object): void {
        const tplDir = path.join(dir, id);
        fs.mkdirSync(tplDir, {recursive: true});
        fs.writeFileSync(path.join(tplDir, 'template.json'), JSON.stringify({id, ...body}, null, 2));
    }

    it('returns empty map when no folders exist', () => {
        const loader = new TemplateLoader(localDir, remoteDir);
        expect(loader.loadAll().size).toBe(0);
    });

    it('marks loaded templates as local', () => {
        writeTemplate(localDir, 'foo', {});
        const loader = new TemplateLoader(localDir, remoteDir);
        loader.loadAll();
        expect(loader.getSource('foo')).toEqual({kind: 'local'});
    });

    it('refreshRemote writes fetched bodies to remoteDir with .source.json sidecar', async () => {
        const loader = new TemplateLoader(localDir, remoteDir);
        await loader.refreshRemote(['https://example.com/base.json'], {
            fetcher: async () => ({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({id: 'base', name: 'Base'})
            })
        });
        const written = JSON.parse(fs.readFileSync(path.join(remoteDir, 'base', 'template.json'), 'utf-8'));
        expect(written.id).toBe('base');
        const sidecar = JSON.parse(fs.readFileSync(path.join(remoteDir, 'base', '.source.json'), 'utf-8'));
        expect(sidecar.url).toBe('https://example.com/base.json');
    });

    it('loadAll surfaces remote-cached templates with the source url', async () => {
        const loader = new TemplateLoader(localDir, remoteDir);
        await loader.refreshRemote(['https://example.com/base.json'], {
            fetcher: async () => ({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({id: 'base', name: 'Base'})
            })
        });
        const out = loader.loadAll();
        expect(out.has('base')).toBe(true);
        expect(loader.getSource('base')).toEqual({kind: 'remote', url: 'https://example.com/base.json'});
    });

    it('local override wins when same id exists in both', async () => {
        writeTemplate(localDir, 'base', {name: 'Local Base'});
        const loader = new TemplateLoader(localDir, remoteDir);
        await loader.refreshRemote(['https://example.com/base.json'], {
            fetcher: async () => ({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({id: 'base', name: 'Remote Base'})
            })
        });
        const out = loader.loadAll();
        expect(out.get('base')?.name).toBe('Local Base');
        expect(loader.getSource('base')?.kind).toBe('local');
    });

    it('skips failed URLs without killing the refresh', async () => {
        const loader = new TemplateLoader(localDir, remoteDir);
        await loader.refreshRemote(
            ['https://bad.example/x', 'https://good.example/y'],
            {
                fetcher: async (url) => {
                    if (url.includes('bad')) {
                        return {ok: false, status: 500, text: async () => 'oops'};
                    }
                    return {ok: true, status: 200, text: async () => JSON.stringify({id: 'good'})};
                }
            }
        );
        expect(fs.existsSync(path.join(remoteDir, 'good', 'template.json'))).toBe(true);
        // The bad URL wasn't written.
        const entries = fs.readdirSync(remoteDir);
        expect(entries.sort()).toEqual(['good']);
    });

    it('rejects remote bodies that fail schema validation', async () => {
        const loader = new TemplateLoader(localDir, remoteDir);
        await loader.refreshRemote(['https://bad.example/x'], {
            // Missing `id` field — schema rejects.
            fetcher: async () => ({ok: true, status: 200, text: async () => JSON.stringify({name: 'no-id'})})
        });
        expect(fs.existsSync(remoteDir) ? fs.readdirSync(remoteDir) : []).toEqual([]);
    });

    it('getFilesDir routes to remoteDir for remote templates', async () => {
        const loader = new TemplateLoader(localDir, remoteDir);
        await loader.refreshRemote(['https://example.com/base.json'], {
            fetcher: async () => ({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({id: 'base'})
            })
        });
        loader.loadAll();
        expect(loader.getFilesDir('base')).toBe(path.join(remoteDir, 'base', 'files'));
        // Local template id falls back to localDir even if not loaded.
        expect(loader.getFilesDir('unknown')).toBe(path.join(localDir, 'unknown', 'files'));
    });
});