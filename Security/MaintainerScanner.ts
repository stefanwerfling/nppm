import {isGitVersion} from '../Fingerprint/GitResolver.js';
import {Registry, RegistryPublisher} from '../Registry/Registry.js';

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
};

type SemverTriple = [number, number, number];

function parseSemver(v: string): SemverTriple|null {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [+m[1], +m[2], +m[3]] : null;
}

function compare(a: SemverTriple, b: SemverTriple): number {
    if (a[0] !== b[0]) {
        return a[0] - b[0];
    }
    if (a[1] !== b[1]) {
        return a[1] - b[1];
    }
    return a[2] - b[2];
}

/**
 * Sort the registry version list into chronologically-stable order
 * (semver ascending), filtering pre-releases. Returns the highest
 * stable versions below `target` ordered newest-first — we walk it
 * from index 0 to build the trust set of the most recent N predecessors.
 */
export function previousStableVersions(versions: string[], target: string): string[] {
    const tgt = parseSemver(target);
    if (!tgt) {
        return [];
    }

    const triples: {v: string; t: SemverTriple}[] = [];
    for (const raw of versions) {
        const t = parseSemver(raw);
        if (!t) {
            continue;
        }
        if (compare(t, tgt) >= 0) {
            continue;
        }
        triples.push({v: raw, t});
    }

    triples.sort((a, b) => compare(b.t, a.t));
    return triples.map((e) => e.v);
}

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

function diffDays(a: string|undefined, b: string|undefined): number|null {
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
    private readonly _quickHandoverDays: number;
    private readonly _suspiciousGapDays: number;
    private readonly _matureVersions: number;
    private readonly _trustWindow: number;

    constructor(registry: Registry, opts: MaintainerScannerOptions = {}) {
        this._registry = registry;
        this._quickHandoverDays = opts.quickHandoverDays ?? DEFAULT_QUICK_HANDOVER_DAYS;
        this._suspiciousGapDays = opts.suspiciousGapDays ?? DEFAULT_SUSPICIOUS_GAP_DAYS;
        this._matureVersions = opts.matureVersions ?? DEFAULT_MATURE_VERSIONS;
        this._trustWindow = opts.trustWindow ?? DEFAULT_TRUST_WINDOW;
    }

    public async scan(name: string, version: string): Promise<MaintainerFinding|null> {
        if (isGitVersion(version)) {
            return null;
        }

        const reg = await this._registry.fetchOne(name);
        if (!reg) {
            return null;
        }

        const publishers = reg.publishers ?? {};
        const current = publishers[version] ?? null;

        const predecessors = previousStableVersions(reg.versions, version);
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
            ? diffDays(reg.time[version], reg.time[previous])
            : null;

        // No prior history to compare against → not flaggable.
        if (priorWithPub === 0) {
            return {
                currentPublisher: current,
                trustedPublishers: [],
                priorVersionsWithPublisher: 0,
                gapDays,
                severity: MaintainerSeverity.info,
                reason: 'Keine Vorgänger mit Publisher-Info — kein Trust-Set bildbar'
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
                reason: 'Diese Version hat kein `_npmUser`-Feld im Registry'
            };
        }

        if (trustSet.has(current.name)) {
            return {
                currentPublisher: current,
                trustedPublishers,
                priorVersionsWithPublisher: priorWithPub,
                gapDays,
                severity: MaintainerSeverity.info,
                reason: `Bekannter Publisher (${current.name})`
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
                reason: `Neuer Publisher (${current.name}) nach nur ${gapDays} Tagen — `
                    + `aktives Paket (${priorWithPub} Vorgänger) wechselt blitzschnell den Owner, `
                    + `typisches Account-Takeover-Muster (event-stream/ua-parser-js-Profil)`
            };
        }

        if (mature && gapKnown && gapDays <= this._suspiciousGapDays) {
            return {
                currentPublisher: current,
                trustedPublishers,
                priorVersionsWithPublisher: priorWithPub,
                gapDays,
                severity: MaintainerSeverity.warn,
                reason: `Neuer Publisher (${current.name}) nach ${gapDays} Tagen — `
                    + `mittlere Lücke auf einem etablierten Paket, ein Blick lohnt sich`
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
                reason: `Neuer Publisher (${current.name}) nach ${gapDays} Tagen Stille — `
                    + `lange Pause spricht eher für eine legitime Community-Übernahme `
                    + `eines verwaisten Pakets als für einen Angriff`
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
                reason: `Neuer Publisher (${current.name}) für ein etabliertes Paket `
                    + `(${priorWithPub} Vorgänger), Veröffentlichungslücke unbekannt`
            };
        }

        return {
            currentPublisher: current,
            trustedPublishers,
            priorVersionsWithPublisher: priorWithPub,
            gapDays,
            severity: MaintainerSeverity.warn,
            reason: `Neuer Publisher (${current.name}), aber Paket noch jung `
                + `(${priorWithPub} Vorgänger) — könnte legitimer neuer Maintainer sein`
        };
    }
}

/**
 * Compact summary for the matrix badge — same shape as the other
 * heuristic summaries (`ScriptSummary`, `PatternSummary`, …).
 */
export type MaintainerSummary = {
    name: string;
    version: string;
    severity: MaintainerSeverity|null;
    publisher: string|null;
};