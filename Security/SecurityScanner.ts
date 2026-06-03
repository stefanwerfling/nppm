import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {Registry} from '../Registry/Registry.js';
import {
    BinaryFinding,
    BinaryScanner,
    BinarySeverity,
    BinarySummary
} from './BinaryScanner.js';
import {ChurnFinding, ChurnScanner} from './ChurnScanner.js';
import {
    LicenseFinding,
    LicenseScanner,
    LicenseScannerOptions,
    LicenseSummary
} from './LicenseScanner.js';
import {
    MaintainerFinding,
    MaintainerScanner,
    MaintainerScannerOptions,
    MaintainerSummary
} from './MaintainerScanner.js';
import {
    CadenceFinding,
    CadenceScanner,
    CadenceSummary
} from './CadenceScanner.js';
import {
    ExternalFinding,
    ExternalSourcesScanner,
    ExternalSummary
} from './ExternalSourcesScanner.js';
import {
    FreshnessFinding,
    FreshnessScanner,
    FreshnessSummary
} from './FreshnessScanner.js';
import {
    IgnoreScriptsFinding,
    IgnoreScriptsScanner
} from './IgnoreScriptsScanner.js';
import {NpmUserFetcher} from './NpmUserFetcher.js';
import {
    ProvenanceFinding,
    ProvenanceScanner,
    ProvenanceSummary
} from './ProvenanceScanner.js';
import {
    TyposquatFinding,
    TyposquatScanner,
    TyposquatSummary
} from './TyposquatScanner.js';
import {OsvClient, OsvVulnerability} from './OsvClient.js';
import {PatternFinding, PatternScanner, PatternSeverity} from './PatternScanner.js';
import {ScriptFinding, ScriptScanner, ScriptSeverity} from './ScriptScanner.js';

/**
 * Combined view of "what should worry me about this `pkg@version`".
 * `vulns: null` means OSV could not be reached (distinct from `[]` =
 * "OSV answered, no known vulns"). `scriptFindings: []` is the
 * boring/common case.
 */
export type SecurityReport = {
    name: string;
    version: string;
    vulns: OsvVulnerability[]|null;
    scriptFindings: ScriptFinding[];
    churn: ChurnFinding|null;
    patternFindings: PatternFinding[];
    binaryFindings: BinaryFinding[];
    maintainer: MaintainerFinding|null;
    license: LicenseFinding;
    /**
     * `null` when the registry record for `name@version` is missing
     * — distinct from `level: 'unsigned'` which means "we looked, no
     * signatures or attestation".
     */
    provenance: ProvenanceFinding|null;
    /**
     * "Brand new" classifier. `null` when neither `time.created` nor
     * the publisher's account-creation date could be resolved.
     */
    freshness: FreshnessFinding|null;
    /**
     * Release-cadence classifier. `null` when the registry packument
     * has no `time` map to read.
     */
    cadence: CadenceFinding|null;
    /**
     * Recommendation for whether `npm install --ignore-scripts` is
     * safe / needed / risky for this package. Always present —
     * derived purely from `scriptFindings`, no I/O.
     */
    ignoreScripts: IgnoreScriptsFinding;
    /**
     * Typosquat / homoglyph classification. Always present — pure
     * derivation from the package name against a curated popular
     * list, no I/O.
     */
    typosquat: TyposquatFinding;
    /**
     * Aggregated external-source reputation findings (socket.dev,
     * OpenSSF Scorecard, deps.dev). Always present; `findings: []`
     * when the scanner is globally disabled or every per-source
     * fetcher declined.
     */
    external: ExternalFinding;
};

/**
 * Compact per-package summary for the matrix badge. `maxSeverity` is
 * `null` when no install/build hooks were declared at all (the boring
 * case — most packages). `count` is the number of findings; useful as
 * a tooltip but the badge itself colours by severity only.
 */
export type ScriptSummary = {
    name: string;
    version: string;
    maxSeverity: ScriptSeverity|null;
    count: number;
};

/**
 * Same shape for code-pattern findings (eval/Function/child_process/
 * base64) — derived from the same fingerprint, so it ships in the same
 * batched response as scripts.
 */
export type PatternSummary = {
    name: string;
    version: string;
    maxSeverity: PatternSeverity|null;
    count: number;
};

