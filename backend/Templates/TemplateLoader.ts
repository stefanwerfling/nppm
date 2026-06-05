import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {NppmDirs} from '../Config/NppmDirs.js';
import {SchemaTemplate, Template} from './Template.js';

/**
 * Where a loaded template came from. `local` templates live on disk
 * under `<dir>/<id>/template.json` and are CRUD-able via the API;
 * `remote` ones are fetched + cached on boot from
 * `templateSources[]` and are read-only.
 */
export type TemplateSource =
    | {kind: 'local';}
    | {kind: 'remote'; url: string;};

/**
 * Minimal `fetch`-compatible signature so tests can inject a fake
 * fetcher. Mirrors the global `fetch` enough for our needs:
 * `Response.ok` + `text()`.
 */
export type TemplateFetcher = (url: string) => Promise<{ok: boolean; status: number; text(): Promise<string>;}>;

/**
 * Reads templates from a `<dir>/<id>/template.json` directory tree.
 * Two source kinds are supported:
 *  - Local: user-editable, sits under `nppm-templates/`. CRUD routes
 *    operate on these.
 *  - Remote: fetched + validated on boot via `refreshRemote()`,
 *    cached under `remoteDir/<id>/`. Read-only.
 *
 * `loadAll()` walks both directories and returns a unified map;
 * conflicts (same id local + remote) prefer local — the user's own
 * override wins over the upstream catalogue.
 */
export class TemplateLoader {

    private readonly _dir: string;
    private readonly _remoteDir: string;
    private readonly _sources = new Map<string, TemplateSource>();

    constructor(dir: string, remoteDir?: string) {
        this._dir = dir;
        this._remoteDir = remoteDir ?? path.join(NppmDirs.cache(path.join(dir, '..')), 'templates-remote');
    }

    public getDir(): string {
        return this._dir;
    }

    public getRemoteDir(): string {
        return this._remoteDir;
    }

    public getFilesDir(templateId: string): string {
        const src = this._sources.get(templateId);
        if (src && src.kind === 'remote') {
            return path.join(this._remoteDir, templateId, 'files');
        }
        return path.join(this._dir, templateId, 'files');
    }

    /**
     * Resolve where a given template id came from. Returns `null` for
     * ids the loader didn't see on the last `loadAll()` pass.
     */
    public getSource(templateId: string): TemplateSource|null {
        return this._sources.get(templateId) ?? null;
    }

    public loadAll(): Map<string, Template> {
        const result = new Map<string, Template>();
        this._sources.clear();
        this._walk(
            this._dir,
            () => true,
            (id, _tplDir, tpl) => {
                result.set(id, tpl);
                this._sources.set(id, {kind: 'local'});
            }
        );
        if (fs.existsSync(this._remoteDir)) {
            this._walk(
                this._remoteDir,
                (id) => !this._sources.has(id),
                (id, tplDir, tpl) => {
                    let url = '';
                    const sourceFile = path.join(tplDir, '.source.json');
                    if (fs.existsSync(sourceFile)) {
                        try {
                            const parsed = JSON.parse(fs.readFileSync(sourceFile, 'utf-8')) as {url?: string;};
                            url = parsed.url ?? '';
                        } catch {
                            /*
                             * ignore — empty url means "we fetched it
                             * but the sidecar got corrupted", still a
                             * valid remote
                             */
                        }
                    }
                    result.set(id, tpl);
                    this._sources.set(id, {kind: 'remote', url: url});
                }
            );
        }
        return result;
    }

    /**
     * Fetch each URL, validate against `SchemaTemplate`, and store the
     * body under `remoteDir/<id>/template.json` plus a `.source.json`
     * sidecar recording the URL. Network / parse / schema failures are
     * per-URL warnings — one bad source doesn't kill the whole refresh.
     */
    public async refreshRemote(urls: string[], opts: {fetcher?: TemplateFetcher;} = {}): Promise<void> {
        if (urls.length === 0) {
            return;
        }
        const fetcher: TemplateFetcher = opts.fetcher ?? (
            async(url: string) => {
                const res = await fetch(url);
                return {ok: res.ok, status: res.status, text: () => res.text()};
            }
        );
        fs.mkdirSync(this._remoteDir, {recursive: true});
        for (const url of urls) {
            try {
                const res = await fetcher(url);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const text = await res.text();
                const parsed = JSON.parse(text) as unknown;
                const errors: SchemaErrors = [];
                if (!SchemaTemplate.validate(parsed, errors)) {
                    console.warn(`nppm: remote template ${url} invalid: ${JSON.stringify(errors)}`);
                    continue;
                }
                const tpl = parsed as Template;
                const tplDir = path.join(this._remoteDir, tpl.id);
                fs.mkdirSync(tplDir, {recursive: true});
                fs.writeFileSync(
                    path.join(tplDir, 'template.json'),
                    `${JSON.stringify(tpl, null, 2)  }\n`
                );
                fs.writeFileSync(
                    path.join(tplDir, '.source.json'),
                    `${JSON.stringify({url: url, fetchedAt: Date.now()}, null, 2)  }\n`
                );
            } catch (e) {
                console.warn(`nppm: remote template ${url} failed to load: ${(e as Error).message}`);
            }
        }
    }

    private _walk(
        dir: string,
        shouldLoad: (id: string) => boolean,
        onLoaded: (id: string, tplDir: string, tpl: Template) => void
    ): void {
        if (!fs.existsSync(dir)) {
            return;
        }
        const entries = fs.readdirSync(dir, {withFileTypes: true});
        for (const d of entries) {
            if (!d.isDirectory()) {
                continue;
            }
            const tplDir = path.join(dir, d.name);
            const manifest = path.join(tplDir, 'template.json');
            if (!fs.existsSync(manifest)) {
                continue;
            }
            if (!shouldLoad(d.name)) {
                continue;
            }
            try {
                const parsed = this._loadOne(manifest, d.name);
                onLoaded(parsed.id, tplDir, parsed);
            } catch (e) {
                console.warn(`nppm: template "${d.name}" failed to load: ${(e as Error).message}`);
            }
        }
    }

    private _loadOne(manifestPath: string, folderId: string): Template {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        const errors: SchemaErrors = [];
        if (!SchemaTemplate.validate(parsed, errors)) {
            throw new Error(`schema errors: ${JSON.stringify(errors)}`);
        }
        const t = parsed;
        if (t.id !== folderId) {
            throw new Error(`folder name "${folderId}" does not match template.id "${t.id}"`);
        }
        return t;
    }

}