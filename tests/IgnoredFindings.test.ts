import {describe, expect, it} from 'vitest';
import {IgnoredFinding, IgnoredFindings} from '../backend/Security/IgnoredFindings.js';
import {LicenseSeverity} from '../backend/Security/LicenseScanner.js';
import {ScriptSeverity} from '../backend/Security/ScriptScanner.js';
import {BinarySeverity} from '../backend/Security/BinaryScanner.js';
import {PatternSeverity} from '../backend/Security/PatternScanner.js';
import {MaintainerSeverity} from '../backend/Security/MaintainerScanner.js';
import {ProvenanceLevel} from '../backend/Security/ProvenanceScanner.js';
import {CadenceLevel} from '../backend/Security/CadenceScanner.js';
import {FreshnessLevel} from '../backend/Security/FreshnessScanner.js';
import {TyposquatLevel} from '../backend/Security/TyposquatScanner.js';
import {ExternalSeverity} from '../backend/Security/ExternalSourcesScanner.js';
import {DeprecationLevel} from '../backend/Security/DeprecationScanner.js';
import {ObfuscationSeverity} from '../backend/Security/ObfuscationScanner.js';
import {ManifestRedFlagSeverity} from '../backend/Security/ManifestRedFlagsScanner.js';
import {CapabilitySeverity} from '../backend/Security/CapabilityScanner.js';
import {HeuristicsBatchEntry} from '../backend/Security/SecurityScanner.js';

const NOW = Date.now();

const baseEntry: HeuristicsBatchEntry = {
    name: 'lodash',
    version: '4.17.21',
    scripts: {name: 'lodash', version: '4.17.21', maxSeverity: ScriptSeverity.risk, count: 2},
    patterns: {name: 'lodash', version: '4.17.21', maxSeverity: PatternSeverity.warn, count: 1},
    binaries: {name: 'lodash', version: '4.17.21', maxSeverity: BinarySeverity.risk, riskCount: 1, totalCount: 3},
    maintainer: {name: 'lodash', version: '4.17.21', severity: MaintainerSeverity.risk, publisher: 'evil'},
    license: {name: 'lodash', version: '4.17.21', spdx: 'GPL-3.0', severity: LicenseSeverity.strongCopyleft},
    provenance: {name: 'lodash', version: '4.17.21', level: ProvenanceLevel.unsigned},
    freshness: {name: 'lodash', version: '4.17.21', level: FreshnessLevel.risk, packageAgeDays: 3, maintainerAgeDays: 2},
    cadence: {name: 'lodash', version: '4.17.21', level: CadenceLevel.risk, daysSinceLastRelease: 900, medianCadenceDays: 30},
    typosquat: {name: 'lodash', version: '4.17.21', level: TyposquatLevel.risk, closestMatch: 'lodash', hasConfusables: true},
    external: {name: 'lodash', version: '4.17.21', level: ExternalSeverity.risk, count: 2},
    deprecation: {name: 'lodash', version: '4.17.21', level: DeprecationLevel.risk},
    obfuscation: {name: 'lodash', version: '4.17.21', maxSeverity: ObfuscationSeverity.risk, count: 4},
    manifestRedFlags: {name: 'lodash', version: '4.17.21', severity: ManifestRedFlagSeverity.warn, count: 2},
    capability: {name: 'lodash', version: '4.17.21', severity: CapabilitySeverity.warn, count: 3}
};

const entry = (kind: string, identifier?: string, version = '4.17.21'): IgnoredFinding => ({
    name: 'lodash',
    version: version,
    kind: kind as IgnoredFinding['kind'],
    identifier: identifier,
    addedAt: NOW
});

