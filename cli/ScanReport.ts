import {ConfigProjectType} from '../backend/Config/Config.js';
import {BinarySeverity} from '../backend/Security/BinaryScanner.js';
import {CapabilitySeverity} from '../backend/Security/CapabilityScanner.js';
import {DeprecationLevel} from '../backend/Security/DeprecationScanner.js';
import {ExternalSeverity} from '../backend/Security/ExternalSourcesScanner.js';
import {ManifestRedFlagSeverity} from '../backend/Security/ManifestRedFlagsScanner.js';
import {ObfuscationSeverity} from '../backend/Security/ObfuscationScanner.js';
import {LicenseSeverity} from '../backend/Security/LicenseScanner.js';
import {MaintainerSeverity} from '../backend/Security/MaintainerScanner.js';
import {PatternSeverity} from '../backend/Security/PatternScanner.js';
import {ScriptSeverity} from '../backend/Security/ScriptScanner.js';
import {HeuristicsBatchEntry} from '../backend/Security/SecurityScanner.js';
import {UnusedReport, UnusedSeverity} from '../backend/Unused/UnusedReport.js';

/**
 * Unified severity ladder the CLI uses for `--fail-on`. Each scanner
 * has its own enum (most are info/warn/risk, license is a category
 * enum); this is the common-denominator threshold model.
 */
export enum UnifiedSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export const UNIFIED_RANK: Record<UnifiedSeverity, number> = {
    [UnifiedSeverity.info]: 1,
    [UnifiedSeverity.warn]: 2,
    [UnifiedSeverity.risk]: 3
};

/**
 * One row in the aggregated finding list. `category` lets the
 * formatter group findings; `severity` is already mapped to the
 * unified ladder so the threshold check is a single integer compare.
 */
export type ScanFinding = {
    category: 'vuln'|'script'|'pattern'|'binary'|'maintainer'|'license'|'unused'|'misplaced'|'missing'|'external'|'deprecation'|'obfuscation'|'manifestRedFlags'|'capability';
    severity: UnifiedSeverity;
    name: string;
    version?: string;
    message: string;
};

export type ProjectScanReport = {
    project: {
        name: string;
        type: ConfigProjectType;
    };
    /** Number of packages from the lockfile considered. */
    packagesScanned: number;
    /** Source-files walked by the UnusedDetector (0 when skipped). */
    filesScanned: number;
    /** Worst severity across all findings, or null when the project is clean. */
    maxSeverity: UnifiedSeverity|null;
    findings: ScanFinding[];
    /** Soft-failure note — `null` means everything ran. */
    error: string|null;
};

export type ScanReport = {
    version: '1';
    timestamp: string;
    projects: ProjectScanReport[];
    summary: {
        totalProjects: number;
        projectsWithFindings: number;
        maxSeverity: UnifiedSeverity|null;
    };
};

/**
 * Inputs for one project's report build. Bundled so the orchestrator
 * (Cli/Scan.ts) can populate fields independently — each scanner is
 * optional because the CLI flags can switch any of them off.
 */
export type ProjectScanInputs = {
    name: string;
    type: ConfigProjectType;
    packagesScanned: number;
    /** OSV batch result keyed by `${name}@${version}`. `null` value = OSV unreachable. */
    vulnsByKey?: Map<string, string[]|null>;
    heuristics?: HeuristicsBatchEntry[];
    unused?: UnusedReport;
    error?: string|null;
};

/**
 * Collects per-scanner outputs into the unified shape the CLI exits
 * on (`--fail-on`) and the formatters render. Pure static — no
 * instance state. Maps each scanner's severity enum onto the common
 * `info|warn|risk` ladder; license categories collapse via a
 * dedicated mapping (`permissive` drops out, `proprietary` is risk).
 */
export class ScanReportBuilder {

    /**
     * Map a `LicenseSeverity` (a category, not a danger level) to the
     * unified ladder so it can participate in the `--fail-on` gate.
     *  - permissive             → not a finding
     *  - weak-copyleft / unknown → info
     *  - strong-copyleft        → warn (often acceptable but worth review)
     *  - proprietary            → risk (UNLICENSED, denylist hits)
     */
    public static licenseToUnified(s: LicenseSeverity): UnifiedSeverity|null {
        switch (s) {
            case LicenseSeverity.permissive:
                return null;
            case LicenseSeverity.unknown:
            case LicenseSeverity.weakCopyleft:
                return UnifiedSeverity.info;
            case LicenseSeverity.strongCopyleft:
                return UnifiedSeverity.warn;
            case LicenseSeverity.proprietary:
                return UnifiedSeverity.risk;
        }
    }

    public static buildProject(input: ProjectScanInputs): ProjectScanReport {
        const findings: ScanFinding[] = [];

        if (input.vulnsByKey) {
            // OSV batch only returns IDs (no per-vuln severity). For
            // a CI gate "any known CVE = risk" matches npm audit's
            // default and avoids per-vuln single-query latency.
            for (const [key, ids] of input.vulnsByKey.entries()) {
                if (ids === null) {
                    continue;
                }
                if (ids.length === 0) {
                    continue;
                }
                const at = key.lastIndexOf('@');
                const pkgName = at > 0 ? key.slice(0, at) : key;
                const pkgVer = at > 0 ? key.slice(at + 1) : '';
                findings.push({
                    category: 'vuln',
                    severity: UnifiedSeverity.risk,
                    name: pkgName,
                    version: pkgVer,
                    message: `${ids.length} known vulnerabilit${ids.length === 1 ? 'y' : 'ies'} (${ids.join(', ')})`
                });
            }
        }

        if (input.heuristics) {
            for (const h of input.heuristics) {
                if (h.scripts.maxSeverity) {
                    findings.push({
                        category: 'script',
                        severity: ScanReportBuilder._scriptToUnified(h.scripts.maxSeverity),
                        name: h.name,
                        version: h.version,
                        message: `${h.scripts.count} lifecycle-script finding(s)`
                    });
                }
                if (h.patterns.maxSeverity) {
                    findings.push({
                        category: 'pattern',
                        severity: ScanReportBuilder._patternToUnified(h.patterns.maxSeverity),
                        name: h.name,
                        version: h.version,
                        message: `${h.patterns.count} suspicious code pattern(s)`
                    });
                }
                if (h.binaries.maxSeverity && h.binaries.totalCount > 0) {
                    findings.push({
                        category: 'binary',
                        severity: ScanReportBuilder._binaryToUnified(h.binaries.maxSeverity),
                        name: h.name,
                        version: h.version,
                        message: `${h.binaries.totalCount} binary file(s) in tarball (${h.binaries.riskCount} risk-classified)`
                    });
                }
                if (h.maintainer.severity) {
                    findings.push({
                        category: 'maintainer',
                        severity: ScanReportBuilder._maintainerToUnified(h.maintainer.severity),
                        name: h.name,
                        version: h.version,
                        message: h.maintainer.publisher
                            ? `publisher = ${h.maintainer.publisher}`
                            : 'publisher info present'
                    });
                }
                const licenseSev = ScanReportBuilder.licenseToUnified(h.license.severity);
                if (licenseSev !== null) {
                    findings.push({
                        category: 'license',
                        severity: licenseSev,
                        name: h.name,
                        version: h.version,
                        message: `${h.license.severity}${h.license.spdx ? ` (${h.license.spdx})` : ''}`
                    });
                }
                // External-sources aggregator — emits one row per
                // (pkg, source) pair when at least one source returned
                // a non-info verdict. Info-only deps.dev rows are
                // dropped to keep the report focused on actionable
                // signals (matches the License "permissive drops out"
                // convention).
                if (h.external.level !== null) {
                    const sev = ScanReportBuilder._externalToUnified(h.external.level);
                    if (sev !== null) {
                        findings.push({
                            category: 'external',
                            severity: sev,
                            name: h.name,
                            version: h.version,
                            message: `${h.external.count} external source(s)`
                        });
                    }
                }
                // Obfuscation — info drops (legitimate minification
                // in `dist/`), warn/risk fire. The aggregated max
                // severity is enough for the gate; per-file detail
                // lives in the panel.
                if (h.obfuscation.maxSeverity !== null) {
                    const sev = ScanReportBuilder._obfuscationToUnified(h.obfuscation.maxSeverity);
                    if (sev !== null) {
                        findings.push({
                            category: 'obfuscation',
                            severity: sev,
                            name: h.name,
                            version: h.version,
                            message: `${h.obfuscation.count} obfuscated file(s)`
                        });
                    }
                }
                // Manifest red-flags — single-flag info drops out.
                if (h.manifestRedFlags.severity !== null) {
                    const sev = ScanReportBuilder._manifestRedFlagsToUnified(h.manifestRedFlags.severity);
                    if (sev !== null) {
                        findings.push({
                            category: 'manifestRedFlags',
                            severity: sev,
                            name: h.name,
                            version: h.version,
                            message: `${h.manifestRedFlags.count} manifest red-flag(s)`
                        });
                    }
                }
                // Capability — single-capability info drops out;
                // dangerous combinations fire.
                if (h.capability.severity !== null) {
                    const sev = ScanReportBuilder._capabilityToUnified(h.capability.severity);
                    if (sev !== null) {
                        findings.push({
                            category: 'capability',
                            severity: sev,
                            name: h.name,
                            version: h.version,
                            message: `${h.capability.count} capabilities`
                        });
                    }
                }
                // Deprecation — info-only ("only older versions
                // deprecated") drops out, same convention as license
                // permissive + external info.
                if (h.deprecation.level !== null) {
                    const sev = ScanReportBuilder._deprecationToUnified(h.deprecation.level);
                    if (sev !== null) {
                        findings.push({
                            category: 'deprecation',
                            severity: sev,
                            name: h.name,
                            version: h.version,
                            message: sev === UnifiedSeverity.risk
                                ? 'installed version deprecated'
                                : 'latest version deprecated'
                        });
                    }
                }
            }
        }

        if (input.unused && input.unused.supported) {
            for (const u of input.unused.unused) {
                findings.push({
                    category: 'unused',
                    severity: ScanReportBuilder._unusedToUnified(u.severity),
                    name: u.name,
                    message: u.reason
                });
            }
            for (const m of input.unused.misplaced) {
                findings.push({
                    category: 'misplaced',
                    severity: UnifiedSeverity.warn,
                    name: m.name,
                    message: `imported only from dev-paths; first: ${m.firstImport}`
                });
            }
            for (const m of input.unused.missing) {
                findings.push({
                    category: 'missing',
                    severity: UnifiedSeverity.risk,
                    name: m.name,
                    message: `imported but not declared; first: ${m.firstImport}`
                });
            }
        }

        findings.sort((a, b) => {
            const r = UNIFIED_RANK[b.severity] - UNIFIED_RANK[a.severity];
            if (r !== 0) {
                return r;
            }
            const c = a.category.localeCompare(b.category);
            if (c !== 0) {
                return c;
            }
            return a.name.localeCompare(b.name);
        });

        let max: UnifiedSeverity|null = null;
        let maxRank = 0;
        for (const f of findings) {
            const r = UNIFIED_RANK[f.severity];
            if (r > maxRank) {
                max = f.severity;
                maxRank = r;
            }
        }

        return {
            project: {name: input.name, type: input.type},
            packagesScanned: input.packagesScanned,
            filesScanned: input.unused?.supported ? input.unused.filesScanned : 0,
            maxSeverity: max,
            findings,
            error: input.error ?? null
        };
    }

    public static summarise(projects: ProjectScanReport[]): ScanReport {
        let max: UnifiedSeverity|null = null;
        let maxRank = 0;
        let withFindings = 0;

        for (const p of projects) {
            if (p.findings.length > 0) {
                withFindings++;
            }
            if (p.maxSeverity) {
                const r = UNIFIED_RANK[p.maxSeverity];
                if (r > maxRank) {
                    max = p.maxSeverity;
                    maxRank = r;
                }
            }
        }

        return {
            version: '1',
            timestamp: new Date().toISOString(),
            projects,
            summary: {
                totalProjects: projects.length,
                projectsWithFindings: withFindings,
                maxSeverity: max
            }
        };
    }

    // The non-license enums share the same string values as
    // `UnifiedSeverity`. The casts here just satisfy TS — runtime
    // shape is identical.
    private static _scriptToUnified(s: ScriptSeverity): UnifiedSeverity {
        return s as unknown as UnifiedSeverity;
    }
    private static _patternToUnified(s: PatternSeverity): UnifiedSeverity {
        return s as unknown as UnifiedSeverity;
    }
    private static _binaryToUnified(s: BinarySeverity): UnifiedSeverity {
        return s as unknown as UnifiedSeverity;
    }
    private static _maintainerToUnified(s: MaintainerSeverity): UnifiedSeverity {
        return s as unknown as UnifiedSeverity;
    }
    private static _unusedToUnified(s: UnusedSeverity): UnifiedSeverity {
        return s as unknown as UnifiedSeverity;
    }

    /**
     * Map the external-sources aggregator's level to the CLI ladder.
     * Returns `null` for `info` so the gate doesn't fail on
     * deps.dev's info-only contributions when no real risk is
     * present (same convention as `licenseToUnified` for permissive).
     */
    private static _externalToUnified(s: ExternalSeverity): UnifiedSeverity|null {
        switch (s) {
            case ExternalSeverity.info: return null;
            case ExternalSeverity.warn: return UnifiedSeverity.warn;
            case ExternalSeverity.risk: return UnifiedSeverity.risk;
        }
    }

    /**
     * Same convention: info-only deprecation (an *older* version was
     * deprecated) is informational context, not a CI-blocker. Only
     * warn/risk feed the gate.
     */
    private static _deprecationToUnified(s: DeprecationLevel): UnifiedSeverity|null {
        switch (s) {
            case DeprecationLevel.info: return null;
            case DeprecationLevel.warn: return UnifiedSeverity.warn;
            case DeprecationLevel.risk: return UnifiedSeverity.risk;
        }
    }

    /**
     * Obfuscation `info` typically means a `dist/*.min.js` build
     * artifact — legit minification, not an actionable finding. warn
     * and risk feed the gate verbatim.
     */
    private static _obfuscationToUnified(s: ObfuscationSeverity): UnifiedSeverity|null {
        switch (s) {
            case ObfuscationSeverity.info: return null;
            case ObfuscationSeverity.warn: return UnifiedSeverity.warn;
            case ObfuscationSeverity.risk: return UnifiedSeverity.risk;
        }
    }

    private static _manifestRedFlagsToUnified(s: ManifestRedFlagSeverity): UnifiedSeverity|null {
        switch (s) {
            case ManifestRedFlagSeverity.info: return null;
            case ManifestRedFlagSeverity.warn: return UnifiedSeverity.warn;
            case ManifestRedFlagSeverity.risk: return UnifiedSeverity.risk;
        }
    }

    private static _capabilityToUnified(s: CapabilitySeverity): UnifiedSeverity|null {
        switch (s) {
            case CapabilitySeverity.info: return null;
            case CapabilitySeverity.warn: return UnifiedSeverity.warn;
            case CapabilitySeverity.risk: return UnifiedSeverity.risk;
        }
    }
}