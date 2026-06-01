import {GitResolver} from '../Fingerprint/GitResolver.js';
import {Registry, RegistryPublisher} from '../Registry/Registry.js';
import {Npm2FaFetcher} from './Npm2FaFetcher.js';

/**
 * Three-level severity, matching the other scanners. `info` = trusted
 * publisher or insufficient history; `warn` = first-time publisher on a
 * young package or short publish gap; `risk` = first-time publisher on
 * a mature package after a long silence (classic account-takeover
 * profile).
 */
export enum MaintainerSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type MaintainerFinding = {
    /** npm `_npmUser` of the inspected version, or `null` if absent. */
    currentPublisher: RegistryPublisher|null;
    /**
     * Distinct publisher names seen across the prior stable versions
     * considered for the trust set. Useful for the UI tooltip.
     */
    trustedPublishers: string[];
    /** Number of prior stable versions that contributed a publisher. */
    priorVersionsWithPublisher: number;
    /** Days between the inspected version's publish time and its predecessor. */
    gapDays: number|null;
    severity: MaintainerSeverity;
    reason: string;
    /**
     * 2FA status of the current publisher's npm account, when the
     * registry was willing to disclose it.
     *
     *   - `true`  → 2FA enabled (login *and/or* publish gated)
     *   - `false` → no 2FA on the account
     *   - `null`  → registry refused to tell us (typically 401 on the
     *               public mirror) or no `Npm2FaFetcher` was wired
     *
     * The scanner *does not* change its severity decision based on
     * this field — it would punish accounts on public mirrors that
     * never expose `tfa` to anonymous queries. The UI surfaces it
     * separately so the user can factor it into their own judgement.
     */
    currentPublisher2FA?: boolean|null;
};

type SemverTriple = [number, number, number];

/**
 * Tuning options for the heuristic. All values are days unless noted;
 * pass an empty object (or omit entirely) to take the defaults, which
 * reflect the empirical attack patterns:
 *
 *  - The real npm-account-takeover incidents (event-stream, ua-parser-
 *    js, coa, rc, @solana/web3.js) had *short* handover gaps — an
 *    actively maintained package suddenly published by a new account.
 *  - A *long* silence followed by a new publisher is, in practice,
 *    much more often a legitimate community takeover of an abandoned
 *    package than an attack.
 *
 * The default ladder is therefore:
 *
 *  - gap ≤ 30d   + mature + new publisher → `risk`
 *  - gap ≤ 180d  + mature + new publisher → `warn`
 *  - gap > 180d  + mature + new publisher → `info` (community-takeover note)
 *  - young package                          → `warn` (regardless of gap)
 */
export type MaintainerScannerOptions = {
    /** Gap ≤ this on a mature package marks the finding as `risk`. */
    quickHandoverDays?: number;
    /** Gap ≤ this (but > `quickHandoverDays`) on a mature package marks `warn`. */
    suspiciousGapDays?: number;
    /** Minimum predecessor count for risk/warn classification. */
    matureVersions?: number;
    /** How many recent predecessors contribute to the trust set. */
    trustWindow?: number;
};

const DEFAULT_QUICK_HANDOVER_DAYS = 30;
const DEFAULT_SUSPICIOUS_GAP_DAYS = 180;
const DEFAULT_MATURE_VERSIONS = 10;
const DEFAULT_TRUST_WINDOW = 20;

/**
 * Detects when a published version's `_npmUser` is unfamiliar relative
 * to recent prior versions of the same package. Designed to catch the
 * classic npm account-takeover pattern (dormant package + new
 * publisher + sudden release) — a signal no other scanner in this
 * project covers.
 *
 * Returns `null` only when we cannot scan at all (git install, missing
 * registry record). When the package exists but lacks any prior
 * publishers we still emit an `info` finding so the UI can communicate
 * the absence rather than silently hide it.
 */
export class MaintainerScanner {

    private readonly _registry: Registry;
    private readonly _tfaFetcher: Npm2FaFetcher|null;
    private readonly _quickHandoverDays: number;
    private readonly _suspiciousGapDays: number;
    private readonly _matureVersions: number;
    private readonly _trustWindow: number;

