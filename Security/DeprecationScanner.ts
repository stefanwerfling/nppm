import {RegistryPackage} from '../Registry/Registry.js';

/**
 * Three-level deprecation severity, ranked low → high:
 *
 *  - `info` — neither the installed version nor `latest` is deprecated,
 *    but some *other* (older) version in the package's history is.
 *    Surfaces as a quiet hint in the panel; not interesting enough for
 *    a matrix badge.
 *  - `warn` — the registry's `latest` is deprecated. The user can stay
 *    on the installed version, but every fresh install (CI, new clone,
 *    `npm update`) will pick up the deprecated build.
 *  - `risk` — the *installed* `pkg@version` itself is deprecated.
 *    This is the textbook foot-gun: the maintainer asked everyone to
 *    move off this exact release.
 */
export enum DeprecationLevel {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type DeprecationFinding = {
    /** Whole package marker. */
    level: DeprecationLevel;
    /**
     * Maintainer's reason string when the *installed* version is
     * deprecated; null otherwise. Surfaced verbatim in the panel.
     */
    installedReason: string|null;
    /** Same for `latest`. */
    latestReason: string|null;
    /** `null` when the registry didn't disclose dist-tags.latest. */
    latestVersion: string|null;
    /**
     * Number of other (older) versions carrying a deprecation marker.
     * Excludes the installed version + latest from the count.
     */
    otherDeprecatedCount: number;
};

export type DeprecationSummary = {
    name: string;
    version: string;
    level: DeprecationLevel|null;
};

/**
 * Pure static classifier — reads the per-version `deprecated` map the
 * registry returns and decides whether the user has a problem. No I/O;
 * the caller (`SecurityScanner`) already has the packument cached.
 *
 * `classify` returns `null` only when nothing across the whole package
 * carries a deprecation marker. A non-null finding always renders
 * something in the UI, even if it's just the info-grade "an older
 * version was deprecated" hint.
 */
export class DeprecationScanner {

    public static classify(
        version: string,
        pkg: RegistryPackage|null
    ): DeprecationFinding|null {
        if (!pkg) {
            return null;
        }
        const map = pkg.deprecations;
        if (!map || Object.keys(map).length === 0) {
            return null;
        }

        const installedReason = map[version] ?? null;
        const latest = pkg.latest ?? null;
        const latestReason = latest && latest !== version ? (map[latest] ?? null) : null;

        let otherCount = 0;
        for (const v of Object.keys(map)) {
            if (v === version) {
                continue;
            }
            if (latest && v === latest) {
                continue;
            }
            otherCount++;
        }

        let level: DeprecationLevel;
        if (installedReason !== null) {
            level = DeprecationLevel.risk;
        } else if (latestReason !== null) {
            level = DeprecationLevel.warn;
        } else if (otherCount > 0) {
            level = DeprecationLevel.info;
        } else {
            return null;
        }

        return {
            level,
            installedReason,
            latestReason: latest === version ? installedReason : latestReason,
            latestVersion: latest,
            otherDeprecatedCount: otherCount
        };
    }
}