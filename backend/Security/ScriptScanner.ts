import {PackageFingerprintManifest} from '../Fingerprint/Fingerprint.js';

/**
 * Outcome of a script-heuristic match. Severity is a fixed 3-level
 * ladder; consumers (UI badges, scoring) can map it to colours.
 *
 *  - info:  hook exists but nothing suspicious in the body
 *  - warn:  install-time hook (preinstall/install/postinstall) — any
 *           install-time code is worth flagging by default
 *  - risk:  hook body matches a network / dynamic-exec pattern
 */
export enum ScriptSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type ScriptFinding = {
    hook: string;
    severity: ScriptSeverity;
    script: string;
    reason: string;
};

/**
 * Hooks npm/yarn/pnpm fire during `install`. We do *not* flag the
 * publish-time hooks (`prepublishOnly`, `publish`) — they don't run on
 * a consumer's machine.
 *
 * The set is split into "install-time" (default-warn) and "build-time"
 * (default-info): a `prepare` script runs on `npm install` too in the
 * git-dependency case, but for a normally-installed package it's
 * developer-only.
 */
const INSTALL_HOOKS = new Set(['preinstall', 'install', 'postinstall']);
const BUILD_HOOKS = new Set(['prepare', 'prepublish']);

/**
 * Patterns that escalate a finding from `warn` to `risk`. Each entry is
 * a (regex, human reason) pair. Kept terse on purpose — over-broad
 * patterns yield false positives that train the user to ignore the
 * badge.
 */
const RISK_PATTERNS: {pattern: RegExp; reason: string;}[] = [
    {pattern: /\b(curl|wget)\b/i, reason: 'downloads remote payload via curl/wget'},
    {pattern: /\bnc\s+-/, reason: 'opens network connection via netcat'},
    {pattern: /\bnode\s+(-e|--eval)\b/, reason: 'runs code via `node -e`'},
    {pattern: /\beval\s*\(/, reason: 'calls eval()'},
    {pattern: /\b(base64\s+(-d|--decode)|atob\s*\()/i, reason: 'decodes base64 at runtime'},
    {pattern: /\b(bash|sh)\s+-c\b/, reason: 'pipes string into shell'},
    {pattern: /\|\s*(bash|sh)\b/, reason: 'pipes output into shell'},
    {pattern: /\bnpm\s+i(nstall)?\b/, reason: 'installs additional packages at install time'}
];

/**
 * Stateless scanner — every call is independent, so the public
 * surface is a static method. Kept as a class for symmetry with the
 * other scanners (`PatternScanner`, `BinaryScanner`, …) and so the
 * regex/severity tables can be private statics later if needed.
 */
export class ScriptScanner {

    /**
     * Walk the manifest's lifecycle hooks and emit a finding per hook
     * present. Returns an empty list when no lifecycle hooks are
     * declared (the common, boring case).
     */
    public static scan(manifest: PackageFingerprintManifest|null): ScriptFinding[] {
        if (!manifest || !manifest.scripts) {
            return [];
        }

        const findings: ScriptFinding[] = [];

        for (const [hook, script] of Object.entries(manifest.scripts)) {
            const isInstall = INSTALL_HOOKS.has(hook);
            const isBuild = BUILD_HOOKS.has(hook);

            if (!isInstall && !isBuild) {
                continue;
            }

            const risk = RISK_PATTERNS.find((r) => r.pattern.test(script));
            const severity = risk
                ? ScriptSeverity.risk
                : isInstall
                    ? ScriptSeverity.warn
                    : ScriptSeverity.info;

            findings.push({
                hook: hook,
                severity: severity,
                script: script,
                reason: risk
                    ? risk.reason
                    : isInstall
                        ? 'Install hook runs code during `npm install`'
                        : 'Build hook (runs on `npm install` for git dependencies)'
            });
        }

        return findings;
    }

}