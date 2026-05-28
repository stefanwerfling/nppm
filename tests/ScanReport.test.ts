import {describe, expect, it} from 'vitest';
import {ConfigProjectType} from '../Config/Config.js';
import {BinarySeverity} from '../Security/BinaryScanner.js';
import {LicenseSeverity} from '../Security/LicenseScanner.js';
import {MaintainerSeverity} from '../Security/MaintainerScanner.js';
import {PatternSeverity} from '../Security/PatternScanner.js';
import {ScriptSeverity} from '../Security/ScriptScanner.js';
import {HeuristicsBatchEntry} from '../Security/SecurityScanner.js';
import {
    buildProjectReport,
    licenseToUnified,
    summariseReport,
    UnifiedSeverity
} from '../Cli/ScanReport.js';
import {FailOnLevel} from '../Cli/CliArgs.js';
import {formatJson, formatText, shouldFail} from '../Cli/ScanFormat.js';
import {UnusedSeverity} from '../Unused/UnusedReport.js';

function baseHeuristic(name: string, version: string): HeuristicsBatchEntry {
    return {
        name,
        version,
        scripts: {name, version, maxSeverity: null, count: 0},
        patterns: {name, version, maxSeverity: null, count: 0},
        binaries: {name, version, maxSeverity: null, riskCount: 0, totalCount: 0},
        maintainer: {name, version, severity: null, publisher: null},
        license: {name, version, spdx: 'MIT', severity: LicenseSeverity.permissive}
    };
}

describe('licenseToUnified', () => {
    it('permissive maps to null', () => {
        expect(licenseToUnified(LicenseSeverity.permissive)).toBeNull();
    });
    it('proprietary maps to risk', () => {
        expect(licenseToUnified(LicenseSeverity.proprietary)).toBe(UnifiedSeverity.risk);
    });
    it('strong-copyleft maps to warn', () => {
        expect(licenseToUnified(LicenseSeverity.strongCopyleft)).toBe(UnifiedSeverity.warn);
    });
    it('weak-copyleft and unknown map to info', () => {
        expect(licenseToUnified(LicenseSeverity.weakCopyleft)).toBe(UnifiedSeverity.info);
        expect(licenseToUnified(LicenseSeverity.unknown)).toBe(UnifiedSeverity.info);
    });
});

describe('buildProjectReport', () => {
    const projectMeta = {name: 'demo', type: ConfigProjectType.local};

    it('emits no findings on a clean project', () => {
        const r = buildProjectReport({...projectMeta, packagesScanned: 0});
        expect(r.findings).toEqual([]);
        expect(r.maxSeverity).toBeNull();
    });

    it('treats any CVE as risk severity', () => {
        const vulnsByKey = new Map<string, string[]|null>([
            ['foo@1.0.0', ['GHSA-aaaa-bbbb-cccc']],
            ['bar@2.0.0', []],
            ['baz@3.0.0', null]
        ]);
        const r = buildProjectReport({...projectMeta, packagesScanned: 3, vulnsByKey});
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].category).toBe('vuln');
        expect(r.findings[0].severity).toBe(UnifiedSeverity.risk);
        expect(r.findings[0].name).toBe('foo');
        expect(r.findings[0].version).toBe('1.0.0');
        expect(r.maxSeverity).toBe(UnifiedSeverity.risk);
    });

    it('lifts script/pattern/binary/maintainer findings into the unified ladder', () => {
        const h = baseHeuristic('attacker-pkg', '0.0.1');
        h.scripts.maxSeverity = ScriptSeverity.risk;
        h.scripts.count = 2;
        h.patterns.maxSeverity = PatternSeverity.warn;
        h.patterns.count = 1;
        h.binaries.maxSeverity = BinarySeverity.warn;
        h.binaries.totalCount = 1;
        h.binaries.riskCount = 0;
        h.maintainer.severity = MaintainerSeverity.risk;
        h.maintainer.publisher = 'new-owner';

        const r = buildProjectReport({
            ...projectMeta,
            packagesScanned: 1,
            heuristics: [h]
        });

        const categories = r.findings.map((f) => f.category).sort();
        expect(categories).toEqual(['binary', 'maintainer', 'pattern', 'script']);
        expect(r.maxSeverity).toBe(UnifiedSeverity.risk);
    });

    it('drops permissive license findings; keeps proprietary as risk', () => {
        const a = baseHeuristic('libA', '1.0.0');
        // already permissive in baseHeuristic — no finding
        const b = baseHeuristic('libB', '1.0.0');
        b.license.spdx = 'UNLICENSED';
        b.license.severity = LicenseSeverity.proprietary;

        const r = buildProjectReport({
            ...projectMeta,
            packagesScanned: 2,
            heuristics: [a, b]
        });

        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].category).toBe('license');
        expect(r.findings[0].severity).toBe(UnifiedSeverity.risk);
        expect(r.findings[0].name).toBe('libB');
    });

    it('emits unused/misplaced/missing buckets with the right defaults', () => {
        const r = buildProjectReport({
            ...projectMeta,
            packagesScanned: 0,
            unused: {
                project: {unid: '', name: 'demo', type: ConfigProjectType.local},
                supported: true,
                unused: [{
                    name: 'unused-dep',
                    declaredIn: 'dependency',
                    severity: UnusedSeverity.risk,
                    reason: 'never imported'
                }],
                misplaced: [{name: 'mis-dep', firstImport: 'src/foo.test.ts'}],
                missing: [{name: 'undeclared-dep', firstImport: 'src/index.ts'}],
                scanLimits: [],
                filesScanned: 42
            }
        });

        const cats = r.findings.map((f) => `${f.category}:${f.severity}`).sort();
        expect(cats).toEqual([
            'misplaced:warn',
            'missing:risk',
            'unused:risk'
        ]);
        expect(r.maxSeverity).toBe(UnifiedSeverity.risk);
        expect(r.filesScanned).toBe(42);
    });

    it('orders findings worst-severity-first', () => {
        const h1 = baseHeuristic('a', '1');
        h1.scripts.maxSeverity = ScriptSeverity.info;
        h1.scripts.count = 1;
        const h2 = baseHeuristic('b', '1');
        h2.scripts.maxSeverity = ScriptSeverity.risk;
        h2.scripts.count = 1;
        const r = buildProjectReport({
            ...projectMeta,
            packagesScanned: 2,
            heuristics: [h1, h2]
        });
        expect(r.findings[0].name).toBe('b');
        expect(r.findings[0].severity).toBe(UnifiedSeverity.risk);
    });
});

