import {describe, expect, it} from 'vitest';
import {PackageFingerprintManifest} from '../backend/Fingerprint/Fingerprint.js';
import {ManifestRedFlagSeverity, ManifestRedFlagsScanner} from '../backend/Security/ManifestRedFlagsScanner.js';

function m(over: Partial<PackageFingerprintManifest>): PackageFingerprintManifest {
    return {
        dependencies: {},
        devDependencies: {},
        peerDependencies: {},
        optionalDependencies: {},
        scripts: {},
        description: 'A normal package',
        files: ['lib/'],
        hasReadme: true,
        ...over
    };
}

describe('ManifestRedFlagsScanner.classify', () => {
    it('returns null for a clean manifest', () => {
        expect(ManifestRedFlagsScanner.classify(m({}))).toBeNull();
    });

    it('returns null when the manifest itself is null', () => {
        expect(ManifestRedFlagsScanner.classify(null)).toBeNull();
    });

    it('single flag fires as info (advisory)', () => {
        const f = ManifestRedFlagsScanner.classify(m({hasReadme: false}));
        expect(f).not.toBeNull();
        expect(f!.severity).toBe(ManifestRedFlagSeverity.info);
        expect(f!.flags).toEqual(['no-readme']);
    });

    it('two flags stack to warn', () => {
        const f = ManifestRedFlagsScanner.classify(m({
            hasReadme: false,
            description: undefined
        }));
        expect(f!.severity).toBe(ManifestRedFlagSeverity.warn);
        expect(f!.flags).toHaveLength(2);
    });

    it('three flags escalate to risk', () => {
        const f = ManifestRedFlagsScanner.classify(m({
            hasReadme: false,
            description: undefined,
            files: undefined
        }));
        expect(f!.severity).toBe(ManifestRedFlagSeverity.risk);
    });

    it('native + postinstall combo escalates to risk on its own', () => {
        const f = ManifestRedFlagsScanner.classify(m({
            scripts: {preinstall: 'node-gyp rebuild', postinstall: 'node ./hook.js'}
        }));
        expect(f!.severity).toBe(ManifestRedFlagSeverity.risk);
        expect(f!.flags).toContain('native-plus-postinstall');
    });

    it('flags many bin entries', () => {
        const f = ManifestRedFlagsScanner.classify(m({
            bin: {a: 'a.js', b: 'b.js', c: 'c.js', d: 'd.js', e: 'e.js'}
        }));
        expect(f).not.toBeNull();
        expect(f!.flags).toContain('many-bins');
    });

    it('flags dated engines.node range', () => {
        const f = ManifestRedFlagsScanner.classify(m({engines: {node: '<=10'}}));
        expect(f).not.toBeNull();
        expect(f!.flags).toContain('wide-engines');
    });

    it('does NOT flag modern engines.node', () => {
        expect(ManifestRedFlagsScanner.classify(m({engines: {node: '>=14'}}))).toBeNull();
    });
});