import {GitResolver} from '../Fingerprint/GitResolver.js';
import {LockedPackage} from '../Project/Lockfile.js';
import {Registry, RegistryDist} from '../Registry/Registry.js';

/**
 * Three-level severity ladder shared with the other security
 * scanners. `info` for benign drift (custom mirror, no upstream
 * integrity), `warn` for "this doesn't add up but isn't proof of
 * malice" (resolved URL points to a non-registry host while the
 * hash still matches), `risk` for likely tampering (hash mismatch
 * against what the registry currently serves).
 */
export enum IntegritySeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

/**
 * Type of integrity drift. Mirror-hijack and lockfile-injection
 * attacks land as `integrity-mismatch`; harmless custom mirrors as
 * `tarball-redirect`; missing integrity in old lockfiles as
 * `integrity-missing`; private/unpublished packages as
 * `version-not-in-registry`.
 */
export enum IntegrityFindingKind {
    integrityMismatch = 'integrity-mismatch',
    tarballRedirect = 'tarball-redirect',
    integrityMissing = 'integrity-missing',
    versionNotInRegistry = 'version-not-in-registry'
}

/**
 * One row in the integrity report. `lockfileIntegrity`/`lockfileTarball`
 * are what the project pinned; `registryIntegrity`/`registryTarball`
 * are what the registry serves now. Both pairs are surfaced so the
 * UI can render the side-by-side without re-fetching.
 */
export type IntegrityFinding = {
    name: string;
    version: string;
    kind: IntegrityFindingKind;
    severity: IntegritySeverity;
    message: string;
    lockfileIntegrity?: string;
    lockfileTarball?: string;
    registryIntegrity?: string;
    registryTarball?: string;
};

/**
 * Aggregate counts for the matrix-style badge / InstalledView header.
 * `maxSeverity` is `null` when every package was clean (no findings).
 */
export type IntegritySummary = {
    maxSeverity: IntegritySeverity|null;
    riskCount: number;
    warnCount: number;
    infoCount: number;
    totalScanned: number;
};

/**
 * Cross-checks a project's `package-lock.json` against the npm
 * registry's currently-served `dist` metadata. Detects:
 *  - **mirror-hijack** — the registry now serves a different tarball
 *    integrity for the same `name@version` than the project pinned.
 *  - **dependency-confusion** — internal package name hijacked by
 *    a public publish; surfaces as integrity-mismatch.
 *  - **lockfile tampering** — `integrity` line manually rewritten to
 *    point at a malicious tarball.
 *  - **custom mirror** — `resolved` URL points elsewhere but
 *    `integrity` still matches (info: harmless).
 *
 * Network-free at runtime: reuses the cached `RegistryPackage` written
 * by the matrix / package-list flow. Cold cache → no findings until
 * `Registry.fetchOne` has been called for each dep at least once.
 */
export class IntegrityScanner {

    private readonly _registry: Registry;

    constructor(registry: Registry) {
        this._registry = registry;
    }

    /**
     * Scan a deduplicated `name@version` set, producing one finding
     * per non-clean entry. Clean entries (matching integrity, matching
     * tarball, registry has data) produce no rows so the UI list
     * stays signal-only.
     *
     * Internally batches the registry lookups via `Registry.fetchMany`
     * with the existing concurrency cap.
     */
    public async scan(packages: LockedPackage[]): Promise<IntegrityFinding[]> {
        const queue = IntegrityScanner._dedupe(packages);
        if (queue.length === 0) {
            return [];
        }

        const names = queue.map((p) => p.name);
        const registryMap = await this._registry.fetchMany(names);
        const findings: IntegrityFinding[] = [];

        for (const pkg of queue) {
            const finding = IntegrityScanner._evaluate(pkg, registryMap.get(pkg.name) ?? null);
            if (finding !== null) {
                findings.push(finding);
            }
        }
        return findings;
    }

    /**
     * Same scan, but rolled up into a counts envelope for header
     * badges. Calls `scan` internally — exists as a separate method
     * so callers that only need the headline number can ignore the
     * per-row list.
     */
    public async scanSummary(packages: LockedPackage[]): Promise<IntegritySummary> {
        const findings = await this.scan(packages);
        return IntegrityScanner.summarize(findings, IntegrityScanner._dedupe(packages).length);
    }

