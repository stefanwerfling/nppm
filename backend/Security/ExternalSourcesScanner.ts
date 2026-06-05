import {Registry} from '../Registry/Registry.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {DepsDevFetcher, DepsDevVersion} from './External/DepsDevFetcher.js';
import {OpenSsfFetcher, ScorecardResult} from './External/OpenSsfFetcher.js';
import {SocketDevFetcher, SocketDevScore} from './External/SocketDevFetcher.js';

/**
 * Three-level severity shared across all per-package scanners in this
 * codebase. Matches the existing convention (info < warn < risk) so
 * the Dashboard aggregator can map without remapping.
 */
export enum ExternalSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type ExternalSource = 'socket'|'openssf'|'depsDev';

/**
 * One finding from one external source. Kept per-source (instead of
 * pre-aggregated to a single severity) so the PackageDetailPanel can
 * render three subsections — each with its own score, link-out, and
 * detail line.
 *
 *  - `severity` is the per-source verdict on the unified ladder.
 *  - `score` is the source's native 0..100 number when one applies
 *    (socket overall × 100; OpenSSF overall × 10); `null` for deps.dev
 *    which doesn't publish a score.
 *  - `detail` is a short single-line reason — what drove the severity.
 *  - `url` is the source's deep-link for the package (rendered as
 *    "open" in the panel).
 */
export type ExternalSourceFinding = {
    source: ExternalSource;
    severity: ExternalSeverity;
    score: number|null;
    detail: string;
    url: string|null;
    /**
     * Raw per-source payload, narrowly typed. Renderers reach in for
     * the source-specific subscores / check list / project links.
     */
    raw: SocketDevScore|ScorecardResult|DepsDevVersion|null;
};

/**
 * Per-package result. `findings: []` is the boring case (every source
 * disabled or every source returned null). Worst-of-three severity is
 * pre-computed on `level` so the matrix badge / dashboard cell can
 * pick it up without re-scanning the array.
 */
export type ExternalFinding = {
    name: string;
    version: string;
    level: ExternalSeverity|null;
    findings: ExternalSourceFinding[];
};

/**
 * Compact matrix-badge summary — same shape as the other heuristic
 * summaries. `count` reports how many sources contributed a non-null
 * verdict (drives the badge's "X/3" tooltip line).
 */
export type ExternalSummary = {
    name: string;
    version: string;
    level: ExternalSeverity|null;
    count: number;
};

/**
 * Severity thresholds. Defaults reflect the source's own scoring
 * conventions:
 *  - socket overall is 0..1; we scale to 0..100 then bucket
 *  - OpenSSF is 0..10; same convention as the Scorecard team's own
 *    "low" / "medium" / "high" risk language
 *  - deps.dev contributes info only when the queried version isn't
 *    the upstream `defaultVersion`
 */
export type ExternalScannerOptions = {
    socket?: {
        enabled?: boolean;
        warnBelow?: number;
        riskBelow?: number;
    };
    openssf?: {
        enabled?: boolean;
        warnBelow?: number;
        riskBelow?: number;
    };
    depsDev?: {
        enabled?: boolean;
    };
    enabled?: boolean;
};

const DEFAULT_SOCKET_WARN = 80;
const DEFAULT_SOCKET_RISK = 50;
const DEFAULT_OPENSSF_WARN = 7;
const DEFAULT_OPENSSF_RISK = 5;

/**
 * Aggregator over three external reputation/quality APIs (socket.dev,
 * OpenSSF Scorecard, deps.dev). The Bündel pattern keeps the matrix
 * payload narrow (one summary per package, not three) while the
 * PackageDetailPanel can still render per-source detail by walking
 * `findings`.
 *
 * Disabled-by-default for socket (needs API key) and on-by-default for
 * OpenSSF + deps.dev. The top-level `enabled` master switch lets the
 * user kill all three at once without touching the per-source flags
 * (handy for offline / air-gapped setups).
 */
export class ExternalSourcesScanner {