export type HeuristicsBatchEntry = {
    name: string;
    version: string;
    scripts: ScriptSummary;
    patterns: PatternSummary;
    binaries: BinarySummary;
    maintainer: MaintainerSummary;
    license: LicenseSummary;
    provenance: ProvenanceSummary;
    freshness: FreshnessSummary;
    cadence: CadenceSummary;
    typosquat: TyposquatSummary;
    external: ExternalSummary;
};

/**
 * Severity rank — higher number wins. Both severity enums share the
 * same ordering by convention (info < warn < risk).
 */
const SCRIPT_RANK: Record<ScriptSeverity, number> = {
    [ScriptSeverity.info]: 1,
    [ScriptSeverity.warn]: 2,
    [ScriptSeverity.risk]: 3
};

const PATTERN_RANK: Record<PatternSeverity, number> = {
    [PatternSeverity.info]: 1,
    [PatternSeverity.warn]: 2,
    [PatternSeverity.risk]: 3
};

/**
 * Glue between the OSV client and the local manifest-based heuristic
 * scanner. Kept as its own class so Phase 5 can add more scanners
 * (eval/Function pattern scan on JS files, sudden-churn detection
 * across Phase-4 diffs) without each route handler learning a new
 * pipeline.
 */
export class SecurityScanner {

    private readonly _osv: OsvClient;
    private readonly _fingerprint: FingerprintBuilder;
    private readonly _registry: Registry;
    private readonly _churn: ChurnScanner;
    private readonly _maintainer: MaintainerScanner;
    private readonly _license: LicenseScanner;
    private readonly _external: ExternalSourcesScanner|null;

    constructor(
        osv: OsvClient,
        fingerprint: FingerprintBuilder,
        registry: Registry,
        opts: {
            maintainer?: MaintainerScannerOptions;
            license?: LicenseScannerOptions;
            userFetcher?: NpmUserFetcher|null;
            external?: ExternalSourcesScanner|null;
        } = {}
    ) {
        this._osv = osv;
        this._fingerprint = fingerprint;
        this._registry = registry;
        this._churn = new ChurnScanner(registry, fingerprint);
        this._maintainer = new MaintainerScanner(registry, opts.maintainer, opts.userFetcher ?? null);
        this._license = new LicenseScanner(opts.license);
        this._external = opts.external ?? null;
    }

    /**
     * Whether the external-sources scanner is wired up and has at
     * least one enabled source. The Dashboard route handler uses this
     * to emit an N/A cell (with a clear "no source configured" note)
     * instead of a misleading perfect score.
     */
    public hasExternalSources(): boolean {
        return this._external !== null && this._external.hasAnySource();
    }

    public async scan(name: string, version: string): Promise<SecurityReport> {
        // OSV, fingerprint, churn, maintainer, and the registry lookup
        // for the license all hit independent caches/network endpoints
        // — fire them in parallel. The registry, maintainer, and churn
        // scans share one packument cache so warm runs are
        // essentially free.
        const [vulns, fingerprint, churn, maintainer, reg, external] = await Promise.all([
            this._osv.query(name, version),
            this._fingerprint.build(name, version),
            this._churn.scan(name, version),
            this._maintainer.scan(name, version),
            this._registry.fetchOne(name),
            this._external
                ? this._external.scan(name, version)
                : Promise.resolve({name, version, level: null, findings: []} as ExternalFinding)
        ]);

        const scriptFindings = ScriptScanner.scan(fingerprint?.manifest ?? null);
        const patternFindings = fingerprint ? PatternScanner.scan(fingerprint.files) : [];
        const binaryFindings = fingerprint ? BinaryScanner.scan(fingerprint.files) : [];

        // Prefer the manifest license (per-version, can differ between
        // releases) over the packument license (top-level, version-
        // agnostic). Both fall back to `null` if neither is present.
        const spdx = fingerprint?.manifest?.license ?? reg?.license ?? null;
        const provenance = ProvenanceScanner.classify(reg?.dist?.[version]);
        // Git-installed packages don't correspond to the registry
        // entry of the same name — the npm-published `figtree` could
        // be a 10-year-old unrelated package while the user installs
        // from `github:owner/figtree`. Skip the name-keyed scanners
        // (cadence + freshness) so the matrix doesn't flag a
        // brand-new git dep as abandoned.
        const isGit = GitResolver.isGitVersion(version);
        const freshness = isGit ? null : FreshnessScanner.classify({
            firstPublishedAt: reg?.time?.created ?? null,
            maintainerCreatedAt: maintainer?.currentPublisherCreatedAt ?? null
        });
        const cadence = isGit ? null : CadenceScanner.classify(reg?.time);
        const ignoreScripts = IgnoreScriptsScanner.classify(scriptFindings);
        const typosquat = TyposquatScanner.classify(name);

        return {
            name,
            version,
            vulns,
            scriptFindings,
            churn,
            patternFindings,
            binaryFindings,
            maintainer,
            license: this._license.classify(spdx),
            provenance,
            freshness,
            cadence,
            ignoreScripts,
            typosquat,
            external
        };
    }