    /**
     * Aggregate a finding list into the summary envelope. Public so
     * the route handler can compute the summary from the same scan
     * data it sends to the frontend, without scanning twice.
     */
    public static summarize(findings: IntegrityFinding[], totalScanned: number): IntegritySummary {
        let riskCount = 0;
        let warnCount = 0;
        let infoCount = 0;
        for (const f of findings) {
            if (f.severity === IntegritySeverity.risk) {
                riskCount++;
            } else if (f.severity === IntegritySeverity.warn) {
                warnCount++;
            } else {
                infoCount++;
            }
        }
        const maxSeverity = riskCount > 0
            ? IntegritySeverity.risk
            : warnCount > 0
                ? IntegritySeverity.warn
                : infoCount > 0
                    ? IntegritySeverity.info
                    : null;
        return {maxSeverity, riskCount, warnCount, infoCount, totalScanned};
    }

    /**
     * Deduplicate the lockfile's package list down to one entry per
     * `name@version`. Nested installs share the same coordinate and
     * should produce one finding, not N.
     */
    private static _dedupe(packages: LockedPackage[]): LockedPackage[] {
        const seen = new Set<string>();
        const out: LockedPackage[] = [];
        for (const p of packages) {
            // Skip non-registry installs — git/file URLs aren't
            // anchored in the registry; comparing integrity makes no
            // sense.
            if (!p.name || !p.version || GitResolver.isGitVersion(p.version)) {
                continue;
            }
            const key = `${p.name}@${p.version}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push(p);
        }
        return out;
    }

    /**
     * Compare one lockfile entry against the registry's dist record.
     * Returns null when everything matches (no finding); otherwise
     * the appropriate `IntegrityFinding`.
     */
    private static _evaluate(
        pkg: LockedPackage,
        registry: {dist?: Record<string, RegistryDist>}|null
    ): IntegrityFinding|null {
        if (registry === null) {
            // Registry returned null — package not on the registry,
            // could be a private/internal dep. Info-level so the
            // user can audit but not a hard signal.
            return {
                name: pkg.name,
                version: pkg.version,
                kind: IntegrityFindingKind.versionNotInRegistry,
                severity: IntegritySeverity.info,
                message: `${pkg.name} is not on the registry (private or unpublished)`,
                lockfileIntegrity: pkg.integrity,
                lockfileTarball: pkg.resolved
            };
        }

        const dist = registry.dist?.[pkg.version];
        if (!dist) {
            // Registry knows the package but not this specific
            // version. Could be an old cache entry without `dist`
            // (pre-IntegrityScanner) — defer judgment by emitting
            // no finding rather than a false positive.
            return null;
        }

        if (!pkg.integrity) {
            // Lockfile entry has no integrity at all. Old npm
            // versions or hand-edited lockfiles. Info — not
            // actionable on its own.
            return {
                name: pkg.name,
                version: pkg.version,
                kind: IntegrityFindingKind.integrityMissing,
                severity: IntegritySeverity.info,
                message: `${pkg.name}@${pkg.version} has no integrity hash in the lockfile`,
                registryIntegrity: dist.integrity,
                registryTarball: dist.tarball,
                lockfileTarball: pkg.resolved
            };
        }

        if (dist.integrity && pkg.integrity !== dist.integrity) {
            // Hash mismatch — the registry now serves a different
            // tarball than the project pinned. Could be mirror-
            // hijack, dependency-confusion via re-published name,
            // lockfile-injection. Real attack signal.
            return {
                name: pkg.name,
                version: pkg.version,
                kind: IntegrityFindingKind.integrityMismatch,
                severity: IntegritySeverity.risk,
                message: `${pkg.name}@${pkg.version} integrity differs from what the registry currently serves`,
                lockfileIntegrity: pkg.integrity,
                lockfileTarball: pkg.resolved,
                registryIntegrity: dist.integrity,
                registryTarball: dist.tarball
            };
        }

        // Integrity matches (or registry has none). Check whether
        // the tarball URL also matches — divergence with matching
        // hash is benign (custom mirror), but worth surfacing so
        // the user knows.
        if (pkg.resolved && dist.tarball && pkg.resolved !== dist.tarball) {
            return {
                name: pkg.name,
                version: pkg.version,
                kind: IntegrityFindingKind.tarballRedirect,
                severity: IntegritySeverity.info,
                message: `${pkg.name}@${pkg.version} resolved from a non-registry URL (integrity matches — custom mirror)`,
                lockfileIntegrity: pkg.integrity,
                lockfileTarball: pkg.resolved,
                registryIntegrity: dist.integrity,
                registryTarball: dist.tarball
            };
        }

        return null;
    }
}