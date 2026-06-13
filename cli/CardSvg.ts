import {ScanReport, ScanFinding, UnifiedSeverity, UNIFIED_RANK} from './ScanReport.js';

/**
 * Letter-grade scale produced from a ScanReport. The unified
 * severity ladder collapses dozens of scanner enums to info/warn/risk
 * already; this maps the *aggregate* counts to a single grade so a
 * README badge can show project health at a glance.
 *
 * The thresholds intentionally bias towards "any risk = D, lots of
 * risk = F" so that an SBOM with a single known CVE is visually
 * distinct from a clean repo. info-only findings stay at A — they
 * tend to be deps.dev "older deprecated" notes that shouldn't bump
 * a project off the green colour.
 */
export enum CardGrade {
    aPlus = 'A+',
    a = 'A',
    b = 'B',
    c = 'C',
    d = 'D',
    f = 'F'
}

export type CardCounts = {
    risk: number;
    warn: number;
    info: number;
    total: number;
};

export type CardData = {
    grade: CardGrade;
    /** Worst severity that appears anywhere in the report. `null` = clean. */
    worst: UnifiedSeverity|null;
    counts: CardCounts;
    projects: number;
    projectsWithFindings: number;
    packages: number;
    timestamp: string;
};

export type CardBuildOptions = {
    /**
     * Optional project label shown in the header. Defaults to "nppm".
     * The card is meant to be embedded in a repo README, so the
     * consumer usually wants the repo name here.
     */
    title?: string;
};

/**
 * Pure conversion from `ScanReport` to a static SVG card. No HTTP, no
 * file IO — keeps the unit tests trivial and the runner in `Card.ts`
 * focused on argv + filesystem concerns.
 *
 * The visual model is codeflow-inspired: a coloured grade pill on the
 * left, three metric rows on the right, a thin "powered by nppm"
 * footer. Dimensions are fixed so the SVG drops into any README
 * without responsive layout work.
 */
export class SvgCardBuilder {

    /** Width × height stay constants so README embeds don't reflow. */
    private static readonly _WIDTH = 480;
    private static readonly _HEIGHT = 120;
    private static readonly _PILL_W = 120;

    /**
     * Severity → swatch. Each grade picks its swatch off the worst
     * severity in the report (or "clean" green when nothing fired).
     * Hex values are dark-mode-friendly — they keep enough contrast
     * on both white and dark GitHub README backgrounds.
     */
    private static readonly _SWATCH = {
        clean: {bg: '#1a7f37', fg: '#ffffff'},
        info: {bg: '#0969da', fg: '#ffffff'},
        warn: {bg: '#bf8700', fg: '#ffffff'},
        risk: {bg: '#cf222e', fg: '#ffffff'}
    };

    /**
     * Reduce a `ScanReport` to the shape the SVG layout needs. Pulled
     * apart from `build()` so tests can assert the count/grade
     * mapping without parsing SVG.
     */
    public static toCardData(report: ScanReport): CardData {
        const counts: CardCounts = {risk: 0, warn: 0, info: 0, total: 0};
        let packages = 0;

        for (const p of report.projects) {
            packages += p.packagesScanned;
            for (const f of p.findings) {
                counts.total++;
                if (f.severity === UnifiedSeverity.risk) {
                    counts.risk++;
                } else if (f.severity === UnifiedSeverity.warn) {
                    counts.warn++;
                } else {
                    counts.info++;
                }
            }
        }

        return {
            grade: SvgCardBuilder._gradeFor(counts),
            worst: report.summary.maxSeverity,
            counts: counts,
            projects: report.summary.totalProjects,
            projectsWithFindings: report.summary.projectsWithFindings,
            packages: packages,
            timestamp: report.timestamp
        };
    }

    /**
     * Map aggregate finding counts to a single letter grade.
     *
     * The ladder is empirical, not derived from any formal metric:
     *  - `A+` clean repo, zero findings
     *  - `A`  info-only — informational, not actionable
     *  - `B`  any warn but no risk
     *  - `C`  ≥5 warn or 1–2 risk
     *  - `D`  3–9 risk
     *  - `F`  ≥10 risk
     *
     * The risk thresholds dominate over warn because risk is the
     * gate-fail severity in `--fail-on=risk` (the CI default).
     */
    private static _gradeFor(c: CardCounts): CardGrade {
        if (c.risk >= 10) {
            return CardGrade.f;
        }
        if (c.risk >= 3) {
            return CardGrade.d;
        }
        if (c.risk >= 1) {
            return CardGrade.c;
        }
        if (c.warn >= 5) {
            return CardGrade.c;
        }
        if (c.warn >= 1) {
            return CardGrade.b;
        }
        if (c.info >= 1) {
            return CardGrade.a;
        }
        return CardGrade.aPlus;
    }

