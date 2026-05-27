import {FingerprintBuilder} from '../Fingerprint/FingerprintBuilder.js';
import {diffFingerprints} from '../Fingerprint/FingerprintDiff.js';
import {isGitVersion} from '../Fingerprint/GitResolver.js';
import {Registry} from '../Registry/Registry.js';

/**
 * Three-level severity that mirrors `ScriptSeverity` so the UI can
 * reuse the same colour ladder. `info` = normal-looking bump; `warn` =
 * unexpectedly large patch/minor; `risk` = extreme spike.
 */
export enum ChurnSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type ChurnBumpType = 'major'|'minor'|'patch';

export type ChurnFinding = {
    previousVersion: string;
    bumpType: ChurnBumpType;
    added: number;
    removed: number;
    modified: number;
    severity: ChurnSeverity;
    reason: string;
};

type SemverTriple = [number, number, number];

function parseSemver(v: string): SemverTriple|null {
    // We only treat stable `x.y.z` releases as potential predecessors.
    // Pre-release versions (`1.0.0-rc.1`) are filtered out: most npm
    // packages release them sporadically and they pollute the
    // "previous stable" heuristic.
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

function bumpType(prev: SemverTriple, latest: SemverTriple): ChurnBumpType|null {
    if (latest[0] > prev[0]) {
        return 'major';
    }
    if (latest[1] > prev[1]) {
        return 'minor';
    }
    if (latest[2] > prev[2]) {
        return 'patch';
    }
    return null;
}

/**
 * Pick the highest stable version below `target` from a registry's
 * `versions[]` list. Returns null when nothing qualifies — single-
 * release packages, prereleases-only, or target itself missing.
 */
export function findPreviousVersion(versions: string[], target: string): string|null {
    const tgt = parseSemver(target);
    if (!tgt) {
        return null;
    }

    let best: {v: string; t: SemverTriple}|null = null;

    for (const raw of versions) {
        const t = parseSemver(raw);
        if (!t) {
            continue;
        }
        if (compare(t, tgt) >= 0) {
            continue;
        }
        if (!best || compare(t, best.t) > 0) {
            best = {v: raw, t};
        }
    }

    return best?.v ?? null;
}

/**
 * Severity ladder per bump type. Patch bumps should change very
 * little (bugfix); minor bumps add features but rarely touch
 * everything; majors are expected to churn freely so we don't
 * threshold them.
 *
 * Numbers are deliberately tight — once we have telemetry from a few
 * real repos we'll know whether to widen them.
 */
function classify(bump: ChurnBumpType, added: number, modified: number): {
    severity: ChurnSeverity;
    reason: string;
} {
    const total = added + modified;

    if (bump === 'patch') {
        if (total > 30) {
            return {
                severity: ChurnSeverity.risk,
                reason: `${total} Dateien beim Patch-Bump (≥30 ist auffällig — Bugfix sollte klein sein)`
            };
        }
        if (total > 10) {
            return {
                severity: ChurnSeverity.warn,
                reason: `${total} Dateien beim Patch-Bump (>10 ungewöhnlich)`
            };
        }
    } else if (bump === 'minor') {
        if (total > 100) {
            return {
                severity: ChurnSeverity.risk,
                reason: `${total} Dateien beim Minor-Bump (≥100 ist auffällig)`
            };
        }
        if (total > 50) {
            return {
                severity: ChurnSeverity.warn,
                reason: `${total} Dateien beim Minor-Bump (>50 ungewöhnlich)`
            };
        }
    }

    return {
        severity: ChurnSeverity.info,
        reason: `Normale ${bump}-Bump-Größe`
    };
}

/**
 * Compares `pkg@version` against the previous stable release in the
 * registry. Returns `null` when:
 *  - the registry has no `versions` list (404, broken),
 *  - no previous stable version exists (first release, pre-releases only),
 *  - either fingerprint can't be built (404 tarball).
 *
 * On success returns one `ChurnFinding` summarising the diff size and
 * its severity given the bump type.
 */
export class ChurnScanner {

    private readonly _registry: Registry;
    private readonly _fingerprint: FingerprintBuilder;

    constructor(registry: Registry, fingerprint: FingerprintBuilder) {
        this._registry = registry;
        this._fingerprint = fingerprint;
    }

    public async scan(name: string, version: string): Promise<ChurnFinding|null> {
        // Git installs have no published predecessor in the registry,
        // so there's no meaningful "previous version" to diff against.
        if (isGitVersion(version)) {
            return null;
        }

        const tgt = parseSemver(version);
        if (!tgt) {
            return null;
        }

        const reg = await this._registry.fetchOne(name);
        if (!reg) {
            return null;
        }

        const previous = findPreviousVersion(reg.versions, version);
        if (!previous) {
            return null;
        }

        const prevTriple = parseSemver(previous);
        if (!prevTriple) {
            return null;
        }

        const bump = bumpType(prevTriple, tgt);
        if (!bump) {
            return null;
        }

        const [prevFp, currentFp] = await Promise.all([
            this._fingerprint.build(name, previous),
            this._fingerprint.build(name, version)
        ]);

        if (!prevFp || !currentFp) {
            return null;
        }

        const diff = diffFingerprints(prevFp, currentFp);
        const {severity, reason} = classify(bump, diff.added.length, diff.modified.length);

        return {
            previousVersion: previous,
            bumpType: bump,
            added: diff.added.length,
            removed: diff.removed.length,
            modified: diff.modified.length,
            severity,
            reason
        };
    }
}