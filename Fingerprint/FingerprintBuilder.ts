import crypto from 'crypto';
import {JsonCache} from '../Cache/JsonCache.js';
import {FileFingerprint, PackageFingerprint, PackageFingerprintManifest} from './Fingerprint.js';
import {isGitVersion, resolveGitTarball} from './GitResolver.js';
import {parseTarball, TarEntry} from './TarballParser.js';

/**
 * Cap on the content we'll keep alongside the hash. Larger files
 * (minified bundles, lockfile dumps) blow up cache size without
 * helping the heuristic scanner, which is regex-on-source.
 */
const CONTENT_MAX_BYTES = 100 * 1024;

/**
 * File extensions we treat as executable JS source — the only files
 * the Phase-5 scanner regex-matches against. `.ts`/`.tsx` are out
 * because they don't run on install; `.d.ts` is type-only.
 */
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function fileExtension(path: string): string {
    const slash = path.lastIndexOf('/');
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Quick binary-content check: a NUL byte in the first 1 KiB strongly
 * suggests this is not text. Lossy-but-fast — good enough to avoid
 * storing native binaries we accidentally classified as `.js`.
 */
function looksBinary(buf: Buffer): boolean {
    const window = buf.length > 1024 ? buf.subarray(0, 1024) : buf;
    return window.includes(0);
}

function shouldStoreContent(entry: TarEntry): boolean {
    if (entry.content.length > CONTENT_MAX_BYTES) {
        return false;
    }
    if (!JS_EXTENSIONS.has(fileExtension(entry.path))) {
        return false;
    }
    if (looksBinary(entry.content)) {
        return false;
    }
    return true;
}

/**
 * Extract the dep/scripts slice we care about from the tarball's own
 * `package.json`. Returns null when the file is missing or the JSON is
 * broken — both happen rarely in the wild, but a malformed tarball
 * should not nuke the whole fingerprint.
 */
function extractManifest(entries: TarEntry[]): PackageFingerprintManifest|null {
    const pkgJson = entries.find((e) => e.path === 'package.json');

    if (!pkgJson) {
        return null;
    }

    try {
        const parsed = JSON.parse(pkgJson.content.toString('utf-8')) as Record<string, unknown>;

        const asMap = (v: unknown): Record<string, string> => {
            if (!v || typeof v !== 'object') {
                return {};
            }
            const out: Record<string, string> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
                if (typeof val === 'string') {
                    out[k] = val;
                }
            }
            return out;
        };

        // License is sometimes a bare string (modern), sometimes the
        // deprecated `{type, url}` object, sometimes the legacy
        // `licenses: [{type}]` array. Coerce to a single SPDX-style
        // string here so `LicenseScanner` has only one shape to parse.
        let license: string|undefined;
        if (typeof parsed.license === 'string' && parsed.license.length > 0) {
            license = parsed.license;
        } else if (parsed.license && typeof parsed.license === 'object') {
            const type = (parsed.license as {type?: unknown}).type;
            if (typeof type === 'string' && type.length > 0) {
                license = type;
            }
        } else if (Array.isArray(parsed.licenses)) {
            const ids = parsed.licenses
                .map((l) => {
                    if (typeof l === 'string') {
                        return l;
                    }
                    if (l && typeof l === 'object') {
                        const t = (l as {type?: unknown}).type;
                        return typeof t === 'string' ? t : null;
                    }
                    return null;
                })
                .filter((s): s is string => typeof s === 'string' && s.length > 0);
            if (ids.length === 1) {
                license = ids[0];
            } else if (ids.length > 1) {
                license = `(${ids.join(' OR ')})`;
            }
        }

        return {
            dependencies: asMap(parsed.dependencies),
            devDependencies: asMap(parsed.devDependencies),
            peerDependencies: asMap(parsed.peerDependencies),
            optionalDependencies: asMap(parsed.optionalDependencies),
            scripts: asMap(parsed.scripts),
            license
        };
    } catch {
        return null;
    }
}

/**
 * Strategy for fetching the raw `.tgz` bytes for a given package
 * version. The default uses `registry.npmjs.org`; tests inject their
 * own. Returning `null` means "not found" — the builder propagates
 * this as a `null` fingerprint.
 */
export type TarballFetcher = (
    name: string,
    version: string
) => Promise<Buffer|null>;

