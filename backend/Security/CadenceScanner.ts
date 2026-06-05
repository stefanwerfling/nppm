/**
 * Three-level "is this package still alive?" severity. Mirrors the
 * other scanners' info/warn/risk shape so the matrix score can
 * aggregate without a remap.
 *
 *  - `info`: actively maintained — last release inside the warn
 *    window (default 180 days). Most packages on a healthy stack
 *    land here.
 *  - `warn`: slowing down — last release between the warn and risk
 *    windows. Could be a stable mature package (lodash-style) or a
 *    project losing steam; the badge surfaces the question.
 *  - `risk`: likely abandoned — last release past the risk window
 *    (default 730 days = 2 years).
 */
export enum CadenceLevel {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type CadenceFinding = {
    level: CadenceLevel;
    /** ISO timestamp of the most recent registry-recorded release. */
    lastReleaseAt: string|null;
    /** Whole days between the last release and `now`. */
    daysSinceLastRelease: number|null;
    /**
     * Median gap (in days) between consecutive releases over the
     * recent window (default last 10 gaps). Gives the UI a sense of
     * the project's natural rhythm — "release every 30 days" vs.
     * "release every 6 months".
     */
    medianCadenceDays: number|null;
    /** Total number of registry-recorded releases. */
    releaseCount: number;
    reason: string;
};

export type CadenceSummary = {
    name: string;
    version: string;
    level: CadenceLevel|null;
    daysSinceLastRelease: number|null;
    medianCadenceDays: number|null;
};

/**
 * Tunable thresholds. Defaults are conservative: a 6-month silence
 * raises `warn`, a 2-year silence raises `risk`. Set lower in
 * `nppm.json` for projects on fast-moving stacks where any
 * 3-month-old package should already be a flag.
 */
export type CadenceScannerOptions = {
    /** Last-release-was-this-long-ago → `warn`. Default 180 days. */
    warnDays?: number;
    /** Last-release-was-this-long-ago → `risk`. Default 730 days. */
    riskDays?: number;
    /** Number of recent gaps to median over. Default 10. */
    windowSize?: number;
    /** Reference timestamp for age math. Defaults to `Date.now()`. */
    now?: number;
};

const DEFAULT_WARN_DAYS = 180;
const DEFAULT_RISK_DAYS = 730;
const DEFAULT_WINDOW = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure-function release-cadence classifier. Takes the npm registry's
 * `time` map (version → ISO timestamp) and computes both
 *   - the gap between the most recent release and now, and
 *   - the median gap between consecutive releases over a recent
 *     window.
 *
 * Static by design: the registry's `time` map is already in the
 * cached `RegistryPackage` envelope so no I/O lives here.
 *
 * The npm `time` map embeds two non-version sentinel keys (`created`
 * + `modified`) that the scanner explicitly skips — including them
 * would skew the cadence with an artificial "release" at package
 * creation time.
 */
export class CadenceScanner {

    public static classify(
        timeMap: Record<string, string>|undefined|null,
        opts: CadenceScannerOptions = {}
    ): CadenceFinding|null {
        if (!timeMap) {
            return null;
        }

        const stamps: number[] = [];
        for (const [key, iso] of Object.entries(timeMap)) {
            if (key === 'created' || key === 'modified') {
                continue;
            }
            const t = Date.parse(iso);
            if (!isNaN(t)) {
                stamps.push(t);
            }
        }
        if (stamps.length === 0) {
            return null;
        }

        stamps.sort((a, b) => a - b);

        const warnDays = opts.warnDays ?? DEFAULT_WARN_DAYS;
        const riskDays = opts.riskDays ?? DEFAULT_RISK_DAYS;
        const windowSize = opts.windowSize ?? DEFAULT_WINDOW;
        const now = opts.now ?? Date.now();

        const last = stamps[stamps.length - 1];
        const daysSinceLastRelease = Math.max(0, Math.floor((now - last) / MS_PER_DAY));

        // Median of consecutive gaps over the recent window.
        // `windowSize` is the number of *gaps* we want — that
        // requires `windowSize + 1` adjacent stamps to derive.
        const gapWindow = stamps.slice(-(windowSize + 1));
        const gaps: number[] = [];
        for (let i = 1; i < gapWindow.length; i++) {
            gaps.push((gapWindow[i] - gapWindow[i - 1]) / MS_PER_DAY);
        }
        const medianCadenceDays = gaps.length > 0
            ? Math.round(CadenceScanner._median(gaps))
            : null;

        const level = daysSinceLastRelease >= riskDays
            ? CadenceLevel.risk
            : daysSinceLastRelease >= warnDays
                ? CadenceLevel.warn
                : CadenceLevel.info;

        return {
            level,
            lastReleaseAt: new Date(last).toISOString(),
            daysSinceLastRelease,
            medianCadenceDays,
            releaseCount: stamps.length,
            reason: CadenceScanner._reason(level, daysSinceLastRelease, medianCadenceDays, warnDays, riskDays)
        };
    }

    /**
     * Standard median. For an even-length sample we average the two
     * mid elements so a 2-month cadence and a 6-month cadence don't
     * tilt the value arbitrarily to whichever the sort hit first.
     */
    private static _median(arr: number[]): number {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = sorted.length / 2;
        if (Number.isInteger(mid)) {
            return (sorted[mid - 1] + sorted[mid]) / 2;
        }
        return sorted[Math.floor(mid)];
    }

    private static _reason(
        level: CadenceLevel,
        daysSinceLastRelease: number,
        medianCadenceDays: number|null,
        warnDays: number,
        riskDays: number
    ): string {
        const cadence = medianCadenceDays !== null
            ? `, median cadence every ${medianCadenceDays} days`
            : '';
        if (level === CadenceLevel.risk) {
            return `Last release ${daysSinceLastRelease} days ago${cadence} — likely abandoned (≥ ${riskDays}d silence)`;
        }
        if (level === CadenceLevel.warn) {
            return `Last release ${daysSinceLastRelease} days ago${cadence} — slowing down (≥ ${warnDays}d silence)`;
        }
        return `Last release ${daysSinceLastRelease} days ago${cadence} — actively maintained`;
    }
}