describe('IgnoredFindings.matches', () => {
    it('matches name + version + kind without identifier', () => {
        const i = new IgnoredFindings([entry('script')]);
        expect(i.matches('lodash', '4.17.21', 'script')).toBe(true);
        expect(i.matches('lodash', '4.17.20', 'script')).toBe(false);
        expect(i.matches('lodash', '4.17.21', 'pattern')).toBe(false);
    });

    it('matches an OSV vuln id when both have an identifier', () => {
        const i = new IgnoredFindings([entry('cve', 'CVE-2024-1234')]);
        expect(i.matches('lodash', '4.17.21', 'cve', 'CVE-2024-1234')).toBe(true);
        expect(i.matches('lodash', '4.17.21', 'cve', 'CVE-9999-9999')).toBe(false);
    });

    it('matches every identifier when the entry has none (kind-level ignore)', () => {
        const i = new IgnoredFindings([entry('cve')]);
        expect(i.matches('lodash', '4.17.21', 'cve', 'CVE-2024-1234')).toBe(true);
        expect(i.matches('lodash', '4.17.21', 'cve')).toBe(true);
    });

    it('treats version="*" as a wildcard across versions', () => {
        const i = new IgnoredFindings([entry('script', undefined, '*')]);
        expect(i.matches('lodash', '4.17.21', 'script')).toBe(true);
        expect(i.matches('lodash', '5.0.0', 'script')).toBe(true);
    });
});

describe('IgnoredFindings.applyToBatchEntry', () => {
    it('zeroes the script summary when that kind is ignored', () => {
        const i = new IgnoredFindings([entry('script')]);
        const out = i.applyToBatchEntry(baseEntry);
        expect(out.scripts.maxSeverity).toBeNull();
        expect(out.scripts.count).toBe(0);
        // unrelated kinds stay intact
        expect(out.patterns.maxSeverity).toBe(PatternSeverity.warn);
    });

    it('collapses license severity to permissive (since the type is non-nullable)', () => {
        const i = new IgnoredFindings([entry('license')]);
        const out = i.applyToBatchEntry(baseEntry);
        expect(out.license.severity).toBe(LicenseSeverity.permissive);
    });

    it('nulls every other scanner severity individually', () => {
        const kinds = ['pattern', 'binary', 'maintainer', 'provenance', 'freshness',
            'cadence', 'typosquat', 'external', 'deprecation', 'obfuscation',
            'manifest-red-flag', 'capability'];
        for (const k of kinds) {
            const i = new IgnoredFindings([entry(k)]);
            const out = i.applyToBatchEntry(baseEntry);
            switch (k) {
                case 'pattern': expect(out.patterns.maxSeverity).toBeNull(); break;
                case 'binary': expect(out.binaries.maxSeverity).toBeNull(); break;
                case 'maintainer': expect(out.maintainer.severity).toBeNull(); break;
                case 'provenance': expect(out.provenance.level).toBeNull(); break;
                case 'freshness': expect(out.freshness.level).toBeNull(); break;
                case 'cadence': expect(out.cadence.level).toBeNull(); break;
                case 'typosquat': expect(out.typosquat.level).toBeNull(); break;
                case 'external': expect(out.external.level).toBeNull(); break;
                case 'deprecation': expect(out.deprecation.level).toBeNull(); break;
                case 'obfuscation': expect(out.obfuscation.maxSeverity).toBeNull(); break;
                case 'manifest-red-flag': expect(out.manifestRedFlags.severity).toBeNull(); break;
                case 'capability': expect(out.capability.severity).toBeNull(); break;

            }
        }
    });

    it('leaves the entry untouched when no ignore matches', () => {
        const i = new IgnoredFindings([entry('script', undefined, '5.0.0')]);
        const out = i.applyToBatchEntry(baseEntry);
        expect(out.scripts.maxSeverity).toBe(ScriptSeverity.risk);
        expect(out.license.severity).toBe(LicenseSeverity.strongCopyleft);
    });
});

describe('IgnoredFindings.forPackage', () => {
    it('returns the entries that target a specific name+version', () => {
        const i = new IgnoredFindings([
            entry('cve', 'CVE-2024-1234'),
            entry('script'),
            entry('cve', 'CVE-2099-9999', '5.0.0'),
            {...entry('license'), name: 'react'}
        ]);
        const found = i.forPackage('lodash', '4.17.21');
        expect(found.map((e) => `${e.kind}:${e.identifier ?? ''}`).sort()).toEqual([
            'cve:CVE-2024-1234',
            'script:'
        ]);
    });
});