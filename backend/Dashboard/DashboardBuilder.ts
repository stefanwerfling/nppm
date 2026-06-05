import {ConfigProjectType} from '../Config/Config.js';
import {BinarySeverity, BinarySummary} from '../Security/BinaryScanner.js';
import {CadenceLevel, CadenceSummary} from '../Security/CadenceScanner.js';
import {ChurnFinding, ChurnSeverity} from '../Security/ChurnScanner.js';
import {DeprecationLevel, DeprecationSummary} from '../Security/DeprecationScanner.js';
import {ExternalSeverity, ExternalSummary} from '../Security/ExternalSourcesScanner.js';
import {CapabilitySeverity, CapabilitySummary} from '../Security/CapabilityScanner.js';
import {ManifestRedFlagSeverity, ManifestRedFlagsSummary} from '../Security/ManifestRedFlagsScanner.js';
import {
    MutableResolutionReport,
    MutableResolutionSeverity
} from '../Security/MutableResolutionScanner.js';
import {ObfuscationSeverity, ObfuscationSummary} from '../Security/ObfuscationScanner.js';
import {FreshnessLevel, FreshnessSummary} from '../Security/FreshnessScanner.js';
import {IgnoreScriptsLevel} from '../Security/IgnoreScriptsScanner.js';
import {IntegrityFinding, IntegritySeverity} from '../Security/IntegrityScanner.js';
import {LicenseSeverity, LicenseSummary} from '../Security/LicenseScanner.js';
import {MaintainerSeverity, MaintainerSummary} from '../Security/MaintainerScanner.js';
import {PatternSeverity} from '../Security/PatternScanner.js';
import {ProvenanceLevel, ProvenanceSummary} from '../Security/ProvenanceScanner.js';
import {ScriptSeverity} from '../Security/ScriptScanner.js';
import {TyposquatLevel, TyposquatSummary} from '../Security/TyposquatScanner.js';
import {HeuristicsBatchEntry, PatternSummary, ScriptSummary} from '../Security/SecurityScanner.js';
import {ComplianceFinding} from '../Templates/Template.js';
import {UnusedReport, UnusedSeverity} from '../Unused/UnusedReport.js';

/**
 * Unified severity ladder shared by every scanner the Dashboard
 * aggregates. Mirrors `Cli/ScanReport.UnifiedSeverity` semantics —
 * info / warn / risk only, with `null` meaning "this scanner has
 * nothing to say about this package" (not "we don't know").
 */
export type UnifiedSeverity = 'info'|'warn'|'risk';

/**
 * Severity weight used by the score formula. Keeps the same shape
 * the per-project Health-Ring uses (`100 × (1 − Σ min(w, 30) / (N × 30))`)
 * so dashboard cells and treeview rings are visually comparable.
 */
const SEVERITY_WEIGHT: Record<UnifiedSeverity, number> = {
    info: 1,
    warn: 10,
    risk: 30
};

/**
 * Catalogue of every scanner the Dashboard surfaces. Order is the
 * row order the UI renders — group "per-package signal" first, then
 * project-wide hygiene scanners last so the visual block matches the
 * mental model.
 */
export const SCANNER_IDS = [
    'cve',
    'license',
    'scripts',
    'patterns',
    'binaries',
    'obfuscation',
    'manifestRedFlags',
    'capability',
    'maintainer',
    'churn',
    'cadence',
    'freshness',
    'ignoreScripts',
    'typosquat',
    'provenance',
    'external',
    'deprecation',
    'integrity',
    'mutableResolution',
    'unused',
    'template'
] as const;

export type ScannerId = typeof SCANNER_IDS[number];

/**
 * One concrete row contributing to a cell's score — what the user
 * sees in the cell tooltip and the FindingsModal. `label` is what to
 * render (typically `name@version` for per-package scanners,
 * `target` for per-project ones); `detail` is an optional secondary
 * line (license SPDX, vulnerability id, finding kind, …) the modal
 * dims slightly so the label stays the focus.
 */
