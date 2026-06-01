import {ScriptFinding, ScriptSeverity} from './ScriptScanner.js';

/**
 * Recommendation given for `npm install --ignore-scripts` on this
 * specific package. Four discrete outcomes the UI surfaces as a
 * single banner.
 *
 *  - `unaffected`: the package declares no install-time hooks at all.
 *    `--ignore-scripts` has nothing to skip; safe by default.
 *  - `safeToIgnore`: hooks exist but their bodies don't compile
 *    native code or do anything else that the post-install state
 *    structurally relies on. The user can safely run their installs
 *    with `--ignore-scripts` and this package will still work.
 *  - `needsScripts`: at least one hook calls a native-build toolchain
 *    (node-gyp, prebuild-install, cmake, …). Skipping it would leave
 *    the package broken — typically a missing `.node` binary at
 *    runtime.
 *  - `avoidScripts`: at least one hook matches a high-risk pattern
 *    (network download, eval, shell pipe). The recommendation flips
 *    to "definitely use `--ignore-scripts`" — even if it breaks
 *    something, the risk of running the hook is worse.
 *
 * The four states are deliberately separate (rather than a single
 * info/warn/risk triple) because the recommended *action* differs
 * per state — not just the colour.
 */
export enum IgnoreScriptsLevel {
    unaffected = 'unaffected',
    safeToIgnore = 'safe-to-ignore',
    needsScripts = 'needs-scripts',
    avoidScripts = 'avoid-scripts'
}

export type IgnoreScriptsFinding = {
    level: IgnoreScriptsLevel;
    /** Number of install-time hooks the package declares. */
    hookCount: number;
    /** Subset of `hookCount` flagged as `risk` by `ScriptScanner`. */
    riskCount: number;
    /** Human-readable explanation. */
    reason: string;
};

/**
 * Patterns that indicate a hook compiles native code at install
 * time. When any of these match, skipping the scripts would leave
 * the package broken at runtime (typically a missing `.node`
 * binary), so the recommendation flips to `needsScripts`. Kept
 * narrow on purpose — over-broad matchers (e.g. just `\bbuild\b`)
 * would label nearly every package as `needsScripts` and erase the
 * advice's value.
 */
const NATIVE_BUILD_PATTERNS: RegExp[] = [
    /\bnode-gyp\b/i,
    /\bnode-pre-gyp\b/i,
    /\bprebuild-install\b/i,
    /\bprebuildify\b/i,
    /\bcmake-js\b/i,
    /\bnan\b/i,
    /\b(gyp|cmake|make|nmake)\s+/i,
    /\b(gcc|clang|cl\.exe)\b/i,
    /\.\/configure\b/
];

/**
 * Wraps `ScriptScanner`'s per-hook findings into a single
 * actionable "should I run with `--ignore-scripts`?" verdict.
 * Static by design: pure derivation from already-computed data.
 */
export class IgnoreScriptsScanner {

    public static classify(scripts: ScriptFinding[]): IgnoreScriptsFinding {
        if (scripts.length === 0) {
            return {
                level: IgnoreScriptsLevel.unaffected,
                hookCount: 0,
                riskCount: 0,
                reason: 'No install-time hooks declared — --ignore-scripts has nothing to skip here'
            };
        }

        const riskCount = scripts.filter((s) => s.severity === ScriptSeverity.risk).length;
        if (riskCount > 0) {
            return {
                level: IgnoreScriptsLevel.avoidScripts,
                hookCount: scripts.length,
                riskCount,
                reason: `${riskCount} risky hook(s) — definitely run with --ignore-scripts, even if something breaks`
            };
        }

        const native = scripts.find((s) =>
            NATIVE_BUILD_PATTERNS.some((p) => p.test(s.script))
        );
        if (native) {
            return {
                level: IgnoreScriptsLevel.needsScripts,
                hookCount: scripts.length,
                riskCount: 0,
                reason: `${native.hook} hook compiles native code — --ignore-scripts would leave the install broken at runtime`
            };
        }

        return {
            level: IgnoreScriptsLevel.safeToIgnore,
            hookCount: scripts.length,
            riskCount: 0,
            reason: `${scripts.length} install-time hook(s), no native-build or risky bodies — safe to skip with --ignore-scripts`
        };
    }
}