    constructor(
        registry: Registry,
        opts: MaintainerScannerOptions = {},
        tfaFetcher: Npm2FaFetcher|null = null
    ) {
        this._registry = registry;
        this._tfaFetcher = tfaFetcher;
        this._quickHandoverDays = opts.quickHandoverDays ?? DEFAULT_QUICK_HANDOVER_DAYS;
        this._suspiciousGapDays = opts.suspiciousGapDays ?? DEFAULT_SUSPICIOUS_GAP_DAYS;
        this._matureVersions = opts.matureVersions ?? DEFAULT_MATURE_VERSIONS;
        this._trustWindow = opts.trustWindow ?? DEFAULT_TRUST_WINDOW;
    }

    public async scan(name: string, version: string): Promise<MaintainerFinding|null> {
        const finding = await this._classify(name, version);
        if (finding === null) {
            return null;
        }
        finding.currentPublisher2FA = await this._fetch2FA(finding.currentPublisher?.name);
        return finding;
    }

    /**
     * Resolve the current publisher's 2FA state via the optional
     * fetcher. Always returns `null` when no fetcher is wired (every
     * test that constructed the scanner without one) so the field is
     * present but explicitly "unknown".
     */
    private async _fetch2FA(username: string|null|undefined): Promise<boolean|null> {
        if (!this._tfaFetcher || !username) {
            return null;
        }
        return this._tfaFetcher.fetch(username);
    }

    /**
     * Original severity-classification logic. Returns the finding
     * without the 2FA enrichment, which `scan()` attaches as a single
     * follow-up step. Split out so every return branch doesn't have
     * to await the fetcher itself.
     */
    private async _classify(name: string, version: string): Promise<MaintainerFinding|null> {
        if (GitResolver.isGitVersion(version)) {
            return null;
        }

        const reg = await this._registry.fetchOne(name);
        if (!reg) {
            return null;
        }

        const publishers = reg.publishers ?? {};
        const current = publishers[version] ?? null;

        const predecessors = MaintainerScanner.previousStableVersions(reg.versions, version);
        const window = predecessors.slice(0, this._trustWindow);

        const trustSet = new Set<string>();
        for (const v of window) {
            const p = publishers[v];
            if (p) {
                trustSet.add(p.name);
            }
        }

        const trustedPublishers = Array.from(trustSet).sort();
        const priorWithPub = window.filter((v) => publishers[v]).length;

        const previous = predecessors[0] ?? null;
        const gapDays = previous && reg.time
            ? MaintainerScanner._diffDays(reg.time[version], reg.time[previous])
            : null;

        // No prior history to compare against → not flaggable.
        if (priorWithPub === 0) {
            return {
                currentPublisher: current,
                trustedPublishers: [],
                priorVersionsWithPublisher: 0,
                gapDays,
                severity: MaintainerSeverity.info,
                reason: 'No predecessors with publisher info — cannot build a trust set'
            };
        }

        // Current version has no publisher recorded — typical for
        // pre-2014 releases; cannot meaningfully compare.
        if (!current) {
            return {
                currentPublisher: null,
                trustedPublishers,
                priorVersionsWithPublisher: priorWithPub,
                gapDays,
                severity: MaintainerSeverity.info,
                reason: 'This version has no `_npmUser` field in the registry'
            };
        }

        if (trustSet.has(current.name)) {
            return {
                currentPublisher: current,
                trustedPublishers,
                priorVersionsWithPublisher: priorWithPub,
                gapDays,
                severity: MaintainerSeverity.info,
                reason: `Known publisher (${current.name})`
            };
        }

        // First-time publisher. Severity is driven by *how quickly* the
        // handover happened on a mature package — the empirical attack
        // pattern is "active project, sudden owner change", not "dormant
        // project, new maintainer adopts it" (the latter is usually
        // benign community takeover).
        const mature = priorWithPub >= this._matureVersions;
        const gapKnown = gapDays !== null;

        if (mature && gapKnown && gapDays <= this._quickHandoverDays) {
            return {
                currentPublisher: current,
                trustedPublishers,
                priorVersionsWithPublisher: priorWithPub,
                gapDays,
                severity: MaintainerSeverity.risk,
                reason: `New publisher (${current.name}) after only ${gapDays} days — `
                    + `active package (${priorWithPub} predecessors) switched owner abruptly, `
                    + `classic account-takeover pattern (event-stream / ua-parser-js profile)`
            };
        }

        if (mature && gapKnown && gapDays <= this._suspiciousGapDays) {
            return {
                currentPublisher: current,
                trustedPublishers,
                priorVersionsWithPublisher: priorWithPub,
                gapDays,
                severity: MaintainerSeverity.warn,
                reason: `New publisher (${current.name}) after ${gapDays} days — `
                    + `mid-length gap on an established package, worth a look`
            };
        }

        if (mature && gapKnown) {
            // Long silence + new publisher — usually a legitimate
            // community takeover of an abandoned package. Demote to
            // info but make the context explicit.
            return {
                currentPublisher: current,
                trustedPublishers,
                priorVersionsWithPublisher: priorWithPub,
                gapDays,
                severity: MaintainerSeverity.info,
                reason: `New publisher (${current.name}) after ${gapDays} days of silence — `
                    + `long pause usually points to a legitimate community takeover `
                    + `of an abandoned package rather than an attack`
            };
        }

        // Unknown gap (missing `time` info) — fall back to warn for
        // mature packages, info for young ones.
        if (mature) {
            return {
                currentPublisher: current,
                trustedPublishers,
                priorVersionsWithPublisher: priorWithPub,
                gapDays,
                severity: MaintainerSeverity.warn,
                reason: `New publisher (${current.name}) on an established package `
                    + `(${priorWithPub} predecessors), publish gap unknown`
            };
        }

        return {
            currentPublisher: current,
            trustedPublishers,
            priorVersionsWithPublisher: priorWithPub,
            gapDays,
            severity: MaintainerSeverity.warn,
            reason: `New publisher (${current.name}), but package is still young `
                + `(${priorWithPub} predecessors) — could be a legitimate new maintainer`
        };
    }

    /**
     * Sort the registry version list into chronologically-stable
     * order (semver ascending), filtering pre-releases. Returns the
     * highest stable versions below `target` ordered newest-first —
     * the trust-set walk takes the top N from index 0. Public because
     * the tests exercise it directly.
     */
    public static previousStableVersions(versions: string[], target: string): string[] {
        const tgt = MaintainerScanner._parseSemver(target);
        if (!tgt) {
            return [];
        }

        const triples: {v: string; t: SemverTriple}[] = [];
        for (const raw of versions) {
            const t = MaintainerScanner._parseSemver(raw);
            if (!t) {
                continue;
            }
            if (MaintainerScanner._compare(t, tgt) >= 0) {
                continue;
            }
            triples.push({v: raw, t});
        }

        triples.sort((a, b) => MaintainerScanner._compare(b.t, a.t));
        return triples.map((e) => e.v);
    }

    private static _parseSemver(v: string): SemverTriple|null {
        const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
        return m ? [+m[1], +m[2], +m[3]] : null;
    }

    private static _compare(a: SemverTriple, b: SemverTriple): number {
        if (a[0] !== b[0]) {
            return a[0] - b[0];
        }
        if (a[1] !== b[1]) {
            return a[1] - b[1];
        }
        return a[2] - b[2];
    }

    private static _diffDays(a: string|undefined, b: string|undefined): number|null {
        if (!a || !b) {
            return null;
        }
        const ta = Date.parse(a);
        const tb = Date.parse(b);
        if (isNaN(ta) || isNaN(tb)) {
            return null;
        }
        return Math.round(Math.abs(ta - tb) / (24 * 60 * 60 * 1000));
    }
}

/**
 * Compact summary for the matrix badge — same shape as the other
 * heuristic summaries (`ScriptSummary`, `PatternSummary`, …). `publisher2FA`
 * mirrors `MaintainerFinding.currentPublisher2FA` so the matrix
 * tooltip can flag accounts the registry confirmed have 2FA off
 * without re-fetching anything.
 */
export type MaintainerSummary = {
    name: string;
    version: string;
    severity: MaintainerSeverity|null;
    publisher: string|null;
    publisher2FA?: boolean|null;
};