    /**
     * Bulk file-churn scan for the Dashboard. Mirrors the bounded-
     * concurrency shape of `scanHeuristicsBatch` so a project-wide
     * churn pass doesn't fan out into hundreds of parallel tarball
     * downloads. Each entry is the unmodified `ChurnFinding|null` the
     * underlying scanner emits.
     *
     * Skipped intentionally by `scanHeuristicsBatch` (the matrix badge
     * doesn't surface churn). Surfaced here as its own batched
     * entry-point so the dashboard orchestrator can call it without
     * reaching into the private `_churn` instance.
     */
    public async scanChurnBatch(
        packages: {name: string; version: string}[],
        concurrency = 10
    ): Promise<(ChurnFinding|null)[]> {
        const result: (ChurnFinding|null)[] = new Array(packages.length);
        let cursor = 0;

        const runOne = async (): Promise<void> => {
            while (true) {
                const i = cursor++;
                if (i >= packages.length) {
                    return;
                }
                const pkg = packages[i];
                try {
                    result[i] = await this._churn.scan(pkg.name, pkg.version);
                } catch {
                    result[i] = null;
                }
            }
        };

        const workers: Promise<void>[] = [];
        const n = Math.min(concurrency, Math.max(1, packages.length));
        for (let i = 0; i < n; i++) {
            workers.push(runOne());
        }
        await Promise.all(workers);

        return result;
    }

    /**
     * Bulk fingerprint-derived scan for the matrix badge. Walks every
     * package through the fingerprint builder (permanently cached, so
     * warm = instant) at a bounded concurrency, then extracts both the
     * lifecycle-script summary *and* the code-pattern summary from the
     * same fingerprint — pattern scan is essentially free once the
     * fingerprint is in hand.
     *
     * Returns one entry per *input* coordinate, in input order. When
     * the fingerprint can't be built (404 tarball), both summaries
     * are emitted with `maxSeverity: null, count: 0`.
     */
    public async scanHeuristicsBatch(
        packages: {name: string; version: string}[],
        concurrency = 10
    ): Promise<HeuristicsBatchEntry[]> {
        const result: HeuristicsBatchEntry[] = new Array(packages.length);
        let cursor = 0;

        const runOne = async (): Promise<void> => {
            while (true) {
                const i = cursor++;
                if (i >= packages.length) {
                    return;
                }
                const pkg = packages[i];
                // Fingerprint download (slow on cold start) and the
                // registry-based scans (maintainer + license + external)
                // all run in parallel. The registry/maintainer/external
                // calls share the packument cache so warm runs are
                // instant; external also hits its own three TTL caches.
                const externalP = this._external
                    ? this._external.scan(pkg.name, pkg.version)
                    : Promise.resolve({name: pkg.name, version: pkg.version, level: null, findings: []} as ExternalFinding);
                const [fingerprint, maintainer, reg, external] = await Promise.all([
                    this._fingerprint.build(pkg.name, pkg.version),
                    this._maintainer.scan(pkg.name, pkg.version),
                    this._registry.fetchOne(pkg.name),
                    externalP
                ]);

                const spdx = fingerprint?.manifest?.license ?? reg?.license ?? null;
                const licenseFinding = this._license.classify(spdx);

                const scriptFindings = ScriptScanner.scan(fingerprint?.manifest ?? null);
                const patternFindings = fingerprint ? PatternScanner.scan(fingerprint.files) : [];
                const binaryFindings = fingerprint ? BinaryScanner.scan(fingerprint.files) : [];
                const binSummary = BinaryScanner.summarise(binaryFindings);

                result[i] = {
                    name: pkg.name,
                    version: pkg.version,
                    scripts: {
                        name: pkg.name,
                        version: pkg.version,
                        maxSeverity: SecurityScanner._maxScriptSeverity(scriptFindings),
                        count: scriptFindings.length
                    },
                    patterns: {
                        name: pkg.name,
                        version: pkg.version,
                        maxSeverity: SecurityScanner._maxPatternSeverity(patternFindings),
                        count: patternFindings.length
                    },
                    binaries: {
                        name: pkg.name,
                        version: pkg.version,
                        maxSeverity: binSummary.maxSeverity,
                        riskCount: binSummary.riskCount,
                        totalCount: binSummary.totalCount
                    },
                    maintainer: {
                        name: pkg.name,
                        version: pkg.version,
                        severity: maintainer ? maintainer.severity : null,
                        publisher: maintainer?.currentPublisher?.name ?? null,
                        publisher2FA: maintainer?.currentPublisher2FA ?? null,
                        publisherCreatedAt: maintainer?.currentPublisherCreatedAt ?? null
                    },
                    license: {
                        name: pkg.name,
                        version: pkg.version,
                        spdx: licenseFinding.spdx,
                        severity: licenseFinding.severity
                    },
                    provenance: {
                        name: pkg.name,
                        version: pkg.version,
                        level: ProvenanceScanner.classify(reg?.dist?.[pkg.version])?.level ?? null
                    },
                    freshness: SecurityScanner._freshnessSummary(
                        pkg.name, pkg.version,
                        reg?.time?.created ?? null,
                        maintainer?.currentPublisherCreatedAt ?? null
                    ),
                    cadence: SecurityScanner._cadenceSummary(
                        pkg.name, pkg.version, reg?.time
                    ),
                    typosquat: SecurityScanner._typosquatSummary(pkg.name, pkg.version),
                    external: ExternalSourcesScanner.summarise(external)
                };
            }
        };

        const workers: Promise<void>[] = [];
        const n = Math.min(concurrency, Math.max(1, packages.length));
        for (let i = 0; i < n; i++) {
            workers.push(runOne());
        }
        await Promise.all(workers);

        return result;
    }

