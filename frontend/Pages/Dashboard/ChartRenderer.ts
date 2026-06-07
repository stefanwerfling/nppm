import {I18n} from '../../Util/I18n.js';
import {Formatters} from './Formatters.js';

export type ChartInput = {
    series: {unid: string; name: string; points: {timestamp: string; value: number;}[];}[];
    overall: {timestamp: string; value: number;}[];
    yMin: number;
    yMax: number;
    yTicks: number[];
    overallLabel: string;
    valueFormatter: (v: number) => string;
};

/**
 * Pure-SVG line-chart renderer used by all four Trend-tab metrics
 * (Score / Packages / Size / Downloads). Each caller projects its own
 * data into the {series, overall, yTicks, valueFormatter} shape; the
 * renderer doesn't care which metric it's drawing.
 *
 * Layout: 880×360 viewport; 44 px padding left for Y labels, 200 px
 * right for the legend column, 16 px top, 36 px bottom for X tick
 * labels. One `<polyline>` per project, plus the ecosystem-overall
 * line on top in a heavier stroke. Hover-tooltip via SVG `<title>`
 * elements on the data dots — cheap and accessible.
 */
export class ChartRenderer {

    public static render(input: ChartInput): SVGElement {
        const svgNs = 'http://www.w3.org/2000/svg';
        const W = 880;
        const H = 360;
        const PAD_L = 44;
        // Legend column on the right.
        const PAD_R = 200;
        const PAD_T = 16;
        const PAD_B = 36;
        const PLOT_W = W - PAD_L - PAD_R;
        const PLOT_H = H - PAD_T - PAD_B;

        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('class', 'dash-trend-svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        /*
         * Collect every timestamp across series + overall so the X
         * scale spans the full union — a project that only logged
         * points before another project started shouldn't get
         * squished into the right edge.
         */
        const allTimes: number[] = [];
        for (const s of input.series) {
            for (const p of s.points) {
                allTimes.push(new Date(p.timestamp).getTime());
            }
        }
        for (const p of input.overall) {
            allTimes.push(new Date(p.timestamp).getTime());
        }
        if (allTimes.length === 0) {
            /*
             * Defensive — callers should have returned early when no
             * data is available, but render a friendly empty SVG
             * rather than crash on the maths below.
             */
            return svg;
        }
        const tStart = Math.min(...allTimes);
        const tEnd = Math.max(...allTimes);
        const tSpan = Math.max(1, tEnd - tStart);
        const xPx = (iso: string): number => {
            const t = new Date(iso).getTime();
            return PAD_L + (((t - tStart) / tSpan) * PLOT_W);
        };
        const yRange = Math.max(1, input.yMax - input.yMin);
        const yPx = (v: number): number =>
            PAD_T + ((1 - ((v - input.yMin) / yRange)) * PLOT_H);

        // Y gridlines + labels from the caller-supplied tick set.
        for (const tick of input.yTicks) {
            const y = yPx(tick);
            const line = document.createElementNS(svgNs, 'line');
            line.setAttribute('class', 'dash-trend-grid');
            line.setAttribute('x1', String(PAD_L));
            line.setAttribute('y1', String(y));
            line.setAttribute('x2', String(PAD_L + PLOT_W));
            line.setAttribute('y2', String(y));
            svg.appendChild(line);
            const lbl = document.createElementNS(svgNs, 'text');
            lbl.setAttribute('class', 'dash-trend-axis');
            lbl.setAttribute('x', String(PAD_L - 6));
            lbl.setAttribute('y', String(y + 4));
            lbl.setAttribute('text-anchor', 'end');
            lbl.textContent = input.valueFormatter(tick);
            svg.appendChild(lbl);
        }

        // X-axis date ticks: start / middle / end of the union span.
        const tickTimes = tStart === tEnd
            ? [tStart]
            : [tStart, (tStart + tEnd) / 2, tEnd];
        for (const t of tickTimes) {
            const iso = new Date(t).toISOString();
            const lbl = document.createElementNS(svgNs, 'text');
            lbl.setAttribute('class', 'dash-trend-axis');
            lbl.setAttribute('x', String(xPx(iso)));
            lbl.setAttribute('y', String(PAD_T + PLOT_H + 18));
            lbl.setAttribute('text-anchor', 'middle');
            lbl.textContent = Formatters.shortDate(iso);
            svg.appendChild(lbl);
        }

        /*
         * Sort projects by latest value asc so the lowest series is
         * first in the legend (matches "worst-first" semantics for
         * the score metric; for packages it shows the smallest
         * project first, which is also a reasonable default).
         */
        const seriesList = input.series.slice()
        .sort((a, b): number => {
            const la = a.points[a.points.length - 1]?.value ?? Infinity;
            const lb = b.points[b.points.length - 1]?.value ?? Infinity;
            return la - lb;
        });

        /*
         * Colour palette — cycles for projects beyond the 12th. Picked
         * so adjacent hues stay distinguishable on a dark background.
         */
        const palette = [
            '#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#5f27cd', '#ff9ff3',
            '#54a0ff', '#00d2d3', '#c8d6e5', '#ee5253', '#10ac84', '#ff9f43'
        ];

        for (let i = 0; i < seriesList.length; i++) {
            const s = seriesList[i];
            const colour = palette[i % palette.length];
            const poly = document.createElementNS(svgNs, 'polyline');
            poly.setAttribute('class', 'dash-trend-line');
            poly.setAttribute('points',
                s.points.map((p): string => `${xPx(p.timestamp)},${yPx(p.value)}`).join(' '));
            poly.setAttribute('stroke', colour);
            svg.appendChild(poly);
            for (const p of s.points) {
                const dot = document.createElementNS(svgNs, 'circle');
                dot.setAttribute('class', 'dash-trend-dot');
                dot.setAttribute('cx', String(xPx(p.timestamp)));
                dot.setAttribute('cy', String(yPx(p.value)));
                dot.setAttribute('r', '2.5');
                dot.setAttribute('fill', colour);
                const title = document.createElementNS(svgNs, 'title');
                title.textContent = `${s.name}: ${input.valueFormatter(p.value)} · ${Formatters.shortDate(p.timestamp)}`;
                dot.appendChild(title);
                svg.appendChild(dot);
            }
        }

        /*
         * Ecosystem-overall line — heavier stroke, painted last so it
         * sits on top.
         */
        if (input.overall.length > 1) {
            const poly = document.createElementNS(svgNs, 'polyline');
            poly.setAttribute('class', 'dash-trend-line dash-trend-line-overall');
            poly.setAttribute('points',
                input.overall.map((p): string => `${xPx(p.timestamp)},${yPx(p.value)}`).join(' '));
            svg.appendChild(poly);
        }
        for (const p of input.overall) {
            const dot = document.createElementNS(svgNs, 'circle');
            dot.setAttribute('class', 'dash-trend-dot dash-trend-dot-overall');
            dot.setAttribute('cx', String(xPx(p.timestamp)));
            dot.setAttribute('cy', String(yPx(p.value)));
            dot.setAttribute('r', '3.5');
            const title = document.createElementNS(svgNs, 'title');
            title.textContent = `${input.overallLabel}: ${input.valueFormatter(p.value)} · ${Formatters.shortDate(p.timestamp)}`;
            dot.appendChild(title);
            svg.appendChild(dot);
        }

        /*
         * Legend column on the right. Overall sits on top, then
         * per-project sorted.
         */
        const legendX = PAD_L + PLOT_W + 16;
        let legendY = PAD_T + 4;
        const legendEntry = (colour: string, text: string, isOverall: boolean): void => {
            const swatch = document.createElementNS(svgNs, 'line');
            swatch.setAttribute('x1', String(legendX));
            swatch.setAttribute('y1', String(legendY));
            swatch.setAttribute('x2', String(legendX + 18));
            swatch.setAttribute('y2', String(legendY));
            swatch.setAttribute('stroke', colour);
            swatch.setAttribute('stroke-width', isOverall ? '3' : '2');
            swatch.setAttribute('stroke-linecap', 'round');
            svg.appendChild(swatch);
            const lbl = document.createElementNS(svgNs, 'text');
            lbl.setAttribute('class', isOverall
                ? 'dash-trend-legend dash-trend-legend-overall'
                : 'dash-trend-legend');
            lbl.setAttribute('x', String(legendX + 24));
            lbl.setAttribute('y', String(legendY + 4));
            lbl.textContent = text;
            svg.appendChild(lbl);
            legendY += 18;
        };
        legendEntry('currentColor', input.overallLabel, true);
        for (let i = 0; i < seriesList.length && i < 12; i++) {
            legendEntry(palette[i % palette.length], seriesList[i].name, false);
        }
        if (seriesList.length > 12) {
            const lbl = document.createElementNS(svgNs, 'text');
            lbl.setAttribute('class', 'dash-trend-legend');
            lbl.setAttribute('x', String(legendX + 24));
            lbl.setAttribute('y', String(legendY + 4));
            lbl.textContent = I18n.t('+ {n} more', {n: seriesList.length - 12});
            svg.appendChild(lbl);
        }

        return svg;
    }

}