    private readonly _registry: Registry;
    private readonly _socket: SocketDevFetcher;
    private readonly _openssf: OpenSsfFetcher;
    private readonly _depsDev: DepsDevFetcher;
    private readonly _opts: ExternalScannerOptions;

    constructor(
        registry: Registry,
        socket: SocketDevFetcher,
        openssf: OpenSsfFetcher,
        depsDev: DepsDevFetcher,
        opts: ExternalScannerOptions = {}
    ) {
        this._registry = registry;
        this._socket = socket;
        this._openssf = openssf;
        this._depsDev = depsDev;
        this._opts = opts;
    }

    public isEnabled(): boolean {
        return this._opts.enabled !== false;
    }

    /**
     * Runtime toggle for the master switch. The CLI calls this to
     * apply `--no-external` without rebuilding the whole scanner
     * tree — flipping `enabled` is enough because every per-source
     * call gates through `isEnabled()` first.
     */
    public setEnabled(value: boolean): void {
        this._opts.enabled = value;
    }

    /**
     * Whether the scanner has at least one source that would actually
     * make a network call. Used by the Dashboard route handler so it
     * can render an N/A cell ("no external source configured") instead
     * of a misleading 100/100 score when every flag is off.
     */
    public hasAnySource(): boolean {
        if (!this.isEnabled()) {
            return false;
        }
        const socketOn = this._opts.socket?.enabled !== false && this._socket.hasKey();
        const openssfOn = this._opts.openssf?.enabled !== false;
        const depsDevOn = this._opts.depsDev?.enabled !== false;
        return socketOn || openssfOn || depsDevOn;
    }

    /**
     * Scan a single `pkg@version`. Returns `findings: []` (and
     * `level: null`) when the scanner is globally disabled, when the
     * version is a git URL (no name-keyed external lookups — same
     * convention as Maintainer/Churn/Integrity), or when every
     * sub-source declined.
     */
    public async scan(name: string, version: string): Promise<ExternalFinding> {
        if (!this.isEnabled() || GitResolver.isGitVersion(version)) {
            return {name: name, version: version, level: null, findings: []};
        }

        const wantSocket = this._opts.socket?.enabled !== false && this._socket.hasKey();
        const wantOpenssf = this._opts.openssf?.enabled !== false;
        const wantDepsDev = this._opts.depsDev?.enabled !== false;

        const reg = wantOpenssf || wantDepsDev ? await this._registry.fetchOne(name) : null;
        const repo = wantOpenssf ? OpenSsfFetcher.parseRepoUrl(reg?.repository ?? null) : null;

        const [socket, openssf, depsDev] = await Promise.all([
            wantSocket ? this._socket.fetch(name, version) : Promise.resolve(null),
            wantOpenssf && repo ? this._openssf.fetch(repo) : Promise.resolve(null),
            wantDepsDev ? this._depsDev.fetch(name, version) : Promise.resolve(null)
        ]);

        const findings: ExternalSourceFinding[] = [];
        const socketFinding = this._classifySocket(socket, name, version);
        if (socketFinding) {
            findings.push(socketFinding);
        }
        const openssfFinding = this._classifyOpenssf(openssf, repo);
        if (openssfFinding) {
            findings.push(openssfFinding);
        }
        const depsDevFinding = this._classifyDepsDev(depsDev);
        if (depsDevFinding) {
            findings.push(depsDevFinding);
        }

        const level = ExternalSourcesScanner._worstSeverity(findings);
        return {name: name, version: version, level: level, findings: findings};
    }

    private _classifySocket(
        score: SocketDevScore|null,
        name: string,
        version: string
    ): ExternalSourceFinding|null {
        if (!score || score.overall === null) {
            return null;
        }
        const warnBelow = this._opts.socket?.warnBelow ?? DEFAULT_SOCKET_WARN;
        const riskBelow = this._opts.socket?.riskBelow ?? DEFAULT_SOCKET_RISK;
        const pct = Math.round(score.overall * 100);
        let severity: ExternalSeverity;
        if (pct < riskBelow) {
            severity = ExternalSeverity.risk;
        } else if (pct < warnBelow) {
            severity = ExternalSeverity.warn;
        } else {
            severity = ExternalSeverity.info;
        }
        return {
            source: 'socket',
            severity: severity,
            score: pct,
            detail: `socket overall score ${pct}/100`,
            url: `https://socket.dev/npm/package/${encodeURIComponent(name)}/overview/${encodeURIComponent(version)}`,
            raw: score
        };
    }

