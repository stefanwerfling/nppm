/**
 * Three-level "brand new" severity. Mirrors the other scanners so
 * the unified score can aggregate without conditional remaps.
 *
 *  - `risk`: package or maintainer account is younger than
 *    `riskDays` (default 7). Classic typosquat profile — a fresh
 *    account that pushed its very first release a few days ago.
 *  - `warn`: younger than `warnDays` (default 30) but past the risk
 *    threshold. Still worth noticing; legitimate new projects also
 *    land here.
 *  - `info`: both signals are at least `warnDays` old, or we have no
 *    data to judge either. Normal day-to-day case.
 */
export enum FreshnessLevel {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type FreshnessFinding = {
    level: FreshnessLevel;
    /** ISO timestamp of first publish (`time.created` from the packument). */
    firstPublishedAt: string|null;
    /** Whole days since first publish, or `null` when unknown. */
    packageAgeDays: number|null;
    /** ISO timestamp of the current publisher's npm-account creation. */
    maintainerCreatedAt: string|null;
    /** Whole days since the publisher's account was created, or `null`. */
    maintainerAgeDays: number|null;
    /** Human-readable explanation, including which signal drove the level. */
    reason: string;
};

/**
 * Compact summary for the matrix badge — same shape as the other
 * heuristic summaries.
 */
export type FreshnessSummary = {
    name: string;
    version: string;
    level: FreshnessLevel|null;
    packageAgeDays: number|null;
    maintainerAgeDays: number|null;
};

/**
 * Tunable thresholds. Defaults match the next-steps note that
 * originally proposed this scanner — <30 days yellow, <7 days red.
 */
export type FreshnessScannerOptions = {
    warnDays?: number;
    riskDays?: number;
    /** Reference timestamp used for age math. Defaults to "now"; tests can pin it. */
    now?: number;
};

const DEFAULT_WARN_DAYS = 30;
const DEFAULT_RISK_DAYS = 7;

/**
 * Pure-function "brand new" classifier. Takes two timestamps (package
 * first-published + publisher account creation) and reports the
 * worse-of-two severity. Static by design — no I/O lives here; the
 * caller already has the data from the registry packument and the
 * shared `NpmUserFetcher`.
 *
 * `classify` returns `null` only when both inputs are `null` (nothing
 * to classify at all). With even one valid timestamp it returns a
 * finding so the UI can render partial information.
 */
export class FreshnessScanner {

    public static classify(
        input: {firstPublishedAt: string|null; maintainerCreatedAt: string|null},
        opts: FreshnessScannerOptions = {}
    ): FreshnessFinding|null {
        const warnDays = opts.warnDays ?? DEFAULT_WARN_DAYS;
        const riskDays = opts.riskDays ?? DEFAULT_RISK_DAYS;
        const now = opts.now ?? Date.now();

        const packageAgeDays = FreshnessScanner._diffDays(input.firstPublishedAt, now);
        const maintainerAgeDays = FreshnessScanner._diffDays(input.maintainerCreatedAt, now);

        if (packageAgeDays === null && maintainerAgeDays === null) {
            return null;
        }

        const pkgLevel = FreshnessScanner._levelFor(packageAgeDays, warnDays, riskDays);
        const mntLevel = FreshnessScanner._levelFor(maintainerAgeDays, warnDays, riskDays);
        const level = FreshnessScanner._maxLevel(pkgLevel, mntLevel);

        return {
            level,
            firstPublishedAt: input.firstPublishedAt,
            packageAgeDays,
            maintainerCreatedAt: input.maintainerCreatedAt,
            maintainerAgeDays,
            reason: FreshnessScanner._reason(level, packageAgeDays, maintainerAgeDays, warnDays, riskDays)
        };
    }

    private static _diffDays(iso: string|null, now: number): number|null {
        if (!iso) {
            return null;
        }
        const t = Date.parse(iso);
        if (isNaN(t)) {
            return null;
        }
        return Math.max(0, Math.floor((now - t) / (24 * 60 * 60 * 1000)));
    }

    /**
     * Translate one age value into a freshness level. `null` ages
     * contribute `info` — absence of data must never escalate
     * severity (would punish public-mirror users who can't read the
     * user endpoint).
     */
    private static _levelFor(age: number|null, warnDays: number, riskDays: number): FreshnessLevel {
        if (age === null) {
            return FreshnessLevel.info;
        }
        if (age < riskDays) {
            return FreshnessLevel.risk;
        }
        if (age < warnDays) {
            return FreshnessLevel.warn;
        }
        return FreshnessLevel.info;
    }

    private static _maxLevel(a: FreshnessLevel, b: FreshnessLevel): FreshnessLevel {
        const rank: Record<FreshnessLevel, number> = {
            [FreshnessLevel.info]: 0,
            [FreshnessLevel.warn]: 1,
            [FreshnessLevel.risk]: 2
        };
        return rank[a] >= rank[b] ? a : b;
    }

    /**
     * Produce a human-readable reason string keyed off the level and
     * which signal drove it. Kept in English (backend convention);
     * the UI translates if it wants to localise.
     */
    private static _reason(
        level: FreshnessLevel,
        packageAgeDays: number|null,
        maintainerAgeDays: number|null,
        warnDays: number,
        riskDays: number
    ): string {
        const fragments: string[] = [];
        if (packageAgeDays !== null) {
            fragments.push(`package first published ${packageAgeDays} days ago`);
        }
        if (maintainerAgeDays !== null) {
            fragments.push(`publisher account ${maintainerAgeDays} days old`);
        }
        const head = fragments.join(', ');

        if (level === FreshnessLevel.risk) {
            return `${head} — younger than ${riskDays} days, classic squat / brand-new-account profile`;
        }
        if (level === FreshnessLevel.warn) {
            return `${head} — younger than ${warnDays} days but past the risk threshold`;
        }
        if (fragments.length === 0) {
            return 'No publish-date data available — cannot judge freshness';
        }
        return `${head} — both signals are normal`;
    }
}