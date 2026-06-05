import {describe, expect, it} from 'vitest';
import {DashboardBuilder, SCANNER_IDS} from '../backend/Dashboard/DashboardBuilder.js';
import {BinarySeverity} from '../backend/Security/BinaryScanner.js';
import {CadenceLevel} from '../backend/Security/CadenceScanner.js';
import {ChurnSeverity} from '../backend/Security/ChurnScanner.js';
import {FreshnessLevel} from '../backend/Security/FreshnessScanner.js';
import {IgnoreScriptsLevel} from '../backend/Security/IgnoreScriptsScanner.js';
import {IntegrityFindingKind, IntegritySeverity} from '../backend/Security/IntegrityScanner.js';
import {LicenseSeverity} from '../backend/Security/LicenseScanner.js';
import {MaintainerSeverity} from '../backend/Security/MaintainerScanner.js';
import {ProvenanceLevel} from '../backend/Security/ProvenanceScanner.js';
import {ScriptSeverity} from '../backend/Security/ScriptScanner.js';
import {TyposquatLevel} from '../backend/Security/TyposquatScanner.js';
import {UnusedSeverity} from '../backend/Unused/UnusedReport.js';
import {ConfigProjectType} from '../backend/Config/Config.js';

describe('DashboardBuilder.scorePerPackage', () => {
    it('returns 100 when nothing is flagged', () => {
        const cell = DashboardBuilder.scorePerPackage([null, null, null], 10);
        expect(cell.score).toBe(100);
        expect(cell.counts).toEqual({info: 0, warn: 0, risk: 0});
        expect(cell.total).toBe(10);
        expect(cell.findings).toEqual([]);
    });

    it('attaches and sorts the supplied findings by severity desc', () => {
        const cell = DashboardBuilder.scorePerPackage(
            ['warn', 'risk', null, 'info'],
            10,
            [
                {label: 'a@1', severity: 'warn'},
                {label: 'b@1', severity: 'risk'},
                {label: 'c@1', severity: 'info'}
            ]
        );
        expect(cell.findings.map((f) => f.severity)).toEqual(['risk', 'warn', 'info']);
    });

    it('caps findings to CELL_FINDINGS_CAP', () => {
        const many = new Array(120).fill(0).map((_, i) => ({
            label: `pkg-${i}`, severity: 'risk' as const
        }));
        const cell = DashboardBuilder.scorePerPackage(['risk'], 1, many);
        expect(cell.findings.length).toBe(50);
    });

    it('drops below 100 proportionally to severity weight', () => {
        // 1 risk among 10 packages → 100 × (1 − 30/300) = 90
        const cell = DashboardBuilder.scorePerPackage(['risk', null, null, null, null, null, null, null, null, null], 10);
        expect(cell.score).toBe(90);
        expect(cell.counts.risk).toBe(1);
    });

    it('floors at 0 for an overwhelmed project', () => {
        const sevs = new Array(10).fill('risk') as ('risk')[];
        const cell = DashboardBuilder.scorePerPackage(sevs, 10);
        expect(cell.score).toBe(0);
        expect(cell.counts.risk).toBe(10);
    });

    it('uses the wider denominator when fewer entries are provided', () => {
        /*
         * Caller passes only the non-null entries plus a packageCount of 50
         * → 1 warn / (50 × 30) → 100 × (1 − 10/1500) ≈ 99.33 → 99
         */
        const cell = DashboardBuilder.scorePerPackage(['warn'], 50);
        expect(cell.score).toBe(99);
        expect(cell.total).toBe(50);
    });

    it('safely handles a zero-package denominator', () => {
        const cell = DashboardBuilder.scorePerPackage([], 0);
        expect(cell.score).toBe(100);
        expect(cell.total).toBe(0);
    });
});

describe('DashboardBuilder.scorePerProject', () => {
    it('counts each finding individually against the package denominator', () => {
        /*
         * 2 info + 1 warn in a 5-package project → (1+1+10)/(5×30) = 12/150
         * → 100 × (1 − 0.08) = 92
         */
        const cell = DashboardBuilder.scorePerProject(['info', 'info', 'warn'], 5);
        expect(cell.score).toBe(92);
        expect(cell.counts).toEqual({info: 2, warn: 1, risk: 0});
    });

    it('returns 100 with no findings', () => {
        const cell = DashboardBuilder.scorePerProject([], 50);
        expect(cell.score).toBe(100);
    });
});

describe('DashboardBuilder severity normalisers', () => {
    it('treats every OSV-cached vuln id as risk', () => {
        expect(DashboardBuilder.cveSeverity(null)).toBe(null);
        expect(DashboardBuilder.cveSeverity([])).toBe(null);
        expect(DashboardBuilder.cveSeverity(['GHSA-xxxx'])).toBe('risk');
    });

    it('drops permissive licenses, lifts proprietary to risk', () => {
        const make = (severity: LicenseSeverity) => ({name: 'x', version: '1', spdx: 'X', severity: severity});
        expect(DashboardBuilder.licenseSeverity(make(LicenseSeverity.permissive))).toBe(null);
        expect(DashboardBuilder.licenseSeverity(make(LicenseSeverity.weakCopyleft))).toBe('info');
        expect(DashboardBuilder.licenseSeverity(make(LicenseSeverity.unknown))).toBe('info');
        expect(DashboardBuilder.licenseSeverity(make(LicenseSeverity.strongCopyleft))).toBe('warn');
        expect(DashboardBuilder.licenseSeverity(make(LicenseSeverity.proprietary))).toBe('risk');
    });

    it('passes through info/warn/risk scanner severities', () => {
        const sScript = (s: ScriptSeverity|null) => ({name: 'x', version: '1', maxSeverity: s, count: 0});
        expect(DashboardBuilder.scriptsSeverity(sScript(null))).toBe(null);
        expect(DashboardBuilder.scriptsSeverity(sScript(ScriptSeverity.warn))).toBe('warn');
        expect(DashboardBuilder.scriptsSeverity(sScript(ScriptSeverity.risk))).toBe('risk');

        const bin = (s: BinarySeverity|null) => ({name: 'x', version: '1', maxSeverity: s, riskCount: 0, totalCount: 0});
        expect(DashboardBuilder.binariesSeverity(bin(BinarySeverity.info))).toBe('info');
        expect(DashboardBuilder.binariesSeverity(bin(null))).toBe(null);

        const maint = (s: MaintainerSeverity|null) => ({name: 'x', version: '1', severity: s, publisher: null, publisher2FA: null, publisherCreatedAt: null});
        expect(DashboardBuilder.maintainerSeverity(maint(MaintainerSeverity.risk))).toBe('risk');
        expect(DashboardBuilder.maintainerSeverity(maint(null))).toBe(null);

        const churn = (s: ChurnSeverity) => ({
            previousVersion: '0', bumpType: 'patch' as const,
            added: 0, removed: 0, modified: 0, severity: s, reason: ''
        });
        expect(DashboardBuilder.churnSeverity(null)).toBe(null);
        expect(DashboardBuilder.churnSeverity(churn(ChurnSeverity.warn))).toBe('warn');

        const cadence = (lvl: CadenceLevel|null) => ({name: 'x', version: '1', level: lvl, daysSinceLastRelease: null, medianCadenceDays: null});
        expect(DashboardBuilder.cadenceSeverity(cadence(CadenceLevel.warn))).toBe('warn');
        expect(DashboardBuilder.cadenceSeverity(cadence(null))).toBe(null);

        const fresh = (lvl: FreshnessLevel|null) => ({name: 'x', version: '1', level: lvl, packageAgeDays: null, maintainerAgeDays: null});
        expect(DashboardBuilder.freshnessSeverity(fresh(FreshnessLevel.risk))).toBe('risk');
    });

    it('collapses IgnoreScripts to info / risk only', () => {
        expect(DashboardBuilder.ignoreScriptsSeverity(null)).toBe(null);
        expect(DashboardBuilder.ignoreScriptsSeverity(IgnoreScriptsLevel.unaffected)).toBe(null);
        expect(DashboardBuilder.ignoreScriptsSeverity(IgnoreScriptsLevel.safeToIgnore)).toBe(null);
        expect(DashboardBuilder.ignoreScriptsSeverity(IgnoreScriptsLevel.needsScripts)).toBe('info');
        expect(DashboardBuilder.ignoreScriptsSeverity(IgnoreScriptsLevel.avoidScripts)).toBe('risk');
    });

    it('passes Typosquat warn/risk and drops exact/unrelated', () => {
        const ts = (lvl: TyposquatLevel|null) => ({name: 'x', version: '1', level: lvl, closestMatch: null, hasConfusables: false});
        expect(DashboardBuilder.typosquatSeverity(ts(TyposquatLevel.exact))).toBe(null);
        expect(DashboardBuilder.typosquatSeverity(ts(TyposquatLevel.unrelated))).toBe(null);
        expect(DashboardBuilder.typosquatSeverity(ts(TyposquatLevel.warn))).toBe('warn');
        expect(DashboardBuilder.typosquatSeverity(ts(TyposquatLevel.risk))).toBe('risk');
        expect(DashboardBuilder.typosquatSeverity(ts(null))).toBe(null);
    });

    it('treats only unsigned provenance as info — signed/provenance are clean', () => {
        const p = (lvl: ProvenanceLevel|null) => ({name: 'x', version: '1', level: lvl});
        expect(DashboardBuilder.provenanceSeverity(p(ProvenanceLevel.provenance))).toBe(null);
        expect(DashboardBuilder.provenanceSeverity(p(ProvenanceLevel.signed))).toBe(null);
        expect(DashboardBuilder.provenanceSeverity(p(ProvenanceLevel.unsigned))).toBe('info');
        expect(DashboardBuilder.provenanceSeverity(p(null))).toBe(null);
    });

    it('passes IntegrityFinding severity straight through', () => {
        const f = {
            name: 'x', version: '1',
            kind: IntegrityFindingKind.integrityMismatch,
            severity: IntegritySeverity.risk
        } as Parameters<typeof DashboardBuilder.integritySeverity>[0];
        expect(DashboardBuilder.integritySeverity(f)).toBe('risk');
    });

    it('passes UnusedSeverity values straight through', () => {
        expect(DashboardBuilder.unusedSeverity(UnusedSeverity.info)).toBe('info');
        expect(DashboardBuilder.unusedSeverity(UnusedSeverity.warn)).toBe('warn');
        expect(DashboardBuilder.unusedSeverity(UnusedSeverity.risk)).toBe('risk');
    });
});

describe('DashboardBuilder.naCell', () => {
    it('returns a null-scored cell with the given note', () => {
        const cell = DashboardBuilder.naCell('no lockfile');
        expect(cell.score).toBe(null);
        expect(cell.note).toBe('no lockfile');
        expect(cell.total).toBe(0);
    });
});

describe('DashboardBuilder.unusedCell', () => {
    it('returns an N/A cell for unsupported projects', () => {
        const report = {
            project: {unid: 'p', name: 'remote', type: ConfigProjectType.github},
            supported: false,
            unsupportedReason: 'remote',
            unused: [], misplaced: [], missing: [], scanLimits: [], filesScanned: 0
        };
        const cell = DashboardBuilder.unusedCell(report, 100);
        expect(cell.score).toBe(null);
        expect(cell.note).toBe('remote');
    });

    it('counts misplaced and missing as warn-grade contributions', () => {
        const report = {
            project: {unid: 'p', name: 'local', type: ConfigProjectType.local},
            supported: true,
            unused: [{name: 'a', declaredIn: 'dependency' as const, severity: UnusedSeverity.warn, reason: ''}],
            misplaced: [{name: 'b', firstImport: 'x.ts'}],
            missing: [{name: 'c', firstImport: 'y.ts'}],
            scanLimits: [],
            filesScanned: 5
        };
        // 3 warns × 10 / (100 × 30) → 30/3000 → 100 × (1 − 0.01) = 99
        const cell = DashboardBuilder.unusedCell(report, 100);
        expect(cell.score).toBe(99);
        expect(cell.counts.warn).toBe(3);
        expect(cell.findings.map((f) => f.label).sort()).toEqual(['a', 'b', 'c']);
        const aFinding = cell.findings.find((f) => f.label === 'a');
        expect(aFinding?.detail).toContain('unused');
    });
});

describe('SCANNER_IDS catalogue', () => {
    it('contains all 21 expected scanners in stable order', () => {
        expect(SCANNER_IDS).toEqual([
            'cve', 'license', 'scripts', 'patterns', 'binaries', 'obfuscation',
            'manifestRedFlags', 'capability',
            'maintainer', 'churn', 'cadence', 'freshness',
            'ignoreScripts', 'typosquat', 'provenance', 'external', 'deprecation',
            'integrity', 'mutableResolution', 'unused', 'template'
        ]);
    });
});