    private _classifyOpenssf(
        result: ScorecardResult|null,
        repo: {host: string; owner: string; repo: string;}|null
    ): ExternalSourceFinding|null {
        if (!result || result.score === null || !repo) {
            return null;
        }
        const warnBelow = this._opts.openssf?.warnBelow ?? DEFAULT_OPENSSF_WARN;
        const riskBelow = this._opts.openssf?.riskBelow ?? DEFAULT_OPENSSF_RISK;
        let severity: ExternalSeverity;
        if (result.score < riskBelow) {
            severity = ExternalSeverity.risk;
        } else if (result.score < warnBelow) {
            severity = ExternalSeverity.warn;
        } else {
            severity = ExternalSeverity.info;
        }
        const pct = Math.round(result.score * 10);
        return {
            source: 'openssf',
            severity: severity,
            score: pct,
            detail: `OpenSSF Scorecard ${result.score.toFixed(1)}/10`,
            url: `https://scorecard.dev/viewer/?uri=${encodeURIComponent(`${repo.host}/${repo.owner}/${repo.repo}`)}`,
            raw: result
        };
    }

    private _classifyDepsDev(result: DepsDevVersion|null): ExternalSourceFinding|null {
        if (!result) {
            return null;
        }
        /*
         * deps.dev contributes informational context only — no severity
         * escalation. Stays info regardless of `isDefault` so the panel
         * can still render the "default version is X" hint.
         */
        const detail = result.defaultVersion && !result.isDefault
            ? `deps.dev default version: ${result.defaultVersion}`
            : 'deps.dev metadata available';
        return {
            source: 'depsDev',
            severity: ExternalSeverity.info,
            score: null,
            detail: detail,
            url: `https://deps.dev/npm/${encodeURIComponent(result.versionKey.name)}/${encodeURIComponent(result.versionKey.version)}`,
            raw: result
        };
    }

    /**
     * Bulk variant for the matrix / Dashboard pipelines. Bounded
     * concurrency mirrors `SecurityScanner.scanHeuristicsBatch` so a
     * project-wide pass doesn't fan out into hundreds of parallel
     * fetches. Returns one entry per input coordinate, in input order.
     */
    public async scanBatch(
        packages: {name: string; version: string;}[],
        concurrency = 10
    ): Promise<ExternalFinding[]> {
        const result: ExternalFinding[] = new Array(packages.length);
        let cursor = 0;

        const runOne = async(): Promise<void> => {
            while (true) {
                const i = cursor++;
                if (i >= packages.length) {
                    return;
                }
                const pkg = packages[i];
                try {
                    result[i] = await this.scan(pkg.name, pkg.version);
                } catch {
                    result[i] = {name: pkg.name, version: pkg.version, level: null, findings: []};
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
     * Compact summary for the matrix badge. Same convention as the
     * other heuristic summaries: `level: null` when no source
     * contributed a verdict.
     */
    public static summarise(finding: ExternalFinding): ExternalSummary {
        return {
            name: finding.name,
            version: finding.version,
            level: finding.level,
            count: finding.findings.length
        };
    }

    private static _worstSeverity(findings: ExternalSourceFinding[]): ExternalSeverity|null {
        let best: ExternalSeverity|null = null;
        let rank = 0;
        const rankOf: Record<ExternalSeverity, number> = {
            [ExternalSeverity.info]: 1,
            [ExternalSeverity.warn]: 2,
            [ExternalSeverity.risk]: 3
        };
        for (const f of findings) {
            const r = rankOf[f.severity];
            if (r > rank) {
                rank = r;
                best = f.severity;
            }
        }
        return best;
    }

}