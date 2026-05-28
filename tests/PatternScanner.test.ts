import {describe, expect, it} from 'vitest';
import {FileFingerprint} from '../Fingerprint/Fingerprint.js';
import {PatternScanner, PatternSeverity} from '../Security/PatternScanner.js';

function file(path: string, content: string|undefined): FileFingerprint {
    const f: FileFingerprint = {path, sha256: 'x', size: content?.length ?? 0};
    if (content !== undefined) {
        f.content = content;
    }
    return f;
}

describe('PatternScanner.scan', () => {
    it('flags eval() and new Function() as risk', () => {
        const findings = PatternScanner.scan([
            file('lib/a.js', 'const x = eval("1+1");'),
            file('lib/b.js', 'const y = new Function("return 1");')
        ]);

        expect(findings).toHaveLength(2);
        expect(findings.every((f) => f.severity === PatternSeverity.risk)).toBe(true);
        expect(findings[0].path).toBe('lib/a.js');
        expect(findings[0].line).toBe(1);
    });

    it('flags child_process require and member access', () => {
        const findings = PatternScanner.scan([
            // Two separate styles in two files. The combined-on-one-line
            // form `require("child_process").exec()` only matches the
            // require regex (the string literal breaks the `.exec`
            // adjacency); we cover the member-access form via a bound
            // variable.
            file('lib/exec.js', 'const cp = require("child_process"); child_process.execSync("ls")'),
            file('lib/dec.js', 'Buffer.from(input, "base64").toString()')
        ]);

        expect(findings.map((f) => f.pattern).sort()).toEqual([
            'Buffer.from(..., "base64")',
            'child_process.exec*',
            'require("child_process")'
        ]);
        expect(findings.every((f) => f.severity === PatternSeverity.warn)).toBe(true);
    });

    it('flags long base64 literal blobs', () => {
        const blob = 'A'.repeat(400);
        const findings = PatternScanner.scan([
            file('lib/blob.js', `const data = "${blob}";`)
        ]);

        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toMatch(/base64 literal/);
    });

    it('skips files without cached content', () => {
        const findings = PatternScanner.scan([
            file('lib/big.js', undefined),
            file('lib/clean.js', 'console.log("hi")')
        ]);

        expect(findings).toEqual([]);
    });

    it('reports the correct line number for matches on later lines', () => {
        const src = ['// header', '// comment', 'const x = eval(input);'].join('\n');
        const findings = PatternScanner.scan([file('lib/a.js', src)]);
        expect(findings[0].line).toBe(3);
    });

    it('emits one finding per match (multi-match files)', () => {
        const src = 'eval(a); eval(b); eval(c);';
        const findings = PatternScanner.scan([file('lib/m.js', src)]);
        expect(findings).toHaveLength(3);
    });
});