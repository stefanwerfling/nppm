import path from 'path';
import {BundlephobiaFetcher} from '../Bundle/BundlephobiaFetcher.js';
import {JsonCache} from '../Cache/JsonCache.js';
import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {Project} from '../Project/Project.js';
import {ProjectGitea} from '../Project/ProjectGitea.js';
import {ProjectGithub} from '../Project/ProjectGithub.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {Registry} from '../Registry/Registry.js';
import {DepsDevFetcher} from '../Security/External/DepsDevFetcher.js';
import {OpenSsfFetcher} from '../Security/External/OpenSsfFetcher.js';
import {SocketDevFetcher} from '../Security/External/SocketDevFetcher.js';
import {ExternalSourcesScanner} from '../Security/ExternalSourcesScanner.js';
import {LicenseSeverity} from '../Security/LicenseScanner.js';
import {NpmUserFetcher} from '../Security/NpmUserFetcher.js';
import {OsvClient} from '../Security/OsvClient.js';
import {SecurityScanner} from '../Security/SecurityScanner.js';
import {UnusedDetector} from '../Unused/UnusedDetector.js';
import {ConfigProjectType} from './Config.js';
import {NppmDirs} from './NppmDirs.js';

/**
 * Optional hooks the caller can plug in. `onProjectLoaded` is the
 * place where the Vite plugin logs `📦 …` lines and the CLI stays
 * silent; `onSkip` is reserved for soft failures (e.g. a Gitea project
 * whose URL doesn't parse — the loader keeps going but tells the host
 * what was dropped).
 */
export type LoadedConfigHooks = {
    onProjectLoaded?: (project: Project) => void;
    onSkip?: (message: string) => void;
};

/**
 * Everything the two top-level callers (`vite.config.ts` and
 * `cli/Scan.ts`) need to share. Extras specific to one caller (the
 * Vite plugin builds a `ReleasesFetcher` + `HistoryStore`; the CLI
 * doesn't) are constructed at the call site, not here — this loader
 * stops at the scanner layer.
 */
export type LoadedConfig = {
    projectRoot: string;
    cacheDir: string;
    cacheTtlMinutes: number;
    registry: Registry;
    registryCache: JsonCache;
    remoteCache: JsonCache;
    fingerprintCache: JsonCache;
    fingerprintBuilder: FingerprintBuilder;
    osvClient: OsvClient;
    securityCache: JsonCache;
    securityScanner: SecurityScanner;
    unusedDetector: UnusedDetector;
    bundlephobiaFetcher: BundlephobiaFetcher;
    /**
     * External-sources aggregator (socket.dev + OpenSSF + deps.dev).
     * Already wired into `securityScanner` via constructor; exposed
     * separately so the Dashboard orchestrator can render N/A cells
     * when no source is configured.
     */
    externalScanner: ExternalSourcesScanner;
    /**
     * `actions.allowInstall` from the config. Defaults to `false`. The
     * dev server's "Edit + install" + per-package "Run script" buttons
     * are only exposed when this is true; the read-only paths
     * (preview, edit-only apply) work either way.
     */
    allowInstall: boolean;
    /**
     * `actions.editor` from the config — one of the keys supported by
     * the frontend `EditorUrl` map (`vscode`, `vscodium`, `cursor`,
     * `phpstorm`, `webstorm`, `idea`, `subl`). `undefined` when
     * absent / unknown — the frontend then hides every "Open in IDE"
     * button.
     */
    editor: string|undefined;
    /**
     * Resolved GitHub token for `api.github.com` and `codeload.github.com`
     * calls. Reads `actions.githubToken` from the config (literal or
     * `$VARNAME` placeholder) and falls back to `process.env.GH_TOKEN`
     * when empty. `undefined` means anonymous (60/h limit).
     */
    githubToken: string|undefined;
    /**
     * Projects in *config order*. The Vite plugin re-keys them by UUID
     * for its API surface; the CLI iterates the array directly. Order
     * is preserved so both surfaces agree on `--project=<name>`
     * matching and on the matrix column order.
     */
    projects: Project[];
};

/**
 * Bootstrap builder shared by `vite.config.ts` and `cli/Scan.ts`.
 * `build()` takes an already-validated raw config object and the
 * absolute project root; callers handle the validation step
 * themselves (Vite logs errors, CLI exits with code 2) so the loader
 * stays focused on the happy path.
 */
export class ConfigLoader {

    /**
     * Resolve a `"$VARNAME"` string into the corresponding env-var
     * value; pass anything else through unchanged. Used for token
     * fields so the config file never contains literal secrets.
     */
    public static expandEnv(value: string|undefined): string|undefined {
        if (!value) {
            return value;
        }
        const match = /^\$([A-Z_][A-Z0-9_]*)$/i.exec(value);
        if (!match) {
            return value;
        }
        return process.env[match[1]];
    }