export type CellFinding = {
    label: string;
    severity: UnifiedSeverity;
    detail?: string;
};

/**
 * Per-(project, scanner) result. `score: null` means "scanner is
 * N/A for this project" (e.g. Unused on a remote GitHub source, or
 * Template on a project that declares no template ids) — distinct
 * from `score: 100` ("scanner ran, nothing flagged").
 */
export type DashboardCell = {
    score: number|null;
    counts: {info: number; warn: number; risk: number};
    /**
     * Packages considered for the score denominator. Equals
     * `lockfile.packages.length` for per-package scanners; for
     * per-project scanners this is the finding count cap used for
     * normalisation — exposing it lets the tooltip explain why the
     * percentage came out the way it did.
     */
    total: number;
    /**
     * Top contributing findings (severity desc), capped to keep the
     * SSE payload manageable. The frontend uses this both for the
     * cell tooltip and the FindingsModal — `counts` still carries the
     * complete totals.
     */
    findings: CellFinding[];
    /** Optional human-readable explanation when `score === null`. */
    note?: string;
};

/**
 * Cap on the per-cell findings list. 15 projects × 15 scanners × 50
 * findings ≈ 11 250 entries / scan — comfortably under a megabyte
 * of SSE payload while still showing the user concrete drivers of a
 * low score.
 */
export const CELL_FINDINGS_CAP = 50;

/**
 * One column of the Dashboard matrix — a single project plus its
 * cells keyed by scanner id. `error` is populated when the column
 * couldn't be built at all (no lockfile, parse error); the cells map
 * is then empty.
 */
export type DashboardColumn = {
    project: {unid: string; name: string; type: ConfigProjectType};
    cells: Partial<Record<ScannerId, DashboardCell>>;
    error?: string;
    /**
     * Soft, informational annotation — like `error` but doesn't paint
     * the column header red. Used when the column was scanned in a
     * degraded mode (e.g. no lockfile, ran against registry latest)
     * so the user knows the score is best-effort instead of
     * lockfile-pinned.
     */
    note?: string;
    /**
     * Installed-size aggregate. Sum of `dist.unpackedSize` across
     * every package in the lockfile for which the registry exposes
     * a size. Absent on columns that errored before lockfile-load or
     * had no resolvable packages.
     */
    sizeBytes?: number;
    /**
     * How many of the lockfile's packages contributed to `sizeBytes`
     * (the registry exposes `unpackedSize` for most but not all). The
     * UI surfaces this as a "best-effort floor" tooltip so the user
     * knows the number is conservative.
     */
    sizeCoverage?: {covered: number; total: number};
    /**
     * Sum of last-week npm download counts for every *distinct*
     * package name in this project (within-project dedupe — a name
     * pulled through multiple paths counts once). Best-effort:
     * names absent from the npm public downloads API contribute zero.
     */
    downloadsLastWeek?: number;
};

export type DashboardResponse = {
    scanners: ScannerId[];
    columns: DashboardColumn[];
};

/**
 * Score helpers reused by the orchestrator in `vite.config.ts`. The
 * builder itself owns no state — every method is static and operates
 * on the data the route handler already gathered through the existing
 * scanner classes (`scanHeuristicsBatch`, `osvClient.queryBatch`,
 * `IntegrityScanner`, `UnusedDetector`, `TemplateComplianceChecker`).
 *
 * Score formula:
 *   `score = max(0, round(100 × (1 − Σ min(weight, 30) / (max(1, denom) × 30))))`
 * with weights info=1, warn=10, risk=30. Identical to the per-project
 * Health-Ring so the dashboard ring and the treeview ring move
 * together for the same data.
 */
export class DashboardBuilder {

