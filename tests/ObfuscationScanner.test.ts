import {describe, expect, it} from 'vitest';
import {FileFingerprint} from '../Fingerprint/Fingerprint.js';
import {ObfuscationScanner, ObfuscationSeverity} from '../Security/ObfuscationScanner.js';

function f(path: string, content: string): FileFingerprint {
    return {path, sha256: 'x', size: content.length, content};
}

describe('ObfuscationScanner.isBuildArtifact', () => {
    it('flags conventional bundle paths', () => {
        expect(ObfuscationScanner.isBuildArtifact('pkg/dist/index.js')).toBe(true);
        expect(ObfuscationScanner.isBuildArtifact('pkg/build/main.js')).toBe(true);
        expect(ObfuscationScanner.isBuildArtifact('pkg/umd/lib.js')).toBe(true);
    });

    it('flags conventional minified-file suffixes', () => {
        expect(ObfuscationScanner.isBuildArtifact('pkg/jquery.min.js')).toBe(true);
        expect(ObfuscationScanner.isBuildArtifact('pkg/app.bundle.js')).toBe(true);
    });

    it('returns false for plain source paths', () => {
        expect(ObfuscationScanner.isBuildArtifact('pkg/src/index.js')).toBe(false);
        expect(ObfuscationScanner.isBuildArtifact('pkg/index.js')).toBe(false);
    });
});

describe('ObfuscationScanner.scan', () => {
    it('returns no findings for clean source', () => {
        const findings = ObfuscationScanner.scan([
            f('pkg/index.js', 'export function greet(name) { return "hello " + name; }')
        ]);
        expect(findings).toEqual([]);
    });

    it('flags eval(atob(...)) in a source path as risk', () => {
        const findings = ObfuscationScanner.scan([
            f('pkg/index.js', 'const payload = "aGVsbG8="; eval(atob(payload));')
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe(ObfuscationSeverity.risk);
        expect(findings[0].signals).toContain('eval-decoded');
    });

    it('flags new Function(atob(...)) as risk', () => {
        const findings = ObfuscationScanner.scan([
            f('pkg/payload.js', 'new Function(atob("Y29uc29sZS5sb2coMSk="))();')
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe(ObfuscationSeverity.risk);
    });

    it('caps a heavily _0x-laden source file at risk when dense', () => {
        // Pack many _0x identifiers into a small file so density > 5/kB.
        const idents = Array.from({length: 30}, (_, i) => `_0x${(i + 0x1000).toString(16)}`);
        const code = idents.map((id) => `var ${id} = 1;`).join('\n');
        const findings = ObfuscationScanner.scan([f('pkg/main.js', code)]);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe(ObfuscationSeverity.risk);
        expect(findings[0].signals).toContain('obfuscator-io-identifier');
    });

    it('downgrades obfuscation findings in build-artifact paths to info', () => {
        // Same heavy _0x file but under dist/ — legitimate minification.
        const idents = Array.from({length: 30}, (_, i) => `_0x${(i + 0x1000).toString(16)}`);
        const code = idents.map((id) => `var ${id} = 1;`).join('\n');
        const findings = ObfuscationScanner.scan([f('pkg/dist/index.min.js', code)]);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe(ObfuscationSeverity.info);
        expect(findings[0].isBuildArtifact).toBe(true);
    });

    it('flags a hex-string array as warn in source', () => {
        const arr = Array.from({length: 10}, () => '"\\x48"').join(', ');
        const code = `var data = [${arr}];`;
        const findings = ObfuscationScanner.scan([f('pkg/index.js', code)]);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe(ObfuscationSeverity.warn);
        expect(findings[0].signals).toContain('hex-string-array');
    });

    it('flags long-line obfuscation in a source path as warn', () => {
        const longLine = 'var x = ' + '"a"+'.repeat(2000) + '"end";';
        const findings = ObfuscationScanner.scan([f('pkg/src/main.js', longLine)]);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe(ObfuscationSeverity.warn);
        expect(findings[0].signals).toContain('long-line');
    });

    it('does NOT fire long-line in build paths', () => {
        const longLine = 'var x = ' + '"a"+'.repeat(2000) + '"end";';
        const findings = ObfuscationScanner.scan([f('pkg/dist/bundle.js', longLine)]);
        // Long lines in dist/ are normal minification — no finding from that signal.
        expect(findings).toEqual([]);
    });

    it('skips files without content', () => {
        expect(ObfuscationScanner.scan([
            {path: 'pkg/native.so', sha256: 'x', size: 100}
        ])).toEqual([]);
    });
});

describe('ObfuscationScanner.summarise', () => {
    it('returns null severity for empty findings', () => {
        const s = ObfuscationScanner.summarise('x', '1.0.0', []);
        expect(s).toEqual({name: 'x', version: '1.0.0', maxSeverity: null, count: 0});
    });

    it('picks the worst severity across files', () => {
        const findings = ObfuscationScanner.scan([
            f('pkg/dist/min.js',
                Array.from({length: 30}, (_, i) => `var _0x${(i + 0x1000).toString(16)}=1;`).join('\n')),
            f('pkg/payload.js', 'eval(atob("aGk="));')
        ]);
        const s = ObfuscationScanner.summarise('x', '1.0.0', findings);
        expect(s.maxSeverity).toBe(ObfuscationSeverity.risk);
        expect(s.count).toBe(2);
    });
});