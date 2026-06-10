import {Express} from 'express';
import fs from 'fs';
import {LoadedConfig} from '../Config/ConfigLoader.js';
import {DashboardHistoryStore} from '../Dashboard/DashboardHistoryStore.js';
import {NpmDownloadsFetcher} from '../Downloads/NpmDownloadsFetcher.js';
import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {GitHistoryBackfill} from '../History/GitHistoryBackfill.js';
import {HistoryStore} from '../History/HistoryStore.js';
import {RemoteGitHistoryBackfill} from '../History/RemoteGitHistoryBackfill.js';
import {PrReviewBuilder} from '../PrReview/PrReviewBuilder.js';
import {Project} from '../Project/Project.js';
import {GitCommitsFetcher} from '../Releases/GitCommitsFetcher.js';
import {GitHeadFetcher} from '../Releases/GitHeadFetcher.js';
import {ReleasesFetcher} from '../Releases/ReleasesFetcher.js';
import {IgnoredFinding, IgnoredFindings} from '../Security/IgnoredFindings.js';
import {IntegrityScanner} from '../Security/IntegrityScanner.js';
import {SelfCodeScanner} from '../SelfCode/SelfCodeScanner.js';
import {SourceGraphBuilder} from '../SourceGraph/SourceGraphBuilder.js';
import {TemplateComplianceChecker} from '../Templates/TemplateComplianceChecker.js';
import {TemplateLoader} from '../Templates/TemplateLoader.js';
import {Template} from '../Templates/Template.js';
import {TimelineBuilder} from '../Vulnerability/TimelineBuilder.js';

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
    templatesDir: string;
    templateLoader: TemplateLoader;
    templateChecker: TemplateComplianceChecker;
    initialTemplates: Map<string, Template>;
    historyStore: HistoryStore;
    gitBackfill: GitHistoryBackfill;
    remoteBackfill: RemoteGitHistoryBackfill;
    timelineBuilder: TimelineBuilder;
    prReviewBuilder: PrReviewBuilder;
    integrityScanner: IntegrityScanner;
    headFingerprintBuilder: FingerprintBuilder;
    releasesFetcher: ReleasesFetcher;
    gitHeadFetcher: GitHeadFetcher;
    gitCommitsFetcher: GitCommitsFetcher;
    dashboardSnapshotPath: string;
    dashboardHistoryStore: DashboardHistoryStore;
    downloadsFetcher: NpmDownloadsFetcher;
    sourceGraphBuilder: SourceGraphBuilder;
    selfCodeScanner: SelfCodeScanner;
    initialIgnoredFindings: IgnoredFinding[];
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
    public readonly templatesDir: string;
    public readonly templateLoader: TemplateLoader;
    public readonly templateChecker: TemplateComplianceChecker;
    public readonly historyStore: HistoryStore;
    public readonly gitBackfill: GitHistoryBackfill;
    public readonly remoteBackfill: RemoteGitHistoryBackfill;
    public readonly timelineBuilder: TimelineBuilder;
    public readonly prReviewBuilder: PrReviewBuilder;
    public readonly integrityScanner: IntegrityScanner;
    public readonly headFingerprintBuilder: FingerprintBuilder;
    public readonly releasesFetcher: ReleasesFetcher;
    public readonly gitHeadFetcher: GitHeadFetcher;
    public readonly gitCommitsFetcher: GitCommitsFetcher;
    public readonly dashboardSnapshotPath: string;
    public readonly dashboardHistoryStore: DashboardHistoryStore;
    public readonly downloadsFetcher: NpmDownloadsFetcher;
    public readonly sourceGraphBuilder: SourceGraphBuilder;
    public readonly selfCodeScanner: SelfCodeScanner;
    private _templates: Map<string, Template>;
    private _ignoredFindings: IgnoredFindings;

    public constructor(opts: ServerContextOpts) {
        this.app = opts.app;
        this.projectRoot = opts.projectRoot;
        this.configFile = opts.configFile;
        this.loaded = opts.loaded;
        this.projects = opts.projects;
        this.templatesDir = opts.templatesDir;
        this.templateLoader = opts.templateLoader;
        this.templateChecker = opts.templateChecker;
        this.historyStore = opts.historyStore;
        this.gitBackfill = opts.gitBackfill;
        this.remoteBackfill = opts.remoteBackfill;
        this.timelineBuilder = opts.timelineBuilder;
        this.prReviewBuilder = opts.prReviewBuilder;
        this.integrityScanner = opts.integrityScanner;
        this.headFingerprintBuilder = opts.headFingerprintBuilder;
        this.releasesFetcher = opts.releasesFetcher;
        this.gitHeadFetcher = opts.gitHeadFetcher;
        this.gitCommitsFetcher = opts.gitCommitsFetcher;
        this.dashboardSnapshotPath = opts.dashboardSnapshotPath;
        this.dashboardHistoryStore = opts.dashboardHistoryStore;
        this.downloadsFetcher = opts.downloadsFetcher;
        this.sourceGraphBuilder = opts.sourceGraphBuilder;
        this.selfCodeScanner = opts.selfCodeScanner;
        this._templates = opts.initialTemplates;
        this._ignoredFindings = new IgnoredFindings(opts.initialIgnoredFindings);
    }

    public getIgnoredFindings(): IgnoredFindings {
        return this._ignoredFindings;
    }

    /**
     * Swap the in-memory snapshot after `mutateConfig` writes a new
     * `security.ignored` list to `nppm.json`. Cheap — only the
     * controllers that read the list (Security / Matrix heuristics /
     * Dashboard scan) pay attention; cached scanner results stay valid
     * because the underlying tarball/manifest data hasn't changed.
     */
    public setIgnoredFindings(entries: IgnoredFinding[]): void {
        this._ignoredFindings = IgnoredFindings.fromEntries(entries);
    }

    /**
     * For coordinates whose content is mutable (a git URL pointing at
     * HEAD or a branch/tag — i.e. anything other than a 40-char SHA
     * ref), permanent caching is wrong: the tarball moves under our
     * feet. This helper picks between the permanent
     * `loaded.fingerprintBuilder` and the cache-less HEAD-aware
     * `headFingerprintBuilder`.
     */
    public pickFingerprintBuilder(version: string): FingerprintBuilder {
        if (!GitResolver.isGitVersion(version)) {
            return this.loaded.fingerprintBuilder;
        }
        const hash = version.indexOf('#');
        if (hash < 0) {
            return this.headFingerprintBuilder;
        }
        const ref = version.slice(hash + 1);
        return /^[0-9a-f]{40}$/iu.test(ref) ? this.loaded.fingerprintBuilder : this.headFingerprintBuilder;
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