    /**
     * Score a per-package scanner's output. Each entry in `severities`
     * is one package's verdict (`null` = no finding for that package).
     * `denom` is the total package count — usually `severities.length`
     * but exposed separately so the caller can pass a wider denominator
     * (e.g. the lockfile size when the scanner only returned non-null
     * entries).
     *
     * `findings` is optional; when supplied it is sorted (severity
     * desc) and capped at `CELL_FINDINGS_CAP` for the cell payload.
     */
    public static scorePerPackage(
        severities: (UnifiedSeverity|null)[],
        denom: number,
        findings: CellFinding[] = []
    ): DashboardCell {
        const counts = {info: 0, warn: 0, risk: 0};
        let weightSum = 0;

        for (const sev of severities) {
            if (sev === null) {
                continue;
            }
            counts[sev]++;
            weightSum += SEVERITY_WEIGHT[sev];
        }

        const safeDenom = Math.max(1, denom);
        const score = Math.max(0, Math.round(100 * (1 - weightSum / (safeDenom * 30))));
        return {score, counts, total: denom, findings: DashboardBuilder.capFindings(findings)};
    }

    /**
     * Score a per-project scanner (Integrity / Unused / Template).
     * Each finding contributes one severity; the denominator is the
     * project's package count so a busy project can absorb more
     * findings before tanking — matching the per-package formula's
     * normalisation.
     */
    public static scorePerProject(
        findingSeverities: UnifiedSeverity[],
        packageDenom: number,
        findings: CellFinding[] = []
    ): DashboardCell {
        const counts = {info: 0, warn: 0, risk: 0};
        let weightSum = 0;

        for (const sev of findingSeverities) {
            counts[sev]++;
            weightSum += SEVERITY_WEIGHT[sev];
        }

        const safeDenom = Math.max(1, packageDenom);
        const score = Math.max(0, Math.round(100 * (1 - weightSum / (safeDenom * 30))));
        return {score, counts, total: packageDenom, findings: DashboardBuilder.capFindings(findings)};
    }

    /** N/A cell — scanner doesn't apply to this project. */
    public static naCell(note: string): DashboardCell {
        return {score: null, counts: {info: 0, warn: 0, risk: 0}, total: 0, findings: [], note};
    }

    /**
     * Sort by severity (risk → warn → info) and trim to the cap.
     * Stable order inside a tier so the modal renders deterministically
     * across re-scans.
     */
    public static capFindings(findings: CellFinding[]): CellFinding[] {
        const rank: Record<UnifiedSeverity, number> = {risk: 3, warn: 2, info: 1};
        const copy = findings.slice();
        copy.sort((a, b) => rank[b.severity] - rank[a.severity]);
        if (copy.length > CELL_FINDINGS_CAP) {
            copy.length = CELL_FINDINGS_CAP;
        }
        return copy;
    }

    // -------------------------------------------------------------
    // Severity normalisers — every scanner's native level/severity
    // collapses to the unified info/warn/risk ladder via the maps
    // below.  Anything not in the ladder (`permissive`, `unaffected`,
    // `signed`, `exact`, …) returns null so the score formula skips
    // it cleanly.
    // -------------------------------------------------------------

    public static cveSeverity(vulnIds: string[]|null): UnifiedSeverity|null {
        if (!vulnIds || vulnIds.length === 0) {
            return null;
        }
        return 'risk';
    }

    public static licenseSeverity(s: LicenseSummary): UnifiedSeverity|null {
        switch (s.severity) {
            case LicenseSeverity.permissive:
                return null;
            case LicenseSeverity.weakCopyleft:
            case LicenseSeverity.unknown:
                return 'info';
            case LicenseSeverity.strongCopyleft:
                return 'warn';
            case LicenseSeverity.proprietary:
                return 'risk';
        }
    }

    public static scriptsSeverity(s: ScriptSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<ScriptSeverity>(s.maxSeverity);
    }

    public static patternsSeverity(s: PatternSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<PatternSeverity>(s.maxSeverity);
    }

    public static binariesSeverity(s: BinarySummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<BinarySeverity>(s.maxSeverity);
    }

