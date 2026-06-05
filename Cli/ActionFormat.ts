import {PrChangeKind, PrDepChange, PrReviewReport} from '../backend/PrReview/PrReview.js';

/**
 * Static marker the bot looks for to find its own previous comment
 * and update it in place. Hidden inside an HTML comment so it doesn't
 * render to the reviewer; matches the convention every PR-bot uses
 * (Dependabot, CodeRabbit, Snyk, …).
 */
export const STICKY_MARKER = '<!-- nppm-pr-review-sticky-marker -->';

/**
 * Render a `PrReviewReport` into a sticky-comment-shaped markdown
 * blob. The output is suitable for posting verbatim to the GitHub
 * Issues Comments API. Pure static — no I/O, deterministic for the
 * same input.
 */
export class ActionFormatter {

    public static commentBody(
        reports: PrReviewReport[],
        repoSlug: string,
        headSha: string
    ): string {
        const lines: string[] = [];
        lines.push(STICKY_MARKER);
        lines.push('## 🩺 nppm PR scan');
        lines.push('');

        const grandTotals = ActionFormatter._aggregate(reports);
        lines.push(ActionFormatter._summaryLine(grandTotals));
        lines.push('');

        if (grandTotals.totalChanges === 0) {
            lines.push('_No dependency changes in this PR._');
            lines.push('');
            lines.push(ActionFormatter._footer(repoSlug, headSha));
            return lines.join('\n');
        }

        for (const report of reports) {
            if (report.changes.length === 0) {
                continue;
            }
            lines.push(`### ${report.project.name}`);
            lines.push('');
            lines.push(ActionFormatter._projectTable(report));
            lines.push('');
            for (const note of report.notes) {
                lines.push(`> ${note}`);
            }
            if (report.notes.length > 0) {
                lines.push('');
            }
        }

        lines.push(ActionFormatter._footer(repoSlug, headSha));
        return lines.join('\n');
    }

    /**
     * Top-line summary across every project's changes. Visible above
     * the per-project tables so the reviewer sees the net delta at
     * a glance.
     */
    private static _summaryLine(totals: ReturnType<typeof ActionFormatter._aggregate>): string {
        const parts: string[] = [];
        parts.push(`**${totals.totalChanges}** dep change${totals.totalChanges === 1 ? '' : 's'}`);
        parts.push(`${totals.added} added`);
        parts.push(`${totals.removed} removed`);
        parts.push(`${totals.updated} updated`);
        if (totals.bucketChanged > 0) {
            parts.push(`${totals.bucketChanged} bucket-changed`);
        }
        const cveLine: string[] = [];
        if (totals.totalVulnsAdded > 0) {
            cveLine.push(`🔴 **+${totals.totalVulnsAdded} CVE${totals.totalVulnsAdded === 1 ? '' : 's'}**`);
        }
        if (totals.totalVulnsRemoved > 0) {
            cveLine.push(`🟢 **−${totals.totalVulnsRemoved} CVE${totals.totalVulnsRemoved === 1 ? '' : 's'}**`);
        }
        const main = parts.join(' · ');
        return cveLine.length > 0 ? `${main}  \n${cveLine.join('  ·  ')}` : main;
    }

    /**
     * One markdown table per project — rows sorted the same way the
     * UI sorts them: most-vulns-added first, then by name.
     */
    private static _projectTable(report: PrReviewReport): string {
        const lines: string[] = [];
        lines.push('| Package | Change | Range | Resolved | CVE Δ |');
        lines.push('|---|---|---|---|---|');
        for (const c of report.changes) {
            lines.push(`| ${ActionFormatter._cell(c.name)}`
                + ` | ${ActionFormatter._changeBadge(c.kind)}`
                + ` | ${ActionFormatter._rangeCell(c)}`
                + ` | ${ActionFormatter._resolvedCell(c)}`
                + ` | ${ActionFormatter._cveCell(c)} |`);
        }
        return lines.join('\n');
    }

    /** Translate the four PrChangeKind values into a markdown badge. */
    private static _changeBadge(kind: PrChangeKind): string {
        switch (kind) {
            case 'added': return '🟢 added';
            case 'removed': return '🔴 removed';
            case 'updated': return '🟡 updated';
            case 'bucket-changed': return '⚪ bucket';
        }
    }

    private static _rangeCell(c: PrDepChange): string {
        const before = c.declaredRangeBefore ? `\`${c.declaredRangeBefore}\`` : '—';
        const after = c.declaredRangeAfter ? `\`${c.declaredRangeAfter}\`` : '—';
        if (before === after) {
            return before;
        }
        return `${before} → ${after}`;
    }

    private static _resolvedCell(c: PrDepChange): string {
        if (!c.resolvedBefore && !c.resolvedAfter) {
            return '—';
        }
        const before = c.resolvedBefore ? `\`${c.resolvedBefore}\`` : '—';
        const after = c.resolvedAfter ? `\`${c.resolvedAfter}\`` : '—';
        if (before === after) {
            return before;
        }
        return `${before} → ${after}`;
    }

    /**
     * Compact CVE delta. Lists the IDs (capped at 3) so reviewers see
     * concrete identifiers without the table blowing up; the rest are
     * collapsed into a `+N more` tail.
     */
    private static _cveCell(c: PrDepChange): string {
        const added = c.vulnsAdded;
        const removed = c.vulnsRemoved;
        if (added.length === 0 && removed.length === 0) {
            return '—';
        }
        const parts: string[] = [];
        if (added.length > 0) {
            parts.push(`🔴 +${added.length}: ${ActionFormatter._idList(added)}`);
        }
        if (removed.length > 0) {
            parts.push(`🟢 −${removed.length}: ${ActionFormatter._idList(removed)}`);
        }
        return parts.join('<br>');
    }

    private static _idList(ids: string[]): string {
        const head = ids.slice(0, 3).map((id) => `\`${id}\``).join(', ');
        if (ids.length <= 3) {
            return head;
        }
        return `${head} +${ids.length - 3} more`;
    }

    private static _footer(repoSlug: string, headSha: string): string {
        return `<sub>nppm scan · ${repoSlug}@\`${headSha.slice(0, 7)}\`</sub>`;
    }

    /**
     * Escape pipe characters so package names with `|` (impossible in
     * npm but cheap insurance) can't break the markdown table.
     */
    private static _cell(text: string): string {
        return text.replace(/\|/g, '\\|');
    }

    private static _aggregate(reports: PrReviewReport[]) {
        const out = {
            totalChanges: 0,
            added: 0,
            removed: 0,
            updated: 0,
            bucketChanged: 0,
            totalVulnsAdded: 0,
            totalVulnsRemoved: 0
        };
        for (const r of reports) {
            out.totalChanges += r.changes.length;
            out.added += r.summary.added;
            out.removed += r.summary.removed;
            out.updated += r.summary.updated;
            out.bucketChanged += r.summary.bucketChanged;
            out.totalVulnsAdded += r.summary.totalVulnsAdded;
            out.totalVulnsRemoved += r.summary.totalVulnsRemoved;
        }
        return out;
    }
}