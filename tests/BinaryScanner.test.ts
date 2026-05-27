import {describe, expect, it} from 'vitest';
import {FileFingerprint} from '../Fingerprint/Fingerprint.js';
import {BinarySeverity, scanBinaries, summariseBinaries} from '../Security/BinaryScanner.js';

function f(path: string, size = 1): FileFingerprint {
    return {path, sha256: 'x', size};
}

describe('scanBinaries', () => {
    it('flags Windows-, Linux- and macOS-native code as risk', () => {
        const findings = scanBinaries([
            f('bin/foo.exe'),
            f('lib/win/foo.dll'),
            f('lib/linux/foo.so'),
            f('lib/mac/foo.dylib'),
            f('build/foo.o'),
            f('build/libfoo.a')
        ]);
        expect(findings.every((x) => x.severity === BinarySeverity.risk)).toBe(true);
        expect(findings).toHaveLength(6);
    });

    it('flags .node bindings as warn', () => {
        const findings = scanBinaries([f('build/Release/bcrypt_lib.node')]);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe(BinarySeverity.warn);
        expect(findings[0].kind).toMatch(/Native/);
    });

    it('flags .wasm as info', () => {
        const findings = scanBinaries([f('dist/parser.wasm')]);
        expect(findings[0].severity).toBe(BinarySeverity.info);
    });

    it('ignores ordinary JS / TS / config files', () => {
        const findings = scanBinaries([
            f('index.js'),
            f('types.d.ts'),
            f('package.json'),
            f('logo.png'),
            f('font.woff2'),
            f('README.md')
        ]);
        expect(findings).toEqual([]);
    });

    it('sorts findings by severity, then path', () => {
        const findings = scanBinaries([
            f('lib/x.wasm'),
            f('bin/a.exe'),
            f('build/y.node'),
            f('bin/b.dll')
        ]);
        expect(findings.map((x) => x.path)).toEqual([
            'bin/a.exe',
            'bin/b.dll',
            'build/y.node',
            'lib/x.wasm'
        ]);
    });

    it('summariseBinaries picks worst severity + counts risk', () => {
        const out = summariseBinaries(scanBinaries([
            f('bin/a.exe'),
            f('bin/b.dll'),
            f('build/y.node'),
            f('lib/x.wasm')
        ]));
        expect(out.maxSeverity).toBe(BinarySeverity.risk);
        expect(out.riskCount).toBe(2);
        expect(out.totalCount).toBe(4);
    });

    it('summariseBinaries returns null severity when empty', () => {
        const out = summariseBinaries([]);
        expect(out.maxSeverity).toBeNull();
        expect(out.totalCount).toBe(0);
    });

    it('flags extension-less large files under bin/ as risk', () => {
        const findings = scanBinaries([
            // 9.7 MB ELF, no extension — what @esbuild/linux-x64 ships
            f('bin/esbuild', 9_707_520),
            // shell-wrapper shim, too small to be a real binary
            f('bin/foo-cli', 1_500)
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0].path).toBe('bin/esbuild');
        expect(findings[0].severity).toBe(BinarySeverity.risk);
    });

    it('does NOT flag a shell-script bin entry', () => {
        const findings = scanBinaries([f('bin/foo.sh', 50_000)]);
        expect(findings).toEqual([]);
    });
});