    public static obfuscationSeverity(s: ObfuscationSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<ObfuscationSeverity>(s.maxSeverity);
    }

    public static manifestRedFlagsSeverity(s: ManifestRedFlagsSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<ManifestRedFlagSeverity>(s.severity);
    }

    public static capabilitySeverity(s: CapabilitySummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<CapabilitySeverity>(s.severity);
    }

    public static maintainerSeverity(s: MaintainerSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<MaintainerSeverity>(s.severity);
    }

    public static churnSeverity(f: ChurnFinding|null): UnifiedSeverity|null {
        if (!f) {
            return null;
        }
        return DashboardBuilder._passthrough<ChurnSeverity>(f.severity);
    }

    public static cadenceSeverity(s: CadenceSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<CadenceLevel>(s.level);
    }

    public static freshnessSeverity(s: FreshnessSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<FreshnessLevel>(s.level);
    }

    /**
     * IgnoreScripts has its own four-level ladder — `unaffected` /
     * `safeToIgnore` are the boring path, `needsScripts` is info-grade
     * ("you might want to allow these"), `avoidScripts` is risk-grade
     * (lifecycle script with side effects on disk).
     */
    public static ignoreScriptsSeverity(level: IgnoreScriptsLevel|null): UnifiedSeverity|null {
        if (level === null) {
            return null;
        }
        if (level === IgnoreScriptsLevel.needsScripts) {
            return 'info';
        }
        if (level === IgnoreScriptsLevel.avoidScripts) {
            return 'risk';
        }
        return null;
    }

    public static typosquatSeverity(s: TyposquatSummary): UnifiedSeverity|null {
        if (s.level === null) {
            return null;
        }
        switch (s.level) {
            case TyposquatLevel.exact:
            case TyposquatLevel.unrelated:
                return null;
            case TyposquatLevel.warn:
                return 'warn';
            case TyposquatLevel.risk:
                return 'risk';
        }
    }

    /**
     * Provenance is inverted: `provenance` (sigstore-attested) and
     * `signed` are *good* signals, only `unsigned` is mildly bad
     * ("you're trusting npm's TLS rather than a build-pipeline
     * attestation"). Stays at info — the absence of provenance is the
     * norm, not a smoking gun.
     */
    public static provenanceSeverity(s: ProvenanceSummary): UnifiedSeverity|null {
        if (s.level === null) {
            return null;
        }
        switch (s.level) {
            case ProvenanceLevel.provenance:
            case ProvenanceLevel.signed:
                return null;
            case ProvenanceLevel.unsigned:
                return 'info';
        }
    }

    /**
     * External-sources scanner — already worst-of-three on its own
     * ladder (`info | warn | risk`). `level: null` means "no source
     * contributed" (scanner disabled, every fetcher 401/404, or the
     * version is a git URL) — same N/A semantics as the other
     * per-package scanners.
     */
    public static externalSeverity(s: ExternalSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<ExternalSeverity>(s.level);
    }

    /**
     * Deprecation passthrough — the scanner's level already lives on
     * the unified ladder (`info | warn | risk`) so it maps verbatim.
     * `null` means no version of the package carries a marker.
     */
    public static deprecationSeverity(s: DeprecationSummary): UnifiedSeverity|null {
        return DashboardBuilder._passthrough<DeprecationLevel>(s.level);
    }

    public static integritySeverity(f: IntegrityFinding): UnifiedSeverity {
        return DashboardBuilder._passthrough<IntegritySeverity>(f.severity) ?? 'info';
    }

    public static unusedSeverity(s: UnusedSeverity): UnifiedSeverity {
        return DashboardBuilder._passthrough<UnusedSeverity>(s) ?? 'info';
    }

    public static complianceSeverity(f: ComplianceFinding): UnifiedSeverity {
        // ComplianceFinding.severity is already typed as the literal
        // union 'info'|'warn'|'risk', so it lands in the unified
        // ladder verbatim.
        return f.severity;
    }