describe('summariseReport + shouldFail', () => {
    const projectMeta = {name: 'demo', type: ConfigProjectType.local};

    it('shouldFail returns false on a clean report regardless of threshold', () => {
        const empty = summariseReport([
            buildProjectReport({...projectMeta, packagesScanned: 0})
        ]);
        expect(shouldFail(empty, FailOnLevel.info)).toBe(false);
        expect(shouldFail(empty, FailOnLevel.risk)).toBe(false);
    });

    it('shouldFail honours the threshold ladder', () => {
        const h = baseHeuristic('p', '1');
        h.scripts.maxSeverity = ScriptSeverity.warn;
        h.scripts.count = 1;
        const report = summariseReport([
            buildProjectReport({...projectMeta, packagesScanned: 1, heuristics: [h]})
        ]);
        expect(shouldFail(report, FailOnLevel.info)).toBe(true);
        expect(shouldFail(report, FailOnLevel.warn)).toBe(true);
        expect(shouldFail(report, FailOnLevel.risk)).toBe(false);
        expect(shouldFail(report, FailOnLevel.none)).toBe(false);
    });

    it('summary counts projects with findings and tracks the worst severity', () => {
        const a = buildProjectReport({...projectMeta, name: 'a', packagesScanned: 0});
        const b = buildProjectReport({
            ...projectMeta,
            name: 'b',
            packagesScanned: 1,
            vulnsByKey: new Map([['x@1', ['CVE-X']]])
        });
        const report = summariseReport([a, b]);
        expect(report.summary.totalProjects).toBe(2);
        expect(report.summary.projectsWithFindings).toBe(1);
        expect(report.summary.maxSeverity).toBe(UnifiedSeverity.risk);
    });
});

describe('formatText / formatJson', () => {
    const projectMeta = {name: 'demo', type: ConfigProjectType.local};

    it('renders PASS + FAIL banners in the text formatter', () => {
        const clean = summariseReport([
            buildProjectReport({...projectMeta, packagesScanned: 0})
        ]);
        const text = formatText(clean, FailOnLevel.risk);
        expect(text).toMatch(/no findings/);
        expect(text).toMatch(/Result: PASS/);

        const h = baseHeuristic('p', '1');
        h.scripts.maxSeverity = ScriptSeverity.risk;
        h.scripts.count = 1;
        const dirty = summariseReport([
            buildProjectReport({...projectMeta, packagesScanned: 1, heuristics: [h]})
        ]);
        const fail = formatText(dirty, FailOnLevel.risk);
        expect(fail).toMatch(/Result: FAIL/);
    });

    it('formatJson produces a parseable payload with stable top-level keys', () => {
        const clean = summariseReport([
            buildProjectReport({...projectMeta, packagesScanned: 0})
        ]);
        const parsed = JSON.parse(formatJson(clean));
        expect(parsed.version).toBe('1');
        expect(parsed.summary.totalProjects).toBe(1);
        expect(parsed.projects[0].project.name).toBe('demo');
    });
});