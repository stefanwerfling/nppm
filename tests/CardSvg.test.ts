import {describe, expect, it} from 'vitest';
import {ConfigProjectType} from '../backend/Config/Config.js';
import {ProjectScanReport, ScanReport, UnifiedSeverity} from '../cli/ScanReport.js';
import {CardGrade, SvgCardBuilder} from '../cli/CardSvg.js';

/**
 * Build a minimal valid `ScanReport` for tests. Default flavour is a
 * single clean project; each test tweaks `findings` to drive the
 * grade ladder.
 */
function makeReport(opts: {
    name?: string;
    findings?: ProjectScanReport['findings'];
    packagesScanned?: number;
    extraProjects?: ProjectScanReport[];
} = {}): ScanReport {
    const findings = opts.findings ?? [];
    let max: UnifiedSeverity|null = null;
    for (const f of findings) {
        if (f.severity === UnifiedSeverity.risk) {
            max = UnifiedSeverity.risk;
            break;
        }
        if (f.severity === UnifiedSeverity.warn) {
            max = UnifiedSeverity.warn;
        }
        if (f.severity === UnifiedSeverity.info && max === null) {
            max = UnifiedSeverity.info;
        }
    }

    const project: ProjectScanReport = {
        project: {name: opts.name ?? 'demo', type: ConfigProjectType.local},
        packagesScanned: opts.packagesScanned ?? 0,
        filesScanned: 0,
        maxSeverity: max,
        findings: findings,
        error: null
    };

    const extra = opts.extraProjects ?? [];
    const projects = [project, ...extra];
    let summaryMax: UnifiedSeverity|null = null;
    let withFindings = 0;
    for (const p of projects) {
        if (p.findings.length > 0) {
            withFindings++;
        }
        if (p.maxSeverity === UnifiedSeverity.risk) {
            summaryMax = UnifiedSeverity.risk;
        } else if (p.maxSeverity === UnifiedSeverity.warn && summaryMax !== UnifiedSeverity.risk) {
            summaryMax = UnifiedSeverity.warn;
        } else if (p.maxSeverity === UnifiedSeverity.info && summaryMax === null) {
            summaryMax = UnifiedSeverity.info;
        }
    }

    return {
        version: '1',
        timestamp: '2026-06-12T10:00:00.000Z',
        projects: projects,
        summary: {
            totalProjects: projects.length,
            projectsWithFindings: withFindings,
            maxSeverity: summaryMax
        }
    };
}

describe('SvgCardBuilder.toCardData — grade ladder', () => {

    it('clean report → A+', () => {
        const data = SvgCardBuilder.toCardData(makeReport());
        expect(data.grade).toBe(CardGrade.aPlus);
        expect(data.worst).toBeNull();
        expect(data.counts.total).toBe(0);
    });

    it('info-only findings → A', () => {
        const data = SvgCardBuilder.toCardData(makeReport({findings: [
            {category: 'license', severity: UnifiedSeverity.info, name: 'x', message: 'unknown'}
        ]}));
        expect(data.grade).toBe(CardGrade.a);
        expect(data.worst).toBe(UnifiedSeverity.info);
        expect(data.counts.info).toBe(1);
    });

    it('a single warn → B', () => {
        const data = SvgCardBuilder.toCardData(makeReport({findings: [
            {category: 'license', severity: UnifiedSeverity.warn, name: 'x', message: 'gpl'}
        ]}));
        expect(data.grade).toBe(CardGrade.b);
        expect(data.worst).toBe(UnifiedSeverity.warn);
    });

    it('5 warn → C', () => {
        const findings = Array.from({length: 5}, (_, i) => ({
            category: 'pattern' as const, severity: UnifiedSeverity.warn, name: `x${i}`, message: 'p'
        }));
        const data = SvgCardBuilder.toCardData(makeReport({findings: findings}));
        expect(data.grade).toBe(CardGrade.c);
    });

    it('a single risk finding → C', () => {
        const data = SvgCardBuilder.toCardData(makeReport({findings: [
            {category: 'vuln', severity: UnifiedSeverity.risk, name: 'x', message: 'CVE-...'}
        ]}));
        expect(data.grade).toBe(CardGrade.c);
        expect(data.worst).toBe(UnifiedSeverity.risk);
    });

    it('3 risk → D', () => {
        const findings = Array.from({length: 3}, (_, i) => ({
            category: 'vuln' as const, severity: UnifiedSeverity.risk, name: `x${i}`, message: 'CVE-...'
        }));
        const data = SvgCardBuilder.toCardData(makeReport({findings: findings}));
        expect(data.grade).toBe(CardGrade.d);
    });

    it('10 risk → F', () => {
        const findings = Array.from({length: 10}, (_, i) => ({
            category: 'vuln' as const, severity: UnifiedSeverity.risk, name: `x${i}`, message: 'CVE-...'
        }));
        const data = SvgCardBuilder.toCardData(makeReport({findings: findings}));
        expect(data.grade).toBe(CardGrade.f);
    });

    it('counts packagesScanned across all projects', () => {
        const data = SvgCardBuilder.toCardData(makeReport({
            packagesScanned: 100,
            extraProjects: [
                {
                    project: {name: 'b', type: ConfigProjectType.local},
                    packagesScanned: 50,
                    filesScanned: 0,
                    maxSeverity: null,
                    findings: [],
                    error: null
                }
            ]
        }));
        expect(data.packages).toBe(150);
        expect(data.projects).toBe(2);
    });

});