    /**
     * Build the per-package cell for one entry in `scanHeuristicsBatch`
     * + the matching OSV result. Handy convenience for the route
     * handler — collapses 11 sub-scorers into one call.
     */
    public static cellsFromHeuristic(
        h: HeuristicsBatchEntry,
        osvIds: string[]|null
    ): Partial<Record<ScannerId, UnifiedSeverity|null>> {
        return {
            cve: DashboardBuilder.cveSeverity(osvIds),
            license: DashboardBuilder.licenseSeverity(h.license),
            scripts: DashboardBuilder.scriptsSeverity(h.scripts),
            patterns: DashboardBuilder.patternsSeverity(h.patterns),
            binaries: DashboardBuilder.binariesSeverity(h.binaries),
            maintainer: DashboardBuilder.maintainerSeverity(h.maintainer),
            cadence: DashboardBuilder.cadenceSeverity(h.cadence),
            freshness: DashboardBuilder.freshnessSeverity(h.freshness),
            typosquat: DashboardBuilder.typosquatSeverity(h.typosquat),
            provenance: DashboardBuilder.provenanceSeverity(h.provenance),
            external: DashboardBuilder.externalSeverity(h.external),
            deprecation: DashboardBuilder.deprecationSeverity(h.deprecation),
            obfuscation: DashboardBuilder.obfuscationSeverity(h.obfuscation),
            manifestRedFlags: DashboardBuilder.manifestRedFlagsSeverity(h.manifestRedFlags),
            capability: DashboardBuilder.capabilitySeverity(h.capability)
        };
    }

    /**
     * Aggregate the MutableResolution report into a single per-project
     * cell. Supports the `synthesized lockfile` N/A case via the
     * existing `naCell` helper.
     */
    public static mutableResolutionCell(report: MutableResolutionReport): DashboardCell {
        if (!report.supported) {
            return DashboardBuilder.naCell(report.unsupportedReason ?? 'mutable-resolution scanner not supported');
        }
        const sevs: UnifiedSeverity[] = [];
        const findings: CellFinding[] = [];
        for (const f of report.findings) {
            const sev = DashboardBuilder._passthrough<MutableResolutionSeverity>(f.severity) ?? 'info';
            sevs.push(sev);
            findings.push({label: `${f.name}@${f.version}`, severity: sev, detail: f.kind});
        }
        return DashboardBuilder.scorePerProject(sevs, report.packagesScanned, findings);
    }

    /**
     * Aggregate the Unused report into a single per-project cell.
     * Treats `misplaced` and `missing` as warn-grade contributions —
     * neither carries its own severity field (they're implicit
     * defects, just less actionable than a flat-out unused entry).
     */
    public static unusedCell(report: UnusedReport, packageDenom: number): DashboardCell {
        if (!report.supported) {
            return DashboardBuilder.naCell(report.unsupportedReason ?? 'scanner not supported for this project type');
        }
        const sevs: UnifiedSeverity[] = [];
        const findings: CellFinding[] = [];
        for (const f of report.unused) {
            const sev = DashboardBuilder.unusedSeverity(f.severity);
            sevs.push(sev);
            findings.push({label: f.name, severity: sev, detail: `unused · ${f.declaredIn}`});
        }
        for (const m of report.misplaced) {
            sevs.push('warn');
            findings.push({label: m.name, severity: 'warn', detail: `misplaced · ${m.firstImport}`});
        }
        for (const m of report.missing) {
            sevs.push('warn');
            findings.push({label: m.name, severity: 'warn', detail: `missing · ${m.firstImport}`});
        }
        return DashboardBuilder.scorePerProject(sevs, packageDenom, findings);
    }

    private static _passthrough<S extends string>(s: S|null): UnifiedSeverity|null {
        if (s === null) {
            return null;
        }
        if (s === 'info' || s === 'warn' || s === 'risk') {
            return s as UnifiedSeverity;
        }
        return null;
    }
}