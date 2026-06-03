import {describe, expect, it} from 'vitest';
import {RegistryPackage} from '../Registry/Registry.js';
import {DeprecationLevel, DeprecationScanner} from '../Security/DeprecationScanner.js';

function makePkg(over: Partial<RegistryPackage>): RegistryPackage {
    return {
        name: 'x',
        latest: '2.0.0',
        versions: ['1.0.0', '1.5.0', '2.0.0'],
        ...over
    };
}

describe('DeprecationScanner.classify', () => {
    it('returns null when no version is deprecated', () => {
        expect(DeprecationScanner.classify('2.0.0', makePkg({}))).toBeNull();
    });

    it('returns null when the packument is missing', () => {
        expect(DeprecationScanner.classify('2.0.0', null)).toBeNull();
    });

    it('reports risk + the maintainer reason when the installed version is deprecated', () => {
        const r = DeprecationScanner.classify('1.5.0', makePkg({
            deprecations: {'1.5.0': 'use 2.x'}
        }));
        expect(r).not.toBeNull();
        expect(r!.level).toBe(DeprecationLevel.risk);
        expect(r!.installedReason).toBe('use 2.x');
        expect(r!.otherDeprecatedCount).toBe(0);
    });

    it('reports warn when only latest is deprecated', () => {
        const r = DeprecationScanner.classify('1.0.0', makePkg({
            deprecations: {'2.0.0': 'rolled back, use 1.x'}
        }));
        expect(r).not.toBeNull();
        expect(r!.level).toBe(DeprecationLevel.warn);
        expect(r!.latestReason).toBe('rolled back, use 1.x');
        expect(r!.installedReason).toBeNull();
    });

    it('reports info when only an older version was deprecated', () => {
        const r = DeprecationScanner.classify('2.0.0', makePkg({
            deprecations: {'1.0.0': 'security patch — use 1.5.0+'}
        }));
        expect(r).not.toBeNull();
        expect(r!.level).toBe(DeprecationLevel.info);
        expect(r!.otherDeprecatedCount).toBe(1);
    });

    it('handles the case where the installed version IS latest and is deprecated', () => {
        const r = DeprecationScanner.classify('2.0.0', makePkg({
            deprecations: {'2.0.0': 'critical bug, use 2.0.1'}
        }));
        expect(r).not.toBeNull();
        expect(r!.level).toBe(DeprecationLevel.risk);
        // installed===latest: latestReason mirrors installedReason for the panel
        expect(r!.latestReason).toBe('critical bug, use 2.0.1');
    });

    it('counts other deprecated versions excluding installed + latest', () => {
        const r = DeprecationScanner.classify('1.5.0', makePkg({
            versions: ['1.0.0', '1.5.0', '1.8.0', '2.0.0'],
            deprecations: {
                '1.0.0': 'old',
                '1.5.0': 'installed reason',
                '1.8.0': 'other'
                // 2.0.0 (latest) not deprecated
            }
        }));
        expect(r).not.toBeNull();
        expect(r!.level).toBe(DeprecationLevel.risk);
        expect(r!.otherDeprecatedCount).toBe(2); // 1.0.0 + 1.8.0
    });
});