describe('SvgCardBuilder.build — SVG output', () => {

    it('emits a well-formed root <svg> with fixed dimensions', () => {
        const svg = SvgCardBuilder.build(makeReport());
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg.trim().endsWith('</svg>')).toBe(true);
        expect(svg).toContain('width="480"');
        expect(svg).toContain('height="120"');
        expect(svg).toContain('viewBox="0 0 480 120"');
    });

    it('contains the grade letter prominently', () => {
        const svg = SvgCardBuilder.build(makeReport());
        expect(svg).toContain('>A+<');
    });

    it('honours the --title option', () => {
        const svg = SvgCardBuilder.build(makeReport(), {title: 'my-repo'});
        expect(svg).toContain('>my-repo<');
    });

    it('defaults the title to "nppm"', () => {
        const svg = SvgCardBuilder.build(makeReport());
        expect(svg).toContain('>nppm<');
    });

    it('escapes XML-special characters in the title', () => {
        const svg = SvgCardBuilder.build(makeReport(), {title: '<evil>&"'});
        expect(svg).not.toContain('<evil>');
        expect(svg).toContain('&lt;evil&gt;');
        expect(svg).toContain('&amp;');
        expect(svg).toContain('&quot;');
    });

    it('shows worst-severity label for a risk finding', () => {
        const svg = SvgCardBuilder.build(makeReport({findings: [
            {category: 'vuln', severity: UnifiedSeverity.risk, name: 'x', message: 'CVE-...'}
        ]}));
        expect(svg).toContain('Worst: risk');
    });

    it('shows "Worst: clean" for a clean report', () => {
        const svg = SvgCardBuilder.build(makeReport());
        expect(svg).toContain('Worst: clean');
    });

    it('uses the danger swatch for any risk finding', () => {
        const svg = SvgCardBuilder.build(makeReport({findings: [
            {category: 'vuln', severity: UnifiedSeverity.risk, name: 'x', message: 'CVE-...'}
        ]}));
        expect(svg).toContain('#cf222e');
    });

    it('uses the success swatch for a clean report', () => {
        const svg = SvgCardBuilder.build(makeReport());
        expect(svg).toContain('#1a7f37');
    });

    it('renders the findings breakdown for a mixed report', () => {
        const svg = SvgCardBuilder.build(makeReport({findings: [
            {category: 'vuln', severity: UnifiedSeverity.risk, name: 'a', message: 'r'},
            {category: 'pattern', severity: UnifiedSeverity.warn, name: 'b', message: 'w'},
            {category: 'license', severity: UnifiedSeverity.info, name: 'c', message: 'i'}
        ]}));
        expect(svg).toContain('3 findings (1 risk · 1 warn · 1 info)');
    });

    it('renders the timestamp date-only suffix', () => {
        const svg = SvgCardBuilder.build(makeReport());
        expect(svg).toContain('2026-06-12');
    });

});

describe('SvgCardBuilder.gradeOf — convenience wrapper', () => {

    it('matches the grade from toCardData', () => {
        const report = makeReport({findings: [
            {category: 'vuln', severity: UnifiedSeverity.risk, name: 'x', message: 'r'}
        ]});
        expect(SvgCardBuilder.gradeOf(report)).toBe(SvgCardBuilder.toCardData(report).grade);
    });

});