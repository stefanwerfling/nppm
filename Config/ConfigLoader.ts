import path from 'path';
import {JsonCache} from '../Cache/JsonCache.js';
import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {Project} from '../Project/Project.js';
import {ProjectGitea} from '../Project/ProjectGitea.js';
import {ProjectGithub} from '../Project/ProjectGithub.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {Registry} from '../Registry/Registry.js';
import {LicenseSeverity} from '../Security/LicenseScanner.js';
import {Npm2FaFetcher} from '../Security/Npm2FaFetcher.js';
import {OsvClient} from '../Security/OsvClient.js';
import {SecurityScanner} from '../Security/SecurityScanner.js';
import {UnusedDetector} from '../Unused/UnusedDetector.js';
import {ConfigProjectType} from './Config.js';

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
 * `Cli/Scan.ts`) need to share. Extras specific to one caller (the
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
     * Projects in *config order*. The Vite plugin re-keys them by UUID
     * for its API surface; the CLI iterates the array directly. Order
     * is preserved so both surfaces agree on `--project=<name>`
     * matching and on the matrix column order.
     */
    projects: Project[];
};

/**
 * Bootstrap builder shared by `vite.config.ts` and `Cli/Scan.ts`.
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
            registry?: {url?: string; auth?: string};
            cache?: {dir?: string; ttlMinutes?: number};
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
            };
            actions?: {
                allowInstall?: boolean;
                editor?: string;
            };
        };
        const allowInstall = cfg.actions?.allowInstall === true;
        const editor = typeof cfg.actions?.editor === 'string' && cfg.actions.editor.length > 0
            ? cfg.actions.editor
            : undefined;

        const registryUrl = cfg.registry?.url ?? 'https://registry.npmjs.org';
        const registryAuth = cfg.registry?.auth;
        const cacheDir = cfg.cache?.dir
            ? path.resolve(projectRoot, cfg.cache.dir)
            : path.resolve(projectRoot, '.nppm-cache');
        const cacheTtlMinutes = typeof cfg.cache?.ttlMinutes === 'number' ? cfg.cache.ttlMinutes : 60;

        const registryCache = new JsonCache(path.join(cacheDir, 'registry'), cacheTtlMinutes);
        const registry = new Registry(registryUrl, registryCache, registryAuth);
        const remoteCache = new JsonCache(path.join(cacheDir, 'remote'), cacheTtlMinutes);

        // Fingerprint cache is permanent — published `pkg@version` is
        // immutable on npm. Bump the cache-key prefix in the builder
        // (`fp_v4_*` → `fp_v5_*`) when the cached shape changes.
        const fingerprintCache = new JsonCache(
            path.join(cacheDir, 'fingerprint'),
            cacheTtlMinutes,
            {permanent: true}
        );
        const fingerprintBuilder = new FingerprintBuilder(fingerprintCache);

        const securityCache = new JsonCache(path.join(cacheDir, 'security'), cacheTtlMinutes);
        const osvClient = new OsvClient(securityCache);

        // 2FA status rarely changes — reuse the registry TTL pocket so
        // cold-start cost is amortised across browser reloads. The
        // registry frequently 401s anonymous reads of `/-/user/*`, so
        // most lookups cache as "unknown"; that's still useful because
        // it stops every reload from re-asking.
        const tfaCache = new JsonCache(path.join(cacheDir, 'npm-2fa'), cacheTtlMinutes);
        const tfaFetcher = new Npm2FaFetcher(registryUrl, tfaCache, registryAuth);

        // `treatUnknownAs` arrives as a free-form string from the
        // config (VTS schema can't constrain it to enum values
        // without a custom validator). Unknown values fall back to
        // the scanner default by staying `undefined`.
        const treatUnknownAsRaw = cfg.security?.license?.treatUnknownAs;
        const treatUnknownAs = Object.values(LicenseSeverity)
            .includes(treatUnknownAsRaw as LicenseSeverity)
            ? treatUnknownAsRaw as LicenseSeverity
            : undefined;

        const securityScanner = new SecurityScanner(
            osvClient,
            fingerprintBuilder,
            registry,
            {
                maintainer: cfg.security?.maintainer ?? {},
                license: {
                    allowlist: cfg.security?.license?.allowlist,
                    denylist: cfg.security?.license?.denylist,
                    treatUnknownAs
                },
                tfaFetcher
            }
        );

        const unusedDetector = new UnusedDetector({
            allowlist: cfg.security?.unused?.allowlist,
            devPathGlobs: cfg.security?.unused?.devPathGlobs
        });

        const projects: Project[] = [];
        for (const entry of (cfg.projects ?? []) as Array<{type: ConfigProjectType}>) {
            if (entry.type === ConfigProjectType.local) {
                const local = entry as {type: ConfigProjectType.local; path: string; name?: string};
                const absRoot = path.resolve(projectRoot, local.path);
                const project = new ProjectLocal(absRoot, local.name);
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
                    remoteCache
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
                        remoteCache
                    );
                    projects.push(project);
                    hooks.onProjectLoaded?.(project);
                } catch (e) {
                    hooks.onSkip?.(`gitea project skipped — ${(e as Error).message}`);
                }
            }
        }

        return {
            projectRoot,
            cacheDir,
            cacheTtlMinutes,
            registry,
            registryCache,
            remoteCache,
            fingerprintCache,
            fingerprintBuilder,
            osvClient,
            securityCache,
            securityScanner,
            unusedDetector,
            allowInstall,
            editor,
            projects
        };
    }
}