/**
 * Default tarball fetcher pointed at the public npm registry. URL
 * shape (`/<pkg>/-/<basename>-<version>.tgz`) handles scoped names
 * because `<basename>` is the unscoped tail: `@scope/foo` → `foo-1.0.0.tgz`,
 * but the path prefix stays `/@scope/foo/-/foo-1.0.0.tgz`.
 *
 * Git-shaped `version` strings (`git+https://...`, `github:owner/repo`,
 * …) bypass the registry entirely and go through `GitResolver` to
 * `codeload.github.com`. Hosts the resolver doesn't recognise return
 * null — same contract as a registry 404.
 */
export function createNpmTarballFetcher(baseUrl = 'https://registry.npmjs.org'): TarballFetcher {
    const clean = baseUrl.replace(/\/$/, '');

    return async (name, version) => {
        if (isGitVersion(version)) {
            const spec = resolveGitTarball(version);
            if (!spec) {
                return null;
            }
            // GitLab (CloudFlare in front) rejects the default fetch
            // User-Agent with HTTP 406. Sending a real UA fixes that
            // and is also fine with GitHub codeload + Bitbucket.
            const res = await fetch(spec.url, {headers: {'User-Agent': 'nppm'}});
            if (res.status === 404) {
                return null;
            }
            if (!res.ok) {
                throw new Error(`Git tarball fetch ${spec.url} → ${res.status} ${res.statusText}`);
            }
            return Buffer.from(await res.arrayBuffer());
        }

        const basename = name.includes('/') ? name.split('/').pop()! : name;
        const namePath = name.includes('/')
            ? `${encodeURIComponent(name.split('/')[0])}/${encodeURIComponent(basename)}`
            : encodeURIComponent(name);
        const url = `${clean}/${namePath}/-/${basename}-${version}.tgz`;

        const res = await fetch(url);

        if (res.status === 404) {
            return null;
        }

        if (!res.ok) {
            throw new Error(`Tarball fetch ${url} → ${res.status} ${res.statusText}`);
        }

        const buf = await res.arrayBuffer();
        return Buffer.from(buf);
    };
}

/**
 * Builds + caches per-version fingerprints. Versions on npm are
 * immutable, so the cache pocket should be `permanent`; the builder
 * does not enforce that, but the production wiring in `vite.config.ts`
 * passes a permanent cache.
 */
export class FingerprintBuilder {

    private readonly _cache: JsonCache|null;
    private readonly _fetcher: TarballFetcher;

    constructor(cache: JsonCache|null, fetcher?: TarballFetcher) {
        this._cache = cache;
        this._fetcher = fetcher ?? createNpmTarballFetcher();
    }

    public async build(name: string, version: string): Promise<PackageFingerprint|null> {
        const key = this._cacheKey(name, version);

        if (this._cache) {
            // Use the {data: ...} envelope so a cached 404 (data:null) is
            // distinguishable from a cache miss (cache.get → null).
            type Wrap = {data: PackageFingerprint|null};
            const hit = this._cache.get<Wrap>(key);
            if (hit !== null) {
                return hit.data;
            }
        }

        const tgz = await this._fetcher(name, version);

        if (tgz === null) {
            this._cache?.set<{data: PackageFingerprint|null}>(key, {data: null});
            return null;
        }

        const entries = parseTarball(tgz);
        const files: FileFingerprint[] = entries.map((e) => {
            const file: FileFingerprint = {
                path: e.path,
                sha256: crypto.createHash('sha256').update(e.content).digest('hex'),
                size: e.content.length
            };
            if (shouldStoreContent(e)) {
                file.content = e.content.toString('utf8');
            }
            return file;
        });

        files.sort((a, b) => a.path.localeCompare(b.path));

        const fingerprint: PackageFingerprint = {
            name,
            version,
            files,
            manifest: extractManifest(entries),
            fetchedAt: Date.now()
        };

        this._cache?.set<{data: PackageFingerprint|null}>(key, {data: fingerprint});
        return fingerprint;
    }

    private _cacheKey(name: string, version: string): string {
        // Cache-version prefix. Bump when the cached fingerprint shape
        // changes OR when the parser produces different paths for the
        // same tarball:
        //   v2 — added `manifest` field
        //   v3 — TarballParser now strips any single top-level dir, not
        //        just `package/`, so `@types/*` tarballs no longer end
        //        up with `cookie-parser/<file>` paths and a null
        //        manifest.
        //   v4 — FileFingerprint.content optionally carries the JS
        //        source for the Phase-5 pattern scanner. Old v3 entries
        //        lack it and would yield empty scans, so we re-fetch.
        //   v5 — PackageFingerprintManifest carries a `license` field
        //        (coerced from the legacy `{type, url}` / `licenses[]`
        //        shapes). Old v4 entries would feed a `null` to the
        //        LicenseScanner forever.
        return `fp_v5_${name}@${version}`;
    }
}