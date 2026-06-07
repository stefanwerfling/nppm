import {I18n} from '../Util/I18n.js';

/**
 * Pure presentation helpers used across the Dashboard view (no
 * state, no DOM references except for the pills builder). Centralised
 * here so the Score / Packages / Size / Downloads charts and the
 * Overall hero card share the same axis labels and badges.
 */
export class Formatters {

    /** Compact integer with k / M / G suffix. Used for count axes. */
    public static count(n: number): string {
        if (n < 1000) {
            return String(Math.round(n));
        }
        if (n < 1_000_000) {
            const v = n / 1000;
            return v >= 100 ? `${Math.round(v)}k` : `${v.toFixed(1)}k`;
        }
        if (n < 1_000_000_000) {
            const v = n / 1_000_000;
            return v >= 100 ? `${Math.round(v)}M` : `${v.toFixed(1)}M`;
        }
        const v = n / 1_000_000_000;
        return v >= 100 ? `${Math.round(v)}G` : `${v.toFixed(1)}G`;
    }

    /**
     * Human-readable byte count. Snaps to the largest unit that keeps
     * the number ≥ 1 — 1024-based since that's what npm reports
     * (`du`-style). One decimal for the < 100 range, none above so
     * the labels don't visually drift.
     */
    public static bytes(n: number): string {
        if (n < 1024) {
            return `${n} B`;
        }
        const units = ['kB', 'MB', 'GB', 'TB'];
        let v = n / 1024;
        let i = 0;
        while (v >= 1024 && i < units.length - 1) {
            v /= 1024;
            i++;
        }
        return v >= 100 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
    }

    /**
     * Round up to a "nice" Y-axis ceiling so the gridlines hit round
     * numbers. Pick the leading digit and snap up to the next
     * 1 / 2 / 2.5 / 5 / 10 multiple of the magnitude.
     */
    public static niceCeil(n: number): number {
        if (n <= 1) {
            return 1;
        }
        const mag = 10**Math.floor(Math.log10(n));
        const lead = n / mag;
        let snap: number;
        if (lead <= 1) {
            snap = 1;
        } else if (lead <= 2) {
            snap = 2;
        } else if (lead <= 2.5) {
            snap = 2.5;
        } else if (lead <= 5) {
            snap = 5;
        } else {
            snap = 10;
        }
        return snap * mag;
    }

    /** `YY-MM-DD` — tighter on the X axis than the full ISO. */
    public static shortDate(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return iso;
        }
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear() % 100}-${m}-${day}`;
    }

    /**
     * Splits a `name@version` label back into its parts. Scoped
     * packages start with `@scope/name@version`; only the *last*
     * `@` separates name from version.
     */
    public static parseFindingLabel(label: string): {name?: string; version?: string;} {
        const at = label.lastIndexOf('@');
        if (at <= 0) {
            return {name: label};
        }
        return {name: label.slice(0, at), version: label.slice(at + 1)};
    }

    /** Format an ISO timestamp into a short relative-ish string. */
    public static timestamp(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return iso;
        }
        const ageSec = (Date.now() - d.getTime()) / 1000;
        if (ageSec < 60) {
            return I18n.t('just now');
        }
        if (ageSec < 3600) {
            return I18n.t('{n} min ago', {n: String(Math.floor(ageSec / 60))});
        }
        if (ageSec < 86400) {
            return I18n.t('{n} h ago', {n: String(Math.floor(ageSec / 3600))});
        }
        return d.toLocaleString();
    }

    /**
     * Three-pill severity badge (risk / warn / info). Each pill is
     * omitted when its count is zero so a clean project shows nothing.
     */
    public static renderPills(risk: number, warn: number, info: number): HTMLElement {
        const pills = document.createElement('div');
        pills.className = 'dash-overall-pills';
        if (risk > 0) {
            const pill = document.createElement('span');
            pill.className = 'dash-overall-pill dash-overall-pill-risk';
            pill.textContent = String(risk);
            pill.title = I18n.t('{n} risk-level finding(s)', {n: risk});
            pills.appendChild(pill);
        }
        if (warn > 0) {
            const pill = document.createElement('span');
            pill.className = 'dash-overall-pill dash-overall-pill-warn';
            pill.textContent = String(warn);
            pill.title = I18n.t('{n} warn-level finding(s)', {n: warn});
            pills.appendChild(pill);
        }
        if (info > 0) {
            const pill = document.createElement('span');
            pill.className = 'dash-overall-pill dash-overall-pill-info';
            pill.textContent = String(info);
            pill.title = I18n.t('{n} info-level finding(s)', {n: info});
            pills.appendChild(pill);
        }
        return pills;
    }

}