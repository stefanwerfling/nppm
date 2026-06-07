import {DashboardCell, ScannerId} from '../../../backend/Dashboard/DashboardBuilder.js';
import {I18n} from '../../Util/I18n.js';

/**
 * Per-scanner presentation metadata. Strings, icons, and the score
 * ring renderer used by the matrix table's left-most cell and the
 * `_renderRing` inside every value cell. Everything here is pure
 * static — no DashboardView state — so the Score / Overall tabs can
 * reuse the same helpers without bridging through `this`.
 */
export class ScannerMeta {

    /** 14×14 outline info "i" inside a circle — feather-style. */
    public static readonly INFO_SVG: string =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" '
        + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + '<circle cx="12" cy="12" r="10"/>'
        + '<line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8"/>'
        + '</svg>';

    /**
     * Translated label for one scanner id. Centralised here so the
     * column-progress phrasing ("{project} — {scanner}") and the row
     * label use the same string.
     */
    public static label(id: ScannerId): string {
        switch (id) {
            case 'cve': return I18n.t('CVE (OSV)');
            case 'license': return I18n.t('License');
            case 'scripts': return I18n.t('Install scripts');
            case 'patterns': return I18n.t('Code patterns');
            case 'binaries': return I18n.t('Binaries');
            case 'obfuscation': return I18n.t('Obfuscation');
            case 'manifestRedFlags': return I18n.t('Manifest red-flags');
            case 'capability': return I18n.t('Capabilities');
            case 'maintainer': return I18n.t('Maintainer');
            case 'churn': return I18n.t('Churn');
            case 'cadence': return I18n.t('Cadence');
            case 'freshness': return I18n.t('Freshness');
            case 'ignoreScripts': return I18n.t('Ignore-scripts safety');
            case 'typosquat': return I18n.t('Typosquat');
            case 'provenance': return I18n.t('Provenance');
            case 'external': return I18n.t('External sources');
            case 'deprecation': return I18n.t('Deprecation');
            case 'integrity': return I18n.t('Integrity');
            case 'mutableResolution': return I18n.t('Mutable resolution');
            case 'unused': return I18n.t('Unused deps');
            case 'template': return I18n.t('Template compliance');
            default: throw new Error(`unknown scanner id: ${id as string}`);
        }
    }

    /**
     * Left-most cell of each row — composes a 16×16 monoline icon, the
     * scanner label, and an info button. The info button hosts a
     * sibling tooltip that the CSS reveals on hover/focus — single DOM
     * node per row keeps event handling cheap (one `:hover` rule
     * covers all rows).
     */
    public static renderScannerCell(id: ScannerId): HTMLElement {
        /*
         * `<td>` keeps its native `display: table-cell` so the column
         * sizes correctly with the rest of the table; the flex layout
         * lives one level down on a wrapper div.
         */
        const td = document.createElement('td');
        td.className = 'dash-td-scanner';

        const inner = document.createElement('div');
        inner.className = 'dash-scanner-inner';

        const iconWrap = document.createElement('span');
        iconWrap.className = 'dash-scanner-icon';
        iconWrap.innerHTML = ScannerMeta.icon(id);
        inner.appendChild(iconWrap);

        const label = document.createElement('span');
        label.className = 'dash-scanner-label';
        label.textContent = ScannerMeta.label(id);
        inner.appendChild(label);

        const info = document.createElement('span');
        info.className = 'dash-scanner-info';
        info.tabIndex = 0;
        info.setAttribute('role', 'button');
        info.setAttribute('aria-label', I18n.t('Scanner info'));
        info.innerHTML = ScannerMeta.INFO_SVG;

        const tip = document.createElement('div');
        tip.className = 'dash-tooltip';

        const whatHead = document.createElement('strong');
        whatHead.textContent = I18n.t('What it scans');
        tip.appendChild(whatHead);
        const whatBody = document.createElement('p');
        whatBody.textContent = ScannerMeta.what(id);
        tip.appendChild(whatBody);

        const howHead = document.createElement('strong');
        howHead.textContent = I18n.t('How the score is computed');
        tip.appendChild(howHead);
        const howBody = document.createElement('p');
        howBody.textContent = ScannerMeta.how(id);
        tip.appendChild(howBody);

        info.appendChild(tip);
        ScannerMeta.wireTooltip(info, tip);

        inner.appendChild(info);
        td.appendChild(inner);
        return td;
    }