    /**
     * Build the scanner/registry/project bundle from an *already
     * validated* config object. `raw` is typed as `unknown` because
     * VTS's static inference is intersection-of-Partial soup that
     * does not narrow on the discriminator — we branch on
     * `entry.type` with explicit casts (the "VTS union pitfall").
     */
    public static build(
        raw: unknown,
        projectRoot: string,
        hooks: LoadedConfigHooks = {}
    ): LoadedConfig {
        const cfg = raw as {
            projects?: unknown[];
            registry?: {url?: string; auth?: string;};
            cache?: {dir?: string; ttlMinutes?: number;};
            security?: {
                maintainer?: {
                    quickHandoverDays?: number;
                    suspiciousGapDays?: number;
                    matureVersions?: number;
                    trustWindow?: number;
                };
                license?: {
                    allowlist?: string[];
                    denylist?: string[];
                    treatUnknownAs?: string;
                };
                unused?: {
                    allowlist?: string[];
                    devPathGlobs?: string[];
                };
                external?: {
                    enabled?: boolean;
                    socket?: {enabled?: boolean; apiKey?: string;};
                    openssf?: {enabled?: boolean;};
                    depsDev?: {enabled?: boolean;};
                };
            };
            actions?: {
                allowInstall?: boolean;
                editor?: string;
                githubToken?: string;
            };
        };
        const allowInstall = cfg.actions?.allowInstall === true;
        const editor = typeof cfg.actions?.editor === 'string' && cfg.actions.editor.length > 0
            ? cfg.actions.editor
            : undefined;
        /*
         * Token resolution order:
         *   1. `actions.githubToken` literal or `$VAR` expansion
         *   2. `process.env.GH_TOKEN` (legacy default)
         *   3. undefined → anonymous (60/h)
         */
        const expandedGhToken = ConfigLoader.expandEnv(cfg.actions?.githubToken);
        const githubToken = expandedGhToken && expandedGhToken.length > 0
            ? expandedGhToken
            : process.env.GH_TOKEN;

        const registryUrl = cfg.registry?.url ?? 'https://registry.npmjs.org';
        const registryAuth = cfg.registry?.auth;
        const cacheDir = cfg.cache?.dir
            ? path.resolve(projectRoot, cfg.cache.dir)
            : NppmDirs.cache(projectRoot);
        const cacheTtlMinutes = typeof cfg.cache?.ttlMinutes === 'number' ? cfg.cache.ttlMinutes : 60;

        const registryCache = new JsonCache(path.join(cacheDir, 'registry'), cacheTtlMinutes);
        const registry = new Registry(registryUrl, registryCache, registryAuth);
        const remoteCache = new JsonCache(path.join(cacheDir, 'remote'), cacheTtlMinutes);

        /*
         * Fingerprint cache is permanent — published `pkg@version` is
         * immutable on npm. Bump the cache-key prefix in the builder
         * (`fp_v4_*` → `fp_v5_*`) when the cached shape changes.
         */
        const fingerprintCache = new JsonCache(
            path.join(cacheDir, 'fingerprint'),
            cacheTtlMinutes,
            {permanent: true}
        );
        const fingerprintBuilder = new FingerprintBuilder(fingerprintCache);

        const securityCache = new JsonCache(path.join(cacheDir, 'security'), cacheTtlMinutes);
        const osvClient = new OsvClient(securityCache);

        /*
         * User-document cache pocket (account creation date + 2FA
         * status). The registry frequently 401s anonymous reads of
         * `/-/user/*`, so most lookups cache as the explicit-null
         * envelope — that's still useful because it stops every
         * reload from re-asking. Replaces the older `npm-2fa` pocket.
         */
        const userCache = new JsonCache(path.join(cacheDir, 'npm-user'), cacheTtlMinutes);
        const userFetcher = new NpmUserFetcher(registryUrl, userCache, registryAuth);

        /*
         * `treatUnknownAs` arrives as a free-form string from the
         * config (VTS schema can't constrain it to enum values
         * without a custom validator). Unknown values fall back to
         * the scanner default by staying `undefined`.
         */
        const treatUnknownAsRaw = cfg.security?.license?.treatUnknownAs;
        const treatUnknownAs = Object.values(LicenseSeverity)
        .includes(treatUnknownAsRaw as LicenseSeverity)
            ? treatUnknownAsRaw as LicenseSeverity
            : undefined;

        /*
         * External-sources scanner — three TTL cache pockets, one per
         * upstream API. Disabled-by-default for socket (needs API key);
         * OpenSSF + deps.dev are free and on-by-default. The aggregator
         * gates each source independently from the loaded config, and
         * SecurityScanner reads the wrapper as a single dependency.
         */
        const socketKey = ConfigLoader.expandEnv(cfg.security?.external?.socket?.apiKey);
        const socketCache = new JsonCache(path.join(cacheDir, 'external-socket'), cacheTtlMinutes);
        const openssfCache = new JsonCache(path.join(cacheDir, 'external-openssf'), cacheTtlMinutes);
        const depsDevCache = new JsonCache(path.join(cacheDir, 'external-depsdev'), cacheTtlMinutes);
        const socketFetcher = new SocketDevFetcher(socketCache, socketKey);
        const openssfFetcher = new OpenSsfFetcher(openssfCache);
        const depsDevFetcher = new DepsDevFetcher(depsDevCache);
        const externalScanner = new ExternalSourcesScanner(
            registry,
            socketFetcher,
            openssfFetcher,
            depsDevFetcher,
            {
                enabled: cfg.security?.external?.enabled,
                socket: {enabled: cfg.security?.external?.socket?.enabled},
                openssf: {enabled: cfg.security?.external?.openssf?.enabled},
                depsDev: {enabled: cfg.security?.external?.depsDev?.enabled}
            }
        );

        const securityScanner = new SecurityScanner(
            osvClient,
            fingerprintBuilder,
            registry,
            {
                maintainer: cfg.security?.maintainer ?? {},
                license: {
                    allowlist: cfg.security?.license?.allowlist,
                    denylist: cfg.security?.license?.denylist,
                    treatUnknownAs: treatUnknownAs
                },
                userFetcher: userFetcher,
                external: externalScanner
            }
        );

        const unusedDetector = new UnusedDetector({
            allowlist: cfg.security?.unused?.allowlist,
            devPathGlobs: cfg.security?.unused?.devPathGlobs
        });

        /*
         * Bundle-size cache is permanent — bundlephobia computes
         * against an immutable `name@version`, so a once-resolved
         * result is correct forever. Network calls are bounded by
         * the fetcher's concurrency cap.
         */
        const bundleCache = new JsonCache(
            path.join(cacheDir, 'bundlephobia'),
            cacheTtlMinutes,
            {permanent: true}
        );
        const bundlephobiaFetcher = new BundlephobiaFetcher(bundleCache);

        const projects: Project[] = [];
        const rawProjects = (cfg.projects ?? []) as {type: ConfigProjectType; hidden?: boolean; templates?: string[];}[];
        for (let i = 0; i < rawProjects.length; i++) {
            const entry = rawProjects[i];
            const hidden = entry.hidden === true;
            const templates = Array.isArray(entry.templates) ? entry.templates : [];
            if (entry.type === ConfigProjectType.local) {
                const local = entry as {type: ConfigProjectType.local; path: string; name?: string;};
                const absRoot = path.resolve(projectRoot, local.path);
                const project = new ProjectLocal(absRoot, local.name, {hidden: hidden, configIndex: i, templates: templates});
                projects.push(project);
                hooks.onProjectLoaded?.(project);
            } else if (entry.type === ConfigProjectType.github) {
                const gh = entry as {
                    type: ConfigProjectType.github;
                    repo: string;
                    name?: string;
                    ref?: string;
                    token?: string;
                };
                const project = new ProjectGithub(
                    gh.repo,
                    gh.name ?? gh.repo,
                    gh.ref,
                    ConfigLoader.expandEnv(gh.token),
                    remoteCache,
                    {hidden: hidden, configIndex: i, templates: templates}
                );
                projects.push(project);
                hooks.onProjectLoaded?.(project);
            } else if (entry.type === ConfigProjectType.gitea) {
                const ge = entry as {
                    type: ConfigProjectType.gitea;
                    url: string;
                    name?: string;
                    ref?: string;
                    token?: string;
                };
                try {
                    const project = new ProjectGitea(
                        ge.url,
                        ge.name ?? ge.url,
                        ge.ref,
                        ConfigLoader.expandEnv(ge.token),
                        remoteCache,
                        {hidden: hidden, configIndex: i, templates: templates}
                    );
                    projects.push(project);
                    hooks.onProjectLoaded?.(project);
                } catch (e) {
                    hooks.onSkip?.(`gitea project skipped — ${(e as Error).message}`);
                }
            }
        }

        return {
            projectRoot: projectRoot,
            cacheDir: cacheDir,
            cacheTtlMinutes: cacheTtlMinutes,
            registry: registry,
            registryCache: registryCache,
            remoteCache: remoteCache,
            fingerprintCache: fingerprintCache,
            fingerprintBuilder: fingerprintBuilder,
            osvClient: osvClient,
            securityCache: securityCache,
            securityScanner: securityScanner,
            unusedDetector: unusedDetector,
            bundlephobiaFetcher: bundlephobiaFetcher,
            allowInstall: allowInstall,
            editor: editor,
            githubToken: githubToken,
            projects: projects,
            externalScanner: externalScanner
        };
    }

}