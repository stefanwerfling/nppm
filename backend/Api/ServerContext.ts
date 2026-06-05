import {Express} from 'express';
import fs from 'fs';
import {LoadedConfig} from '../Config/ConfigLoader.js';
import {Project} from '../Project/Project.js';
import {TemplateLoader} from '../Templates/TemplateLoader.js';
import {Template} from '../Templates/Template.js';

export type MutableConfig = {projects?: unknown[];} & Record<string, unknown>;

/**
 * Mutator-style writer over `nppm.json`. The mutator receives the
 * parsed object, applies its changes in place, and the wrapper
 * serialises with 2-space indent + trailing newline. Throws when the
 * config-file path isn't configured — the CLI can run with an inline
 * `rawConfig` but no on-disk file, in which case mutations must fail
 * loudly rather than silently disappear.
 */
export type ConfigMutator = (cfg: MutableConfig) => void;

/**
 * Construction inputs for `ServerContext`. Mirrors the shape of the
 * shared closure variables in the legacy `Server.plugin()` body so
 * the call site reads as a 1:1 wiring instead of a custom shape.
 */
export type ServerContextOpts = {
    app: Express;
    projectRoot: string;
    configFile: string|undefined;
    loaded: LoadedConfig;
    projects: Map<string, Project>;
    templateLoader: TemplateLoader;
    initialTemplates: Map<string, Template>;
};

/**
 * Shared state bag passed to every Controller. Holds the configured
 * paths, the lookup table of running projects, and the backend
 * services the route handlers need — everything that used to live as
 * closure-scoped consts inside the giant `configureServer` body.
 *
 * Mutating fields (`templates`, the `projects` map) are exposed
 * through public methods so a Controller never has to reach across
 * into another Controller's bookkeeping. The instance is constructed
 * once per `Server.plugin()` call and re-used by every Controller's
 * `register()` step.
 */
export class ServerContext {

    public readonly app: Express;
    public readonly projectRoot: string;
    public readonly configFile: string|undefined;
    public readonly loaded: LoadedConfig;
    public readonly projects: Map<string, Project>;
    public readonly templateLoader: TemplateLoader;
    private _templates: Map<string, Template>;

    public constructor(opts: ServerContextOpts) {
        this.app = opts.app;
        this.projectRoot = opts.projectRoot;
        this.configFile = opts.configFile;
        this.loaded = opts.loaded;
        this.projects = opts.projects;
        this.templateLoader = opts.templateLoader;
        this._templates = opts.initialTemplates;
    }

    public getProject(unid: string): Project|null {
        return this.projects.get(unid) ?? null;
    }

    /**
     * Reload the template catalogue from disk + refresh the cached map.
     * Several routes call this on every read so user edits to local
     * templates are picked up live.
     */
    public refreshTemplates(): Map<string, Template> {
        this._templates = this.templateLoader.loadAll();
        return this._templates;
    }

    public getTemplates(): Map<string, Template> {
        return this._templates;
    }

    /**
     * Read → mutate → write `nppm.json` atomically. The mutator
     * receives the parsed object; the wrapper serialises with
     * 2-space indent + trailing newline so the on-disk shape stays
     * stable across edits.
     */
    public mutateConfig(mutator: ConfigMutator): void {
        if (!this.configFile) {
            throw new Error('nppm.json path not configured — cannot persist changes');
        }
        if (!fs.existsSync(this.configFile)) {
            throw new Error(`nppm.json not found at ${this.configFile}`);
        }
        const raw = fs.readFileSync(this.configFile, 'utf-8');
        const cfg = JSON.parse(raw) as MutableConfig;
        mutator(cfg);
        fs.writeFileSync(this.configFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
    }
}