    /**
     * Pick the pill swatch from the worst severity present.
     * Mirrors `_gradeFor` but lives separate so the grade-letter
     * itself can stay severity-agnostic when we want a more
     * fine-grained palette later.
     */
    private static _swatchFor(data: CardData): {bg: string; fg: string;} {
        if (!data.worst) {
            return SvgCardBuilder._SWATCH.clean;
        }
        if (data.worst === UnifiedSeverity.risk) {
            return SvgCardBuilder._SWATCH.risk;
        }
        if (data.worst === UnifiedSeverity.warn) {
            return SvgCardBuilder._SWATCH.warn;
        }
        return SvgCardBuilder._SWATCH.info;
    }

    /**
     * Build the SVG string. Inline-only attributes, system font
     * stack, no external `<defs>` or filter so the asset works as
     * `<img src="nppm-card.svg">` *and* as a raw `<svg>` inline.
     */
    public static build(report: ScanReport, opts: CardBuildOptions = {}): string {
        const data = SvgCardBuilder.toCardData(report);
        const swatch = SvgCardBuilder._swatchFor(data);
        const title = SvgCardBuilder._escape(opts.title ?? 'nppm');

        const w = SvgCardBuilder._WIDTH;
        const h = SvgCardBuilder._HEIGHT;
        const pillW = SvgCardBuilder._PILL_W;
        const textX = pillW + 16;

        const grade = data.grade;
        // Grade label font scales down for 2-char letters so "A+" fits the same pill area.
        const gradeFont = grade === CardGrade.aPlus ? 44 : 56;

        const worstLabel = data.worst ? data.worst : 'clean';
        const pkgLabel = `${data.projects} project${data.projects === 1 ? '' : 's'} · ${data.packages} pkg`;
        const findingsLabel = data.counts.total === 0
            ? '0 findings'
            : `${data.counts.total} findings (${data.counts.risk} risk · ${data.counts.warn} warn · ${data.counts.info} info)`;
        const worstSentence = `Worst: ${worstLabel}`;

        const fontStack = '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif';

        // ARIA label drives screen readers + GitHub's image alt fallback.
        const aria = `nppm scan grade ${grade} — ${data.counts.total} findings across ${data.projects} project${data.projects === 1 ? '' : 's'}`;

        return `${[
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${SvgCardBuilder._escape(aria)}">`,
            `  <title>${SvgCardBuilder._escape(aria)}</title>`,
            `  <rect width="${w}" height="${h}" rx="8" ry="8" fill="#ffffff" stroke="#d0d7de" stroke-width="1"/>`,
            `  <rect x="0" y="0" width="${pillW}" height="${h}" fill="${swatch.bg}"/>`,
            `  <text x="${pillW / 2}" y="${(h / 2) - 4}" font-family="${fontStack}" font-size="${gradeFont}" font-weight="700" fill="${swatch.fg}" text-anchor="middle" dominant-baseline="middle">${grade}</text>`,
            `  <text x="${pillW / 2}" y="${h - 14}" font-family="${fontStack}" font-size="11" font-weight="600" fill="${swatch.fg}" text-anchor="middle" opacity="0.85">grade</text>`,
            `  <text x="${textX}" y="28" font-family="${fontStack}" font-size="16" font-weight="700" fill="#1f2328">${title}</text>`,
            `  <text x="${textX}" y="52" font-family="${fontStack}" font-size="12" fill="#57606a">${SvgCardBuilder._escape(pkgLabel)}</text>`,
            `  <text x="${textX}" y="72" font-family="${fontStack}" font-size="12" fill="#57606a">${SvgCardBuilder._escape(findingsLabel)}</text>`,
            `  <text x="${textX}" y="92" font-family="${fontStack}" font-size="12" fill="#57606a">${SvgCardBuilder._escape(worstSentence)}</text>`,
            `  <text x="${w - 12}" y="${h - 10}" font-family="${fontStack}" font-size="10" fill="#8c959f" text-anchor="end">nppm scan · ${SvgCardBuilder._escape(data.timestamp.slice(0, 10))}</text>`,
            '</svg>'
        ].join('\n')  }\n`;
    }

    /**
     * Minimal XML-text escape. We only emit text inside `<text>` and
     * attribute values we control, so the four standard entities
     * plus `&` are enough — no need for a full HTML escaper.
     */
    private static _escape(s: string): string {
        return s
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&apos;');
    }

    /** Exposed for the runner so it can log the chosen grade. */
    public static gradeOf(report: ScanReport): CardGrade {
        return SvgCardBuilder.toCardData(report).grade;
    }

}

/** Re-exported for the runner — keeps the public surface in one file. */
export {UnifiedSeverity, UNIFIED_RANK};
export type {ScanFinding};