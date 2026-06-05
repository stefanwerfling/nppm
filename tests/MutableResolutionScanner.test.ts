import {describe, expect, it} from 'vitest';
import {Lockfile, LockedPackage} from '../backend/Project/Lockfile.js';
import {MutableResolutionScanner, MutableResolutionSeverity} from '../backend/Security/MutableResolutionScanner.js';

function pkg(over: Partial<LockedPackage>): LockedPackage {
    return {
        name: 'p', version: '1.0.0', path: 'node_modules/p',
        dev: false, optional: false, peer: false,
        deps: {}, peerDeps: {}, optionalDeps: {},
        ...over
    };
}

function lock(packages: LockedPackage[], source: Lockfile['source'] = 'committed'): Lockfile {
    return {lockfileVersion: 3, source: source, packages: packages};
}

describe('MutableResolutionScanner.scan', () => {
    it('reports supported:false on a missing lockfile', () => {
        const r = MutableResolutionScanner.scan(null);
        expect(r.supported).toBe(false);
        expect(r.findings).toEqual([]);
    });

    it('reports supported:false on a synthesized lockfile', () => {
        const r = MutableResolutionScanner.scan(lock([pkg({})], 'synthesized'));
        expect(r.supported).toBe(false);
        expect(r.unsupportedReason).toContain('synthesized');
    });

    it('flags missing-integrity on a registry tarball as warn', () => {
        const r = MutableResolutionScanner.scan(lock([
            pkg({resolved: 'https://registry.npmjs.org/p/-/p-1.0.0.tgz'})
        ]));
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].severity).toBe(MutableResolutionSeverity.warn);
        expect(r.findings[0].kind).toBe('missing-integrity');
    });

    it('does NOT flag a registry tarball that has integrity', () => {
        const r = MutableResolutionScanner.scan(lock([
            pkg({resolved: 'https://registry.npmjs.org/p/-/p-1.0.0.tgz', integrity: 'sha512-abc'})
        ]));
        expect(r.findings).toEqual([]);
    });

    it('flags git+https with a branch ref as risk', () => {
        const r = MutableResolutionScanner.scan(lock([
            pkg({resolved: 'git+https://github.com/owner/repo.git#main'})
        ]));
        expect(r.findings[0].severity).toBe(MutableResolutionSeverity.risk);
        expect(r.findings[0].kind).toBe('git-branch-ref');
    });

    it('does NOT flag git+https with a SHA pin', () => {
        const r = MutableResolutionScanner.scan(lock([
            pkg({resolved: 'git+https://github.com/owner/repo.git#a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80910'})
        ]));
        expect(r.findings).toEqual([]);
    });

    it('flags git+https without a ref (HEAD pin) as risk', () => {
        const r = MutableResolutionScanner.scan(lock([
            pkg({resolved: 'git+https://github.com/owner/repo.git'})
        ]));
        expect(r.findings[0].severity).toBe(MutableResolutionSeverity.risk);
    });

    it('flags link: as info (intentional, but non-reproducible)', () => {
        const r = MutableResolutionScanner.scan(lock([
            pkg({resolved: 'link:../local-pkg'})
        ]));
        expect(r.findings[0].severity).toBe(MutableResolutionSeverity.info);
        expect(r.findings[0].kind).toBe('link-protocol');
    });

    it('rolls maxSeverity up to the worst entry', () => {
        const r = MutableResolutionScanner.scan(lock([
            pkg({name: 'a', resolved: 'link:../a'}),                                  // info
            pkg({name: 'b', resolved: 'https://r/p.tgz'}),                            // warn
            pkg({name: 'c', resolved: 'git+https://github.com/x/y.git#branch'})       // risk
        ]));
        expect(r.maxSeverity).toBe(MutableResolutionSeverity.risk);
        expect(r.findings).toHaveLength(3);
    });
});