import {createHash} from 'crypto';
import {Lockfile, LockedPackage} from '../Project/Lockfile.js';
import {Project} from '../Project/Project.js';
import {Registry} from '../Registry/Registry.js';
import {Purl} from './Purl.js';

/**
 * One package as the SBOM emitters see it. Format-agnostic on
 * purpose: both CycloneDX and SPDX can render this with no further
 * lookups. `purl` is the cross-format identity; `hashSha512Hex` is
 * derived from the lockfile's integrity field (sha512-base64 → hex)
 * because both formats want lowercase hex, not base64.
 */
export type SbomComponent = {
    name: string;
    version: string;
    purl: string;
    /** Resolved tarball URL from the lockfile, when present. */
    resolved: string|null;
    /**
     * Lowercase hex SHA-512 of the tarball — `null` if the lockfile
     *  carried no integrity (or carried a non-sha512 algorithm we
     *  don't transcode). 
     */
    hashSha512Hex: string|null;
    /**
     * Raw SPDX-style license string from the registry packument. `null`
     *  when missing — SBOM formats render that as NOASSERTION /
     *  unknown. 
     */
    license: string|null;
    /**
     * Raw `repository` value from the packument (typically a git URL).
     *  Echoed verbatim — both formats accept any URL string here. 
     */
    repository: string|null;
    /**
     * Direct `name → range` map this package declared in its own
     *  `dependencies` (lockfile entry). Drives the SBOM dependency
     *  graph. Empty for leaves. 
     */
    directDeps: Record<string, string>;
};

/**
 * Aggregated payload one project hands to a builder. `urn` is the
 * unique identifier inside the SBOM (CycloneDX `serialNumber` and
 * SPDX `documentNamespace` seed); both formats want the *same*
 * package referenced by the same key everywhere, so we build it once
 * here.
 */
export type SbomData = {
    project: {
        name: string;
        urn: string;
        generatedAt: string;
    };
    components: SbomComponent[];
};

/**
 * Walks a project's lockfile + registry into a format-agnostic
 * `SbomData`. Pure I/O on the registry side — no fingerprint
 * downloads. A SBOM is about *identity + provenance*, not tarball
 * contents.
 */
export class SbomCollector {

    private readonly _registry: Registry;
    private readonly _now: () => Date;

    constructor(registry: Registry, now: () => Date = () => new Date()) {
        this._registry = registry;
        this._now = now;
    }

    public async collect(project: Project): Promise<SbomData> {
        const lockfile: Lockfile|null = await project.loadLockfile();
        const unique = lockfile ? SbomCollector._dedupe(lockfile.packages) : [];

        /*
         * One registry hit per *name* (versions share metadata) — the
         * cache layer takes care of the rest.
         */
        const distinctNames = Array.from(new Set(unique.map((p) => p.name)));
        const packuments = new Map<string, Awaited<ReturnType<Registry['fetchOne']>>>();
        await Promise.all(distinctNames.map(async(n) => {
            try {
                packuments.set(n, await this._registry.fetchOne(n));
            } catch {
                packuments.set(n, null);
            }
        }));

        const components: SbomComponent[] = unique.map((p) => {
            const pack = packuments.get(p.name) ?? null;
            return {
                name: p.name,
                version: p.version,
                purl: Purl.npm(p.name, p.version),
                resolved: p.resolved ?? null,
                hashSha512Hex: SbomCollector._integrityToHex(p.integrity),
                license: pack?.license ?? null,
                repository: pack?.repository ?? null,
                directDeps: p.deps ?? {}
            };
        });

        components.sort((a, b) => {
            const n = a.name.localeCompare(b.name);
            return n !== 0 ? n : a.version.localeCompare(b.version);
        });

        const ts = this._now().toISOString();
        return {
            project: {
                name: project.getName(),
                urn: `urn:uuid:${SbomCollector._uuidLike(project.getName(), ts)}`,
                generatedAt: ts
            },
            components: components
        };
    }

    /**
     * Convert the lockfile's `sha512-XXX` (base64) into lowercase hex.
     * Returns `null` for missing values, non-sha512 algorithms, or
     * malformed payloads — the SBOM emitters render that as "no
     * checksum" rather than fabricate a hash.
     */
    private static _integrityToHex(integrity: string|undefined): string|null {
        if (!integrity) {
            return null;
        }
        const dash = integrity.indexOf('-');
        if (dash < 0) {
            return null;
        }
        const algo = integrity.slice(0, dash);
        if (algo !== 'sha512') {
            return null;
        }
        const b64 = integrity.slice(dash + 1);
        try {
            return Buffer.from(b64, 'base64').toString('hex');
        } catch {
            return null;
        }
    }

    /**
     * First-write-wins dedupe so a nested install (`node_modules/foo/
     * node_modules/foo`) doesn't double-emit alongside the top-level
     * entry. The top-level entry's `directDeps` map stays authoritative.
     */
    private static _dedupe(packages: LockedPackage[]): LockedPackage[] {
        const seen = new Map<string, LockedPackage>();
        for (const p of packages) {
            const key = `${p.name}@${p.version}`;
            if (!seen.has(key)) {
                seen.set(key, p);
            }
        }
        return Array.from(seen.values());
    }

    /**
     * Build a stable RFC-4122-shaped string from `${name}|${timestamp}`.
     * We don't need true randomness — we need *deterministic for a
     * given input, unique across runs* so the SBOM's serialNumber /
     * namespace is collision-free. A SHA-256 prefix sliced into the
     * UUID layout does that without pulling in a uuid dep.
     */
    private static _uuidLike(name: string, ts: string): string {
        const h = createHash('sha256').update(`${name}|${ts}`).digest('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    }

}