    /**
     * Position the tooltip on hover / focus so it never overflows the
     * viewport. `position: fixed` escapes both the table-host overflow
     * and the pane-scroll, so the tooltip can render outside the
     * table's clip rect even for the bottom-most rows.
     *
     * Anchoring rules (default → fallbacks):
     *   • right of the info button, top-aligned with it
     *   • bottom-overflow → shift up so the bottom edge sits a margin
     *     above the viewport bottom
     *   • right-overflow → flip to the left side of the button
     */
    public static wireTooltip(info: HTMLElement, tip: HTMLElement): void {
        const position = (): void => {
            const infoRect = info.getBoundingClientRect();
            const margin = 12;
            const gap = 8;

            /*
             * Switch to fixed first; sizes were already computed by the
             * initial absolute-positioned render, so offsetWidth/Height
             * remain accurate.
             */
            tip.style.position = 'fixed';
            tip.style.left = '0px';
            tip.style.top = '0px';

            const tipWidth = tip.offsetWidth;
            const tipHeight = tip.offsetHeight;

            let left = infoRect.right + gap;
            let top = infoRect.top - 6;

            if (left + tipWidth > window.innerWidth - margin) {
                left = infoRect.left - tipWidth - gap;
            }
            if (left < margin) {
                left = margin;
            }

            if (top + tipHeight > window.innerHeight - margin) {
                top = window.innerHeight - margin - tipHeight;
            }
            if (top < margin) {
                top = margin;
            }

            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
        };

        info.addEventListener('mouseenter', position);
        info.addEventListener('focus', position);
    }

    /**
     * 16×16 outline icon per scanner. All paths share the same stroke
     * conventions (currentColor, stroke-width 2, round caps/joins)
     * so they pick up the row's text colour and look uniform when
     * placed side by side.
     */
    public static icon(id: ScannerId): string {
        const s = (path: string): string =>
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
            + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

        switch (id) {
            case 'cve':
                // Shield with exclamation
                return s('<path d="M12 2 4 5v6c0 5 4 9 8 11 4-2 8-6 8-11V5l-8-3z"/>'
                    + '<line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="16"/>');
            case 'license':
                // Scroll / document
                return s('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
                    + '<polyline points="14 2 14 8 20 8"/>'
                    + '<line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>');
            case 'scripts':
                // Terminal
                return s('<polyline points="4 7 9 12 4 17"/><line x1="12" y1="19" x2="20" y2="19"/>');
            case 'patterns':
                // Curly braces — code pattern matching
                return s('<path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2"/>'
                    + '<path d="M16 3h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2"/>');
            case 'binaries':
                // Cube
                return s('<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/>'
                    + '<polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>');
            case 'obfuscation':
                // Eye-off — hidden / masked code
                return s('<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 4.22-5.21"/>'
                    + '<path d="M10.58 5.08A10.43 10.43 0 0 1 12 5c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>'
                    + '<path d="M9.88 9.88a3 3 0 0 0 4.24 4.24"/>'
                    + '<line x1="3" y1="3" x2="21" y2="21"/>');
            case 'manifestRedFlags':
                // Flag — a manifest-level signal
                return s('<line x1="4" y1="22" x2="4" y2="3"/>'
                    + '<path d="M4 4h13l-2 4 2 4H4"/>');
            case 'capability':
                // Key — what does the package have permission to do
                return s('<circle cx="7" cy="14" r="4"/>'
                    + '<path d="M10 14l11-11"/><path d="M17 7l3 3"/><path d="M19 5l2 2"/>');
            case 'maintainer':
                // Person
                return s('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>'
                    + '<circle cx="12" cy="7" r="4"/>');
            case 'churn':
                // Trending up + spike
                return s('<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/>');
            case 'cadence':
                // Calendar
                return s('<rect x="3" y="4" width="18" height="18" rx="2"/>'
                    + '<line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>'
                    + '<line x1="3" y1="10" x2="21" y2="10"/>');
            case 'freshness':
                // Clock
                return s('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>');
            case 'ignoreScripts':
                // Shield with no-entry slash
                return s('<path d="M12 2 4 5v6c0 5 4 9 8 11 4-2 8-6 8-11V5l-8-3z"/>'
                    + '<line x1="8" y1="8" x2="16" y2="16"/>');
            case 'typosquat':
                // Magnifier over text
                return s('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>'
                    + '<line x1="8" y1="11" x2="14" y2="11"/>');
            case 'provenance':
                // Badge / sealed
                return s('<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>');
            case 'external':
                // Globe / world — external/internet reputation sources
                return s('<circle cx="12" cy="12" r="9"/>'
                    + '<line x1="3" y1="12" x2="21" y2="12"/>'
                    + '<path d="M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/>');
            case 'deprecation':
                /*
                 * Crossed-out package — old release the maintainer
                 * wants users to move off
                 */
                return s('<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/>'
                    + '<line x1="5" y1="5" x2="19" y2="19"/>');
            case 'integrity':
                // Lock
                return s('<rect x="4" y="11" width="16" height="10" rx="2"/>'
                    + '<path d="M8 11V7a4 4 0 0 1 8 0v4"/>');
            case 'mutableResolution':
                // Link with broken middle — non-reproducible resolution
                return s('<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07L11.5 4.5"/>'
                    + '<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07L12.5 19.5"/>'
                    + '<line x1="3" y1="3" x2="21" y2="21"/>');
            case 'unused':
                // Trash
                return s('<polyline points="3 6 5 6 21 6"/>'
                    + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>'
                    + '<path d="M10 11v6"/><path d="M14 11v6"/>'
                    + '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>');
            case 'template':
                // Clipboard with check
                return s('<rect x="6" y="4" width="12" height="18" rx="2"/>'
                    + '<rect x="9" y="2" width="6" height="4" rx="1"/>'
                    + '<polyline points="9 13 11 15 15 11"/>');
            default:
                throw new Error(`unknown scanner id: ${id as string}`);
        }
    }