    private static _freshnessSummary(
        name: string,
        version: string,
        firstPublishedAt: string|null,
        maintainerCreatedAt: string|null
    ): FreshnessSummary {
        // Git-installed packages: registry data is for an unrelated
        // npm name-collision (see scan() for the figtree example).
        const finding = GitResolver.isGitVersion(version)
            ? null
            : FreshnessScanner.classify({firstPublishedAt, maintainerCreatedAt});
        return {
            name,
            version,
            level: finding?.level ?? null,
            packageAgeDays: finding?.packageAgeDays ?? null,
            maintainerAgeDays: finding?.maintainerAgeDays ?? null
        };
    }

    private static _typosquatSummary(
        name: string,
        version: string
    ): TyposquatSummary {
        const finding = TyposquatScanner.classify(name);
        return {
            name,
            version,
            level: finding.level,
            closestMatch: finding.closestMatch,
            hasConfusables: finding.hasConfusables
        };
    }

    private static _cadenceSummary(
        name: string,
        version: string,
        timeMap: Record<string, string>|undefined
    ): CadenceSummary {
        const finding = GitResolver.isGitVersion(version)
            ? null
            : CadenceScanner.classify(timeMap);
        return {
            name,
            version,
            level: finding?.level ?? null,
            daysSinceLastRelease: finding?.daysSinceLastRelease ?? null,
            medianCadenceDays: finding?.medianCadenceDays ?? null
        };
    }

    private static _maxScriptSeverity(findings: ScriptFinding[]): ScriptSeverity|null {
        let best: ScriptSeverity|null = null;
        let bestRank = 0;
        for (const f of findings) {
            const rank = SCRIPT_RANK[f.severity];
            if (rank > bestRank) {
                best = f.severity;
                bestRank = rank;
            }
        }
        return best;
    }

    private static _maxPatternSeverity(findings: PatternFinding[]): PatternSeverity|null {
        let best: PatternSeverity|null = null;
        let bestRank = 0;
        for (const f of findings) {
            const rank = PATTERN_RANK[f.severity];
            if (rank > bestRank) {
                best = f.severity;
                bestRank = rank;
            }
        }
        return best;
    }
}