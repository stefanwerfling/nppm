import {describe, expect, it} from 'vitest';
import {ConfigProjectType} from '../Config/Config.js';
import {LicenseSeverity} from '../Security/LicenseScanner.js';
import {ScriptSeverity} from '../Security/ScriptScanner.js';
import {HeuristicsBatchEntry} from '../Security/SecurityScanner.js';
import {ScanReportBuilder, UnifiedSeverity} from '../Cli/ScanReport.js';
import {SarifBuilder} from '../Cli/ScanSarif.js';
import {UnusedSeverity} from '../Unused/UnusedReport.js';

function heuristic(name: string, version: string): HeuristicsBatchEntry {
    return {
        name,
        version,
        scripts: {name, version, maxSeverity: null, count: 0},
        patterns: {name, version, maxSeverity: null, count: 0},
        binaries: {name, version, maxSeverity: null, riskCount: 0, totalCount: 0},
        maintainer: {name, version, severity: null, publisher: null},
        license: {name, version, spdx: 'MIT', severity: LicenseSeverity.permissive},
        provenance: {name, version, level: null},
        freshness: {name, version, level: null, packageAgeDays: null, maintainerAgeDays: null},
        cadence: {name, version, level: null, daysSinceLastRelease: null, medianCadenceDays: null},
        typosquat: {name, version, level: null, closestMatch: null, hasConfusables: false},
        external: {name, version, level: null, count: 0},
        deprecation: {name, version, level: null}
    };
}

describe('SarifBuilder.build', () => {
    const projectMeta = {name: 'demo', type: ConfigProjectType.local};

    it('emits a valid SARIF 2.1.0 envelope with no findings', () => {
        const report = ScanReportBuilder.summarise([
            ScanReportBuilder.buildProject({...projectMeta, packagesScanned: 0})
        ]);
        const sarif = SarifBuilder.build(report, '1');
        expect(sarif.version).toBe('2.1.0');
        expect(sarif.$schema).toMatch(/sarif-2\.1/);
        expect(sarif.runs).toHaveLength(1);
        expect(sarif.runs[0].results).toEqual([]);
        expect(sarif.runs[0].tool.driver.name).toBe('nppm');
        expect(sarif.runs[0].tool.driver.version).toBe('1');
        expect(sarif.runs[0].invocations?.[0].executionSuccessful).toBe(true);
    });

    it('maps the three unified severities to SARIF levels', () => {
        const h = heuristic('p', '1');
        h.scripts.maxSeverity = ScriptSeverity.risk;
        h.scripts.count = 1;
        const report = ScanReportBuilder.summarise([
            ScanReportBuilder.buildProject({
                ...projectMeta,
                packagesScanned: 1,
                heuristics: [h],
                unused: {
                    project: {unid: '', name: 'demo', type: ConfigProjectType.local},
                    supported: true,
                    unused: [{
                        name: 'noisy-info-dep',
                        declaredIn: 'dependency',
                        severity: UnusedSeverity.info,
                        reason: 'allowlisted'
                    }],
                    misplaced: [{name: 'mis-dep', firstImport: 'src/foo.test.ts'}],
                    missing: [],
                    scanLimits: [],
                    filesScanned: 0
                }
            })
        ]);
        const sarif = SarifBuilder.build(report, '1');
        const levels = sarif.runs[0].results.map((r) => r.level).sort();
        expect(levels).toEqual(['error', 'note', 'warning']);
    });

    it('declares one rule per category that actually fired', () => {
        const h = heuristic('p', '1');
        h.scripts.maxSeverity = ScriptSeverity.warn;
        h.scripts.count = 1;
        const report = ScanReportBuilder.summarise([
            ScanReportBuilder.buildProject({...projectMeta, packagesScanned: 1, heuristics: [h]})
        ]);
        const rules = SarifBuilder.build(report, '1').runs[0].tool.driver.rules;
        expect(rules.map((r) => r.id)).toEqual(['nppm/script']);
    });

    it('partialFingerprints stay stable across project+category+coord', () => {
        const report = ScanReportBuilder.summarise([
            ScanReportBuilder.buildProject({
                ...projectMeta,
                packagesScanned: 1,
                vulnsByKey: new Map([['lodash@1.0.0', ['CVE-1']]])
            })
        ]);
        const fp = SarifBuilder.build(report, '1').runs[0].results[0].partialFingerprints;
        expect(fp.nppmCoord).toBe('demo|vuln|lodash@1.0.0');
    });

    it('marks executionSuccessful=false when any project reports an error', () => {
        const r1 = ScanReportBuilder.buildProject({...projectMeta, packagesScanned: 0});
        const r2 = ScanReportBuilder.buildProject({
            ...projectMeta,
            name: 'broken',
            packagesScanned: 0,
            error: 'lockfile: parse error'
        });
        const sarif = SarifBuilder.build(ScanReportBuilder.summarise([r1, r2]), '1');
        expect(sarif.runs[0].invocations?.[0].executionSuccessful).toBe(false);
    });

    it('attaches a usable physicalLocation per finding', () => {
        const report = ScanReportBuilder.summarise([
            ScanReportBuilder.buildProject({
                ...projectMeta,
                packagesScanned: 1,
                vulnsByKey: new Map([['foo@2.3.4', ['CVE-9']]])
            })
        ]);
        const loc = SarifBuilder.build(report, '1').runs[0].results[0].locations[0];
        expect(loc.physicalLocation.artifactLocation.uri).toBe('nppm-project/demo/foo@2.3.4');
    });
});