    /**
     * Two-line description per scanner (what + how). Kept in the view
     * because the strings only ever surface in this one tooltip — no
     * other view needs them.
     */
    public static what(id: ScannerId): string {
        switch (id) {
            case 'cve':
                return I18n.t('Queries OSV.dev for known vulnerabilities affecting each installed name@version.');
            case 'license':
                return I18n.t('Classifies the SPDX expression of every package against the configured allow/denylist (permissive / weak-copyleft / strong-copyleft / proprietary / unknown).');
            case 'scripts':
                return I18n.t('Detects preinstall / install / postinstall / prepare hooks declared in each package.json. Higher severity for scripts that fetch the network or exec child processes.');
            case 'patterns':
                return I18n.t('Regex-scans tarball JavaScript for risky patterns: eval / Function / child_process / base64-decoded eval, etc.');
            case 'binaries':
                return I18n.t('Classifies binary files inside the tarball by extension and whether they sit on the bin/ path (executables the publisher exposes to npm install).');
            case 'obfuscation':
                return I18n.t('Looks for code-obfuscation fingerprints inside JS files: obfuscator.io _0x identifiers, eval(atob(...)) chains, hex-string arrays, and pathologically long lines outside of dist/min paths.');
            case 'manifestRedFlags':
                return I18n.t('Pure heuristics over `package.json`: missing README, missing description, missing files[] allowlist, many bin entries, the native-build+postinstall combo, or an engines.node range that excludes modern Node.');
            case 'capability':
                return I18n.t('Per-package capability inventory: which APIs the JS files touch (fs read/write, http/fetch, raw sockets, child_process, credential-shaped env vars, native bindings, eval). Severity is by combination, not by individual capability.');
            case 'maintainer':
                return I18n.t('Spots publisher handovers on mature packages. A short gap between the previous and current publisher on a long-lived package matches the event-stream / ua-parser-js takeover pattern.');
            case 'churn':
                return I18n.t('Diffs the current tarball against the previous stable release. Outsized add/remove/modify counts for a patch or minor bump are flagged.');
            case 'cadence':
                return I18n.t('Looks at the registry release timeline. Very stale (no recent releases) or unusually bursty cadence both raise the level.');
            case 'freshness':
                return I18n.t('Combines package age (first publish) with publisher account age. A brand-new package by a brand-new account is the highest-risk pair.');
            case 'ignoreScripts':
                return I18n.t('Derives a recommendation for `npm install --ignore-scripts`. Packages whose hooks do non-trivial work (compile, fetch, write to disk) flip the recommendation away from "ignore".');
            case 'typosquat':
                return I18n.t('Levenshtein distance to popular packages plus Unicode confusables (homoglyph attacks). Distance 1 / Unicode = risk; distance 2 = warn.');
            case 'provenance':
                return I18n.t('Reads the registry dist record for SLSA / sigstore attestation. Provenance + signed land in the no-finding bucket; unsigned counts as info.');
            case 'external':
                return I18n.t('Aggregates third-party reputation: socket.dev (supply-chain risk score), OpenSSF Scorecard (repo development practices), deps.dev (Google package index). Worst-of-three severity per package.');
            case 'deprecation':
                return I18n.t('Reads the per-version `deprecated` flag from the npm packument. Flags packages where the installed version, or the registry latest, was marked deprecated by the maintainer.');
            case 'integrity':
                return I18n.t('Cross-checks the lockfile `resolved` URL + `integrity` hash against what the registry currently serves. Mismatches and mirror redirects are surfaced.');
            case 'mutableResolution':
                return I18n.t('Walks the lockfile for entries that can\'t be reproduced deterministically: mutable git refs (branch/tag instead of SHA), missing integrity hashes on registry tarballs, file:/link: local protocols.');
            case 'unused':
                return I18n.t('Walks project source files for unused declared deps, misplaced (dev imports under runtime), and missing (imported but undeclared) packages.');
            case 'template':
                return I18n.t('Compares the project against the templates it declares — required deps + forbidden ranges + root metadata + file rules.');
            default:
                throw new Error(`unknown scanner id: ${id as string}`);
        }
    }

    /**
     * Scoring-formula explanation. The first sentence is the same
     * everywhere (the unified formula); the second is scanner-specific
     * so the user understands what counts as info / warn / risk for
     * this particular row.
     */
    public static how(id: ScannerId): string {
        const base = I18n.t('Unified formula: 100 × (1 − Σ min(weight, 30) / (packages × 30)) with info=1, warn=10, risk=30.');
        let specific: string;
        switch (id) {
            case 'cve':
                specific = I18n.t('Every OSV hit counts as risk (no per-vuln severity is fetched in batch).');
                break;
            case 'license':
                specific = I18n.t('Permissive licenses do not count. Unknown / weak-copyleft = info, strong-copyleft = warn, proprietary = risk.');
                break;
            case 'scripts':
            case 'patterns':
            case 'binaries':
            case 'obfuscation':
            case 'manifestRedFlags':
            case 'capability':
            case 'maintainer':
            case 'churn':
            case 'cadence':
            case 'freshness':
                specific = I18n.t('The scanner\'s native info / warn / risk severity is used as-is.');
                break;
            case 'ignoreScripts':
                specific = I18n.t('needs-scripts = info, avoid-scripts = risk. unaffected / safe-to-ignore do not count.');
                break;
            case 'typosquat':
                specific = I18n.t('exact / unrelated do not count. Distance 2 = warn; distance 1 or Unicode confusable = risk.');
                break;
            case 'provenance':
                specific = I18n.t('provenance / signed are clean. Only unsigned counts (as info).');
                break;
            case 'external':
                specific = I18n.t('Per-source severity (socket overall <50 = risk, <80 = warn; OpenSSF <5 = risk, <7 = warn; deps.dev = info only) reduced to worst-of-three per package.');
                break;
            case 'deprecation':
                specific = I18n.t('Installed version deprecated = risk, latest deprecated = warn, only older versions deprecated = info.');
                break;
            case 'integrity':
                specific = I18n.t('Per-finding info / warn / risk applied; total is divided by the package count for the score.');
                break;
            case 'mutableResolution':
                specific = I18n.t('Mutable git ref = risk, missing integrity hash = warn, file:/link: protocol = info. Synthesized lockfiles render N/A.');
                break;
            case 'unused':
                specific = I18n.t('Each unused entry uses its own severity. Misplaced and missing each count as warn.');
                break;
            case 'template':
                specific = I18n.t('Each compliance finding contributes its native severity. Projects without a declared template render N/A.');
                break;
        }
        return `${base} ${specific}`;
    }

    /**
     * SVG progress-ring with the score in the centre. Mirrors the
     * Treeview health-ring so the dashboard and treeview rings move
     * in lockstep for the same numbers. `score: null` renders an
     * em-dash inside a neutral ring.
     */
    public static renderRing(cell: DashboardCell): SVGElement {
        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', '0 0 36 36');
        svg.setAttribute('width', '36');
        svg.setAttribute('height', '36');

        const score = cell.score;
        let tier: 'na'|'good'|'warn'|'risk';
        if (score === null) {
            tier = 'na';
        } else if (score >= 80) {
            tier = 'good';
        } else if (score >= 60) {
            tier = 'warn';
        } else {
            tier = 'risk';
        }
        svg.setAttribute('class', `dash-ring dash-ring-${tier}`);

        const bg = document.createElementNS(svgNs, 'circle');
        bg.setAttribute('class', 'dash-ring-bg');
        bg.setAttribute('cx', '18');
        bg.setAttribute('cy', '18');
        bg.setAttribute('r', '15');
        bg.setAttribute('fill', 'none');
        svg.appendChild(bg);

        if (score !== null) {
            const fg = document.createElementNS(svgNs, 'circle');
            fg.setAttribute('class', 'dash-ring-fg');
            fg.setAttribute('cx', '18');
            fg.setAttribute('cy', '18');
            fg.setAttribute('r', '15');
            fg.setAttribute('fill', 'none');
            fg.setAttribute('pathLength', '100');
            fg.setAttribute('stroke-dasharray', `${score}, 100`);
            fg.setAttribute('stroke-linecap', 'round');
            fg.setAttribute('transform', 'rotate(-90 18 18)');
            svg.appendChild(fg);
        }

        const text = document.createElementNS(svgNs, 'text');
        text.setAttribute('class', 'dash-ring-text');
        text.setAttribute('x', '18');
        text.setAttribute('y', '22');
        text.setAttribute('text-anchor', 'middle');
        text.textContent = score === null ? '—' : String(score);
        svg.appendChild(text);

        return svg;
    }

    public static cellTooltip(cell: DashboardCell): string {
        if (cell.score === null) {
            return cell.note ?? I18n.t('N/A');
        }
        const summary: string[] = [`${cell.score}%`];
        if (cell.counts.risk > 0) {
            summary.push(`${cell.counts.risk} risk`);
        }
        if (cell.counts.warn > 0) {
            summary.push(`${cell.counts.warn} warn`);
        }
        if (cell.counts.info > 0) {
            summary.push(`${cell.counts.info} info`);
        }
        if (cell.total > 0) {
            summary.push(I18n.t('over {n} packages', {n: String(cell.total)}));
        }
        let text = summary.join(' · ');

        /*
         * Top-3 findings as separate lines — the native `title`
         * attribute renders newlines reliably in modern browsers.
         * Full list is available in the FindingsModal on click.
         */
        const topFindings = cell.findings.slice(0, 3);
        if (topFindings.length > 0) {
            const lines = topFindings.map((f): string =>
                `${f.severity.toUpperCase()} ${f.label}${f.detail ? ` · ${f.detail}` : ''}`);
            text = `${text}\n\n${lines.join('\n')}`;
            const flagged = cell.counts.risk + cell.counts.warn + cell.counts.info;
            if (flagged > topFindings.length) {
                text = `${text}\n…${flagged - topFindings.length} more (click to see all)`;
            }
        }
        return text;
    }

}