import {PackageFingerprintManifest} from '../Fingerprint/Fingerprint.js';

/**
 * Three-level severity rolling up the individual red-flag signals
 * fired by the scanner. The scanner is a soft signal — one flag is
 * an info-grade hint, two stack to warn, three or the strong "native
 * build + postinstall" combo escalate to risk.
 */
export enum ManifestRedFlagSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

/**
 * Named red flags. The set is deliberately small — every entry should
 * be a signal that occurs in real malicious-package post-mortems or
 * that meaningfully degrades supply-chain hygiene.
 *
 *  - `no-readme`: the tarball has no `README.*`. Throwaway typosquats
 *    routinely skip the README; legitimate packages rarely do.
 *  - `no-description`: `package.json.description` is empty or absent.
 *  - `no-files-field`: no `files: []` allowlist — `npm publish` ships
 *    everything not in `.npmignore`, including hidden files / build
 *    artifacts the author forgot about.
 *  - `many-bins`: more than `MAX_BIN_ENTRIES` `bin` mappings — heavy
 *    PATH footprint, increases the blast radius of a takeover.
 *  - `native-plus-postinstall`: an `install`/`postinstall` hook
 *    *and* a `preinstall`/`prebuild` hook — the textbook shape for
 *    "compile a native module on the user's machine that happens to
 *    fetch the network too".
 *  - `wide-engines`: the declared `engines.node` range is wildly out
 *    of date relative to current Node (e.g. `<=10`) — usually
 *    abandoned, sometimes a republished old version.
 */
export type ManifestRedFlag =
    | 'no-readme'
    | 'no-description'
    | 'no-files-field'
    | 'many-bins'
    | 'native-plus-postinstall'
    | 'wide-engines';

export type ManifestRedFlagsFinding = {
    severity: ManifestRedFlagSeverity;
    flags: ManifestRedFlag[];
    /** Short human-readable summary for the matrix tooltip + panel. */
    detail: string;
};

export type ManifestRedFlagsSummary = {
    name: string;
    version: string;
    severity: ManifestRedFlagSeverity|null;
    count: number;
};

const MAX_BIN_ENTRIES = 4;

/**
 * Hooks that suggest a native compile step. Triggering one of these
 * paired with an `install`/`postinstall` is the malicious-native-
 * module pattern the scanner specifically wants to catch.
 */
const NATIVE_HOOK_NAMES = new Set([
    'preinstall', 'prebuild', 'prebuild-install', 'install-prebuild',
    'gyp', 'rebuild'
]);

/**
 * Hooks that execute *after* the tarball is on disk. The pairing with
 * a native-prep hook is what makes the combination interesting (a
 * postinstall alone is already covered by `IgnoreScriptsScanner`).
 */
const POSTINSTALL_HOOK_NAMES = new Set([
    'install', 'postinstall'
]);

/**
 * Engines.node ranges that are unambiguously dated. The actual
 * cut-off here is intentionally permissive — packages claiming
 * `>=14` are still fine; only ranges that explicitly *exclude*
 * modern Node land in this set.
 */
function isDatedEnginesRange(range: string|undefined): boolean {
    if (!range) {
        return false;
    }
    /*
     * Ranges like `<=10`, `<10`, `<= 8`, `<8.0`, `<6` etc. exclude
     * anything modern outright. We don't try to parse the full
     * semver-range grammar — npm packages that genuinely require old
     * Node use simple expressions.
     */
    return /<(?:=\s*)?(?:[0-9]|10|11|12)\b/.test(range);
}

/**
 * Pure static classifier — examines a `PackageFingerprintManifest`
 * and decides which red flags fire. No I/O; the caller already has
 * the manifest from the fingerprint cache.
 *
 * Returns `null` only when no flag fires. The severity rollup
 * deliberately keeps the bar high: one flag = info (advisory), two
 * stacking = warn, three or the native+postinstall combo = risk.
 */
export class ManifestRedFlagsScanner {

    public static classify(
        manifest: PackageFingerprintManifest|null
    ): ManifestRedFlagsFinding|null {
        if (!manifest) {
            return null;
        }
        const flags: ManifestRedFlag[] = [];

        if (manifest.hasReadme === false) {
            flags.push('no-readme');
        }
        if (!manifest.description || manifest.description.trim().length === 0) {
            flags.push('no-description');
        }
        if (!manifest.files || manifest.files.length === 0) {
            flags.push('no-files-field');
        }
        if (manifest.bin && Object.keys(manifest.bin).length > MAX_BIN_ENTRIES) {
            flags.push('many-bins');
        }

        // Native + postinstall combo
        const scriptNames = new Set(Object.keys(manifest.scripts ?? {}));
        const hasNative = [...scriptNames].some((n) => NATIVE_HOOK_NAMES.has(n));
        const hasPostinstall = [...scriptNames].some((n) => POSTINSTALL_HOOK_NAMES.has(n));
        if (hasNative && hasPostinstall) {
            flags.push('native-plus-postinstall');
        }

        if (manifest.engines && isDatedEnginesRange(manifest.engines.node)) {
            flags.push('wide-engines');
        }

        if (flags.length === 0) {
            return null;
        }

        /*
         * Severity rollup. The native+postinstall combo always
         * escalates to risk on its own — it's the malicious-pattern
         * signal the scanner exists for.
         */
        let severity: ManifestRedFlagSeverity;
        if (flags.includes('native-plus-postinstall') || flags.length >= 3) {
            severity = ManifestRedFlagSeverity.risk;
        } else if (flags.length >= 2) {
            severity = ManifestRedFlagSeverity.warn;
        } else {
            severity = ManifestRedFlagSeverity.info;
        }

        return {
            severity: severity,
            flags: flags,
            detail: ManifestRedFlagsScanner._summarise(flags)
        };
    }

    public static summarise(
        name: string,
        version: string,
        finding: ManifestRedFlagsFinding|null
    ): ManifestRedFlagsSummary {
        return {
            name: name,
            version: version,
            severity: finding?.severity ?? null,
            count: finding?.flags.length ?? 0
        };
    }

    /**
     * Short comma-joined description used as the matrix tooltip and
     * the PackageDetailPanel detail line. Public for tests.
     */
    private static _summarise(flags: ManifestRedFlag[]): string {
        const labels: Record<ManifestRedFlag, string> = {
            'no-readme': 'no README',
            'no-description': 'no description',
            'no-files-field': 'no files[] allowlist',
            'many-bins': 'many bin entries',
            'native-plus-postinstall': 'native build + postinstall',
            'wide-engines': 'engines.node excludes modern Node'
        };
        return flags.map((f) => labels[f]).join(', ');
    }

}