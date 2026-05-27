import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {Registry} from '../Registry/Registry.js';
import {
    BinaryFinding,
    BinarySeverity,
    BinarySummary,
    scanBinaries,
    summariseBinaries
} from './BinaryScanner.js';
import {ChurnFinding, ChurnScanner} from './ChurnScanner.js';
import {OsvClient, OsvVulnerability} from './OsvClient.js';
import {PatternFinding, PatternSeverity, scanPatterns} from './PatternScanner.js';
import {scanScripts, ScriptFinding, ScriptSeverity} from './ScriptScanner.js';

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
    private readonly _churn: ChurnScanner;

    constructor(osv: OsvClient, fingerprint: FingerprintBuilder, registry: Registry) {
        this._osv = osv;
        this._fingerprint = fingerprint;
        this._churn = new ChurnScanner(registry, fingerprint);
    }

    public async scan(name: string, version: string): Promise<SecurityReport> {
        // OSV, fingerprint, and churn all hit independent caches/network
        // endpoints — fire them in parallel. ChurnScanner internally
        // hits the fingerprint cache twice (previous + current) but
        // both share the same cache pocket so warm runs are cheap.
        const [vulns, fingerprint, churn] = await Promise.all([
            this._osv.query(name, version),
            this._fingerprint.build(name, version),
            this._churn.scan(name, version)
        ]);

        const scriptFindings = scanScripts(fingerprint?.manifest ?? null);
        const patternFindings = fingerprint ? scanPatterns(fingerprint.files) : [];
        const binaryFindings = fingerprint ? scanBinaries(fingerprint.files) : [];

        return {name, version, vulns, scriptFindings, churn, patternFindings, binaryFindings};
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
                const fingerprint = await this._fingerprint.build(pkg.name, pkg.version);

                const scriptFindings = scanScripts(fingerprint?.manifest ?? null);
                const patternFindings = fingerprint ? scanPatterns(fingerprint.files) : [];
                const binaryFindings = fingerprint ? scanBinaries(fingerprint.files) : [];
                const binSummary = summariseBinaries(binaryFindings);

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
                    }
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