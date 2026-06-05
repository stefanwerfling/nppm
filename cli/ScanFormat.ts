import {ProjectScanReport, ScanFinding, ScanReport, UNIFIED_RANK, UnifiedSeverity} from './ScanReport.js';
import {SarifBuilder} from './ScanSarif.js';
import {FailOnLevel, FAIL_RANK} from './CliArgs.js';

/**
 * Output formatters for the CLI runner. All static — same algorithms
 * as before, just packaged so call sites read uniformly. The text
 * mode is for humans (CI logs), `--json` for machine ingestion,
 * `--sarif` for GitHub Code Scanning.
 */
export class ScanFormatter {

    /**
     * Version stamped into the SARIF tool block. Bump when the
     * finding/rule shape changes so GitHub Code Scanning treats runs
     * before/after the bump as different toolchains.
     */
    private static readonly _TOOL_VERSION = '1';

    /**
     * Decide whether the run breached the configured threshold.
     * `none` disables the gate entirely; anything else compares
     * against the report's worst severity.
     */
    public static shouldFail(report: ScanReport, failOn: FailOnLevel): boolean {
        if (failOn === FailOnLevel.none) {
            return false;
        }
        if (!report.summary.maxSeverity) {
            return false;
        }
        return UNIFIED_RANK[report.summary.maxSeverity] >= FAIL_RANK[failOn];
    }

    /**
     * Compact human-readable text block. Designed for CI logs: one
     * project per section, findings grouped by category, no colour
     * codes (CI is often grep-piped).
     */
    public static text(report: ScanReport, failOn: FailOnLevel): string {
        const lines: string[] = [];
        lines.push(`nppm scan — ${report.summary.totalProjects} project(s) — ${report.timestamp}`);
        lines.push('');

        for (const p of report.projects) {
            lines.push(`[${p.project.name}]  (${p.project.type}, ${p.packagesScanned} pkg, ${p.filesScanned} files)`);
            if (p.error) {
                lines.push(`  ! ${p.error}`);
            }
            if (p.findings.length === 0) {
                lines.push('  ✓ no findings');
                lines.push('');
                continue;
            }
            const byCategory = new Map<string, ScanFinding[]>();
            for (const f of p.findings) {
                let arr = byCategory.get(f.category);
                if (!arr) {
                    arr = [];
                    byCategory.set(f.category, arr);
                }
                arr.push(f);
            }
            for (const [cat, arr] of byCategory.entries()) {
                lines.push(`  ${cat}: ${arr.length}`);
                for (const f of arr) {
                    const ver = f.version ? `@${f.version}` : '';
                    lines.push(`    [${f.severity}] ${f.name}${ver} — ${f.message}`);
                }
            }
            lines.push(`  max: ${p.maxSeverity}`);
            lines.push('');
        }

        lines.push(
            `Summary: ${report.summary.projectsWithFindings}/${report.summary.totalProjects} project(s) with findings`
            + ` — worst severity: ${report.summary.maxSeverity ?? 'none'}`
            + ` — gate: --fail-on=${failOn}`
        );
        if (ScanFormatter.shouldFail(report, failOn)) {
            lines.push(`Result: FAIL (worst ${report.summary.maxSeverity ?? 'none'} ≥ ${failOn})`);
        } else {
            lines.push('Result: PASS');
        }

        return lines.join('\n') + '\n';
    }

    /**
     * `JSON.stringify(report, null, 2)` — kept as a method so the
     * call sites in `Scan.ts` and the tests stay symmetric with
     * `text()`.
     */
    public static json(report: ScanReport): string {
        return JSON.stringify(report, null, 2) + '\n';
    }

    /**
     * SARIF 2.1.0 output for GitHub Code Scanning ingest. Built via
     * `Cli/ScanSarif.ts` so the JSON shape stays out of the
     * formatter.
     */
    public static sarif(report: ScanReport): string {
        return JSON.stringify(SarifBuilder.build(report, ScanFormatter._TOOL_VERSION), null, 2) + '\n';
    }
}

/** Re-exported for symmetry — the tests import threshold helpers from here. */
export {UnifiedSeverity};