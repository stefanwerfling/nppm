import {
    FileFingerprint,
    FingerprintDiff,
    PackageFingerprint,
    PackageFingerprintManifest
} from '../Fingerprint/Fingerprint.js';
import {Release, ReleasesResponse} from '../Releases/Releases.js';
import {BinaryFinding, BinarySeverity} from '../Security/BinaryScanner.js';
import {ChurnFinding, ChurnSeverity} from '../Security/ChurnScanner.js';
import {LicenseFinding, LicenseSeverity} from '../Security/LicenseScanner.js';
import {CadenceFinding, CadenceLevel} from '../Security/CadenceScanner.js';
import {FreshnessFinding, FreshnessLevel} from '../Security/FreshnessScanner.js';
import {IgnoreScriptsFinding, IgnoreScriptsLevel} from '../Security/IgnoreScriptsScanner.js';
import {TyposquatFinding, TyposquatLevel} from '../Security/TyposquatScanner.js';
import {MaintainerFinding, MaintainerSeverity} from '../Security/MaintainerScanner.js';
import {ProvenanceFinding, ProvenanceLevel} from '../Security/ProvenanceScanner.js';
import {OsvVulnerability} from '../Security/OsvClient.js';
import {PatternFinding, PatternSeverity} from '../Security/PatternScanner.js';
import {ScriptFinding, ScriptSeverity} from '../Security/ScriptScanner.js';
import {SecurityReport} from '../Security/SecurityScanner.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';
import {Version} from './Version.js';

enum Tab {
    files = 'files',
    deps = 'deps',
    diff = 'diff',
    releases = 'releases',
    security = 'security',
    license = 'license'
}

/**
 * Modal-ish detail view for one `pkg@version` with three tabs:
 *  - Files: per-file SHA-256 + size of the tarball
 *  - Dependencies: dep/devDep/peer/optional declared by the package itself
 *  - Diff: vs another version (defaults to registry `latest`)
 *
 * Mounted into `document.body`; closes on backdrop click or ESC. Phase 5
 * will likely tack on a CVE / heuristic tab here too — this panel is the
 * "everything we know about one package version" surface.
 */
export class PackageDetailPanel {

    private _backdrop: HTMLElement|null = null;
    private _body: HTMLElement|null = null;
    private _tabBar: HTMLElement|null = null;
    private _tabPane: HTMLElement|null = null;
    private _keyHandler: ((e: KeyboardEvent) => void)|null = null;
    private _activeTab: Tab = Tab.files;
    private _fingerprint: PackageFingerprint|null = null;
    private _diffTarget: string|null = null;
    private _diffCache: FingerprintDiff|null = null;
    private _diffError: string|null = null;
    private _securityReport: SecurityReport|null = null;
    private _securityError: string|null = null;
    private _securityInflight: boolean = false;
    private _releases: ReleasesResponse|null = null;
    private _releasesError: string|null = null;
    private _releasesInflight: boolean = false;

    public async open(name: string, rawVersion: string, latest: string|null): Promise<void> {
        return this._open(name, rawVersion, latest, Tab.files);
    }

    /**
     * Open the panel landing on the security tab — used by the matrix
     * CVE badge. Behaves identically to `open()` otherwise.
     */
    public async openOnSecurity(name: string, rawVersion: string, latest: string|null): Promise<void> {
        return this._open(name, rawVersion, latest, Tab.security);
    }

    private async _open(name: string, rawVersion: string, latest: string|null, tab: Tab): Promise<void> {
        const version = Version.cleanRange(rawVersion);
        this._activeTab = tab;
        this._fingerprint = null;
        this._diffCache = null;
        this._diffError = null;
        this._diffTarget = null;
        this._securityReport = null;
        this._securityError = null;
        this._securityInflight = false;
        this._releases = null;
        this._releasesError = null;
        this._releasesInflight = false;

        this._mount(`${name}@${version}`);
        this._renderLoading();

        try {
            const response = await Api.fingerprint(name, version);

            if (!response.fingerprint) {
                this._renderEmpty(I18n.t('{name} is not available on the registry.', {name: `${name}@${version}`}));
                return;
            }

            this._fingerprint = response.fingerprint;

            const cleanedLatest = latest ? Version.cleanRange(latest) : null;
            if (cleanedLatest && cleanedLatest !== version) {
                this._diffTarget = cleanedLatest;
            }

            this._renderTabs();
            this._renderActiveTab();
        } catch (e) {
            this._renderEmpty((e as Error).message);
        }
    }

    private _mount(title: string): void {
        this._close();

        const backdrop = document.createElement('div');
        backdrop.className = 'pdp-backdrop';
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) {
                this._close();
            }
        });

        const panel = document.createElement('div');
        panel.className = 'pdp-panel';

        const head = document.createElement('div');
        head.className = 'pdp-head';

        const titleEl = document.createElement('div');
        titleEl.className = 'pdp-title';
        titleEl.textContent = title;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'pdp-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => this._close());

        head.appendChild(titleEl);
        head.appendChild(closeBtn);
        panel.appendChild(head);

        const body = document.createElement('div');
        body.className = 'pdp-body';
        panel.appendChild(body);
        this._body = body;

        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
        this._backdrop = backdrop;

        this._keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this._close();
            }
        };
        document.addEventListener('keydown', this._keyHandler);
    }

    private _close(): void {
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
        this._backdrop?.remove();
        this._backdrop = null;
        this._body = null;
        this._tabBar = null;
        this._tabPane = null;
    }

    private _renderLoading(): void {
        if (!this._body) {
            return;
        }
        this._body.innerHTML = `<div class="pdp-placeholder">${I18n.t('Loading fingerprint …')}</div>`;
    }

    private _renderEmpty(msg: string): void {
        if (!this._body) {
            return;
        }
        this._body.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'pdp-error';
        el.textContent = msg;
        this._body.appendChild(el);
    }

    private _renderTabs(): void {
        if (!this._body) {
            return;
        }
        this._body.innerHTML = '';

        const tabs: {value: Tab; label: string}[] = [
            {value: Tab.files, label: I18n.t('Files')},
            {value: Tab.deps, label: I18n.t('Dependencies')},
            {value: Tab.diff, label: this._diffTarget
                ? I18n.t('Diff against {target}', {target: this._diffTarget})
                : I18n.t('Diff')},
            {value: Tab.releases, label: I18n.t('Releases')},
            {value: Tab.security, label: this._securityTabLabel()},
            {value: Tab.license, label: this._licenseTabLabel()}
        ];

        const bar = document.createElement('div');
        bar.className = 'pdp-tabs';

        for (const tab of tabs) {
            const btn = document.createElement('button');
            btn.className = 'pdp-tab';
            if (tab.value === this._activeTab) {
                btn.classList.add('pdp-tab-active');
            }
            btn.textContent = tab.label;

            // Diff tab is disabled when there is no second version to compare against.
            if (tab.value === Tab.diff && !this._diffTarget) {
                btn.disabled = true;
                btn.title = I18n.t('No comparison version available (cell version = latest or latest unknown)');
            }

            btn.addEventListener('click', () => {
                this._activeTab = tab.value;
                this._renderTabs();
                this._renderActiveTab();
            });

            bar.appendChild(btn);
        }

        this._body.appendChild(bar);
        this._tabBar = bar;

        const pane = document.createElement('div');
        pane.className = 'pdp-pane';
        this._body.appendChild(pane);
        this._tabPane = pane;
    }

    private _renderActiveTab(): void {
        if (!this._tabPane || !this._fingerprint) {
            return;
        }
        this._tabPane.innerHTML = '';

        switch (this._activeTab) {
            case Tab.files:
                this._tabPane.appendChild(this._renderFilesTab(this._fingerprint));
                return;
            case Tab.deps:
                this._tabPane.appendChild(this._renderDepsTab(this._fingerprint));
                return;
            case Tab.diff:
                this._renderDiffTab();
                return;
            case Tab.releases:
                this._renderReleasesTab();
                return;
            case Tab.security:
                this._renderSecurityTab();
                return;
            case Tab.license:
                this._renderLicenseTab();
                return;
        }
    }

    private _licenseTabLabel(): string {
        if (!this._securityReport) {
            return I18n.t('License');
        }
        const sev = this._securityReport.license.severity;
        if (sev === LicenseSeverity.strongCopyleft
            || sev === LicenseSeverity.proprietary) {
            return `${I18n.t('License')} !`;
        }
        return I18n.t('License');
    }

    private _renderLicenseTab(): void {
        if (!this._tabPane || !this._fingerprint) {
            return;
        }

        // The license arrives as part of the security report — if the
        // report has not loaded yet, kick that fetch off so the user
        // doesn't have to flip to the Security tab first. We still
        // show a placeholder while we wait.
        if (!this._securityReport) {
            if (this._securityError) {
                const err = document.createElement('div');
                err.className = 'pdp-error';
                err.textContent = this._securityError;
                this._tabPane.appendChild(err);
                return;
            }
            const loading = document.createElement('div');
            loading.className = 'pdp-placeholder';
            loading.textContent = I18n.t('Loading license info …');
            this._tabPane.appendChild(loading);

            if (!this._securityInflight) {
                this._securityInflight = true;
                const name = this._fingerprint.name;
                const version = this._fingerprint.version;
                void Api.security(name, version).then((report) => {
                    this._securityInflight = false;
                    this._securityReport = report;
                    this._renderTabs();
                    if (this._activeTab === Tab.license) {
                        this._renderActiveTab();
                    }
                }).catch((e: Error) => {
                    this._securityInflight = false;
                    this._securityError = e.message;
                    if (this._activeTab === Tab.license) {
                        this._renderActiveTab();
                    }
                });
            }
            return;
        }

        this._tabPane.appendChild(this._renderLicenseBody(this._securityReport));
    }

    private _renderLicenseBody(report: SecurityReport): HTMLElement {
        const wrap = document.createElement('div');

        const finding = report.license;
        const cardSeverity = PackageDetailPanel._licenseCardSeverity(finding.severity);

        const card = document.createElement('div');
        card.className = `pdp-script pdp-script-${cardSeverity}`;

        const head = document.createElement('div');
        head.className = 'pdp-script-head';

        const sev = document.createElement('span');
        sev.className = `pdp-sev pdp-sev-${cardSeverity}`;
        sev.textContent = PackageDetailPanel._licenseSeverityLabel(finding.severity);
        head.appendChild(sev);

        const spdx = document.createElement('span');
        spdx.className = 'pdp-script-hook';
        spdx.textContent = finding.spdx ?? '—';
        head.appendChild(spdx);

        if (finding.policyMatched) {
            const policy = document.createElement('span');
            policy.className = 'pdp-script-reason';
            policy.textContent = I18n.t('via nppm.json policy');
            head.appendChild(policy);
        }

        card.appendChild(head);

        const reason = document.createElement('div');
        reason.className = 'pdp-script-reason';
        reason.textContent = finding.reason;
        card.appendChild(reason);

        if (finding.identifiers.length > 1) {
            const ids = document.createElement('code');
            ids.className = 'pdp-script-body';
            ids.textContent = I18n.t('Identifiers in expression: {ids}', {ids: finding.identifiers.join(', ')});
            card.appendChild(ids);
        }

        wrap.appendChild(card);

        // Cross-check: list LICENSE* files actually shipped in the
        // tarball. Helps spot the "we declared MIT but ship a GPL
        // LICENSE file" smell — a separate signal from the manifest's
        // self-report.
        const licenseFiles = this._fingerprint?.files
            .filter((f) => /(^|\/)(LICEN[SC]E|COPYING|NOTICE)(\.[^/]+)?$/i.test(f.path));

        const filesSection = document.createElement('div');
        filesSection.className = 'pdp-section';

        const filesHead = document.createElement('div');
        filesHead.className = 'pdp-section-head';
        filesHead.textContent = I18n.t('License files in tarball ({count})', {count: licenseFiles?.length ?? 0});
        filesSection.appendChild(filesHead);

        if (licenseFiles && licenseFiles.length > 0) {
            const list = document.createElement('div');
            list.className = 'pdp-list';
            for (const f of licenseFiles) {
                const row = document.createElement('div');
                row.className = 'pdp-row';
                const p = document.createElement('span');
                p.className = 'pdp-row-path';
                p.textContent = f.path;
                const s = document.createElement('span');
                s.className = 'pdp-row-size';
                s.textContent = `${f.size} B`;
                row.appendChild(p);
                row.appendChild(s);
                list.appendChild(row);
            }
            filesSection.appendChild(list);
        } else {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = I18n.t('No LICENSE/COPYING file shipped in the tarball.');
            filesSection.appendChild(empty);
        }

        wrap.appendChild(filesSection);
        return wrap;
    }

    /**
     * Map a `LicenseSeverity` onto the three-tier `info/warn/risk`
     * style classes the panel already uses for other findings.
     */
    private static _licenseCardSeverity(s: LicenseSeverity): 'info'|'warn'|'risk' {
        switch (s) {
            case LicenseSeverity.permissive:
                return 'info';
            case LicenseSeverity.weakCopyleft:
            case LicenseSeverity.unknown:
                return 'warn';
            case LicenseSeverity.strongCopyleft:
            case LicenseSeverity.proprietary:
                return 'risk';
        }
    }

    private static _licenseSeverityLabel(s: LicenseSeverity): string {
        switch (s) {
            case LicenseSeverity.permissive:
                return 'PERMISSIVE';
            case LicenseSeverity.weakCopyleft:
                return 'WEAK-COPYLEFT';
            case LicenseSeverity.strongCopyleft:
                return 'STRONG-COPYLEFT';
            case LicenseSeverity.proprietary:
                return 'PROPRIETARY';
            case LicenseSeverity.unknown:
                return 'UNKNOWN';
        }
    }

    private _securityTabLabel(): string {
        // Adds a count badge to the tab once the report has loaded —
        // e.g. "Security (3)". The user can see "is there anything in
        // there" without clicking. Churn counts when severity > info.
        if (!this._securityReport) {
            return I18n.t('Security');
        }
        const v = this._securityReport.vulns?.length ?? 0;
        const s = this._securityReport.scriptFindings.length;
        const p = this._securityReport.patternFindings.length;
        const b = this._securityReport.binaryFindings.length;
        const c = this._securityReport.churn && this._securityReport.churn.severity !== ChurnSeverity.info ? 1 : 0;
        const m = this._securityReport.maintainer && this._securityReport.maintainer.severity !== MaintainerSeverity.info ? 1 : 0;
        const n = v + s + p + b + c + m;
        return n > 0 ? `${I18n.t('Security')} (${n})` : I18n.t('Security');
    }

    private _renderFilesTab(fp: PackageFingerprint): HTMLElement {
        const wrap = document.createElement('div');
        const totalSize = fp.files.reduce((sum, f) => sum + f.size, 0);

        const summary = document.createElement('div');
        summary.className = 'pdp-summary';
        summary.innerHTML = `
            <span class="pdp-stat"><strong>${fp.files.length}</strong> ${I18n.t('Files')}</span>
            <span class="pdp-stat"><strong>${PackageDetailPanel._formatSize(totalSize)}</strong></span>
        `;
        wrap.appendChild(summary);

        wrap.appendChild(this._renderFileList(fp.files));
        return wrap;
    }

    private _renderDepsTab(fp: PackageFingerprint): HTMLElement {
        const wrap = document.createElement('div');

        if (!fp.manifest) {
            const empty = document.createElement('div');
            empty.className = 'pdp-error';
            empty.textContent = I18n.t('No package.json found in tarball.');
            wrap.appendChild(empty);
            return wrap;
        }

        const m = fp.manifest;
        const sections: {label: string; map: Record<string, string>}[] = [
            {label: 'dependencies', map: m.dependencies},
            {label: 'devDependencies', map: m.devDependencies},
            {label: 'peerDependencies', map: m.peerDependencies},
            {label: 'optionalDependencies', map: m.optionalDependencies}
        ];

        let any = false;

        for (const s of sections) {
            const entries = Object.entries(s.map);
            if (entries.length === 0) {
                continue;
            }
            any = true;
            wrap.appendChild(this._renderDepSection(s.label, entries));
        }

        if (!any) {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = I18n.t('No declared dependencies in this package.');
            wrap.appendChild(empty);
        }

        return wrap;
    }

    private _renderDepSection(label: string, entries: [string, string][]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${label} (${entries.length})`;
        wrap.appendChild(heading);

        entries.sort(([a], [b]) => a.localeCompare(b));

        const list = document.createElement('div');
        list.className = 'pdp-list';

        for (const [name, range] of entries) {
            const row = document.createElement('div');
            row.className = 'pdp-row';

            const n = document.createElement('span');
            n.className = 'pdp-row-path';
            n.textContent = name;

            const r = document.createElement('span');
            r.className = 'pdp-row-hash';
            r.textContent = range;

            row.appendChild(n);
            row.appendChild(r);
            list.appendChild(row);
        }

        wrap.appendChild(list);
        return wrap;
    }

    /**
     * Releases tab: registry version timeline plus GitHub release
     * notes when the package is hosted there. Lazy-loaded; the panel
     * doesn't pay the GitHub call cost unless the user opens the tab.
     */
    private _renderReleasesTab(): void {
        if (!this._tabPane || !this._fingerprint) {
            return;
        }

        if (this._releases) {
            this._tabPane.appendChild(this._renderReleasesBody(this._releases));
            return;
        }

        if (this._releasesError) {
            const err = document.createElement('div');
            err.className = 'pdp-error';
            err.textContent = this._releasesError;
            this._tabPane.appendChild(err);
            return;
        }

        const loading = document.createElement('div');
        loading.className = 'pdp-placeholder';
        loading.textContent = I18n.t('Loading releases …');
        this._tabPane.appendChild(loading);

        if (this._releasesInflight) {
            return;
        }
        this._releasesInflight = true;
        const name = this._fingerprint.name;
        const version = this._fingerprint.version;

        void Api.releases(name, version).then((response) => {
            this._releasesInflight = false;
            this._releases = response;
            if (this._activeTab === Tab.releases) {
                this._renderActiveTab();
            }
        }).catch((e: Error) => {
            this._releasesInflight = false;
            this._releasesError = e.message;
            if (this._activeTab === Tab.releases) {
                this._renderActiveTab();
            }
        });
    }

    private _renderReleasesBody(data: ReleasesResponse): HTMLElement {
        const wrap = document.createElement('div');

        if (data.description) {
            const desc = document.createElement('div');
            desc.className = 'pdp-releases-desc';
            desc.textContent = data.description;
            wrap.appendChild(desc);
        }

        if (data.releases.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = I18n.t('No published versions.');
            wrap.appendChild(empty);
            return wrap;
        }

        const hasAnyBody = data.releases.some((r) => r.body || r.name);
        if (!hasAnyBody && data.repository) {
            const hint = document.createElement('div');
            hint.className = 'pdp-releases-hint';
            hint.textContent = I18n.t('No GitHub release notes found — only npm publish dates available.');
            wrap.appendChild(hint);
        }

        const list = document.createElement('div');
        list.className = 'pdp-releases';

        for (const r of data.releases) {
            list.appendChild(this._renderReleaseCard(r));
        }

        wrap.appendChild(list);
        return wrap;
    }

    private _renderReleaseCard(r: Release): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pdp-release';

        const head = document.createElement('div');
        head.className = 'pdp-release-head';

        const version = document.createElement('span');
        version.className = 'pdp-release-version';
        version.textContent = r.version;
        head.appendChild(version);

        if (r.publishedAt) {
            const when = document.createElement('span');
            when.className = 'pdp-release-when';
            when.textContent = PackageDetailPanel._formatReleaseDate(r.publishedAt);
            head.appendChild(when);
        }

        if (r.publisher) {
            const by = document.createElement('span');
            by.className = 'pdp-release-publisher';
            by.textContent = `by ${r.publisher}`;
            head.appendChild(by);
        }

        if (r.url) {
            const link = document.createElement('a');
            link.className = 'pdp-release-link';
            link.href = r.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = '↗';
            link.title = r.url;
            head.appendChild(link);
        }

        card.appendChild(head);

        if (r.name && r.name !== r.version) {
            const title = document.createElement('div');
            title.className = 'pdp-release-title';
            title.textContent = r.name;
            card.appendChild(title);
        }

        if (r.body && r.body.trim().length > 0) {
            const body = document.createElement('pre');
            body.className = 'pdp-release-body';
            body.textContent = r.body.trim();
            card.appendChild(body);
        }

        return card;
    }

    private static _formatReleaseDate(iso: string): string {
        const d = new Date(iso);
        if (isNaN(d.getTime())) {
            return iso;
        }
        const pad = (n: number): string => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    private _renderSecurityTab(): void {
        if (!this._tabPane || !this._fingerprint) {
            return;
        }

        if (this._securityReport) {
            this._tabPane.appendChild(this._renderSecurityBody(this._securityReport));
            return;
        }

        if (this._securityError) {
            const err = document.createElement('div');
            err.className = 'pdp-error';
            err.textContent = this._securityError;
            this._tabPane.appendChild(err);
            return;
        }

        const loading = document.createElement('div');
        loading.className = 'pdp-placeholder';
        loading.textContent = I18n.t('Scanning CVEs and install scripts …');
        this._tabPane.appendChild(loading);

        if (this._securityInflight) {
            return;
        }
        this._securityInflight = true;

        const name = this._fingerprint.name;
        const version = this._fingerprint.version;

        void Api.security(name, version).then((report) => {
            this._securityInflight = false;
            this._securityReport = report;

            // The label includes the count → re-render the tab bar too.
            this._renderTabs();
            if (this._activeTab === Tab.security) {
                this._renderActiveTab();
            }
        }).catch((e: Error) => {
            this._securityInflight = false;
            this._securityError = e.message;
            if (this._activeTab === Tab.security) {
                this._renderActiveTab();
            }
        });
    }

    private _renderSecurityBody(report: SecurityReport): HTMLElement {
        const wrap = document.createElement('div');

        // Git-installed packages skip OSV (no ecosystem-version key)
        // and churn (no previous published version). Flag that up-front
        // so an empty vuln list isn't mistaken for "verified safe".
        if (PackageDetailPanel._isGitVersion(report.version)) {
            const note = document.createElement('div');
            note.className = 'pdp-error';
            note.textContent = I18n.t(
                'Git package: OSV.dev only indexes registry-installed versions. Script + code-pattern heuristics still ran.'
            );
            wrap.appendChild(note);
        }

        const vulnCount = report.vulns?.length ?? 0;
        const scriptCount = report.scriptFindings.length;
        const patternCount = report.patternFindings.length;
        const binaryCount = report.binaryFindings.length;
        const interestingChurn = report.churn && report.churn.severity !== ChurnSeverity.info;
        const interestingMaintainer = report.maintainer && report.maintainer.severity !== MaintainerSeverity.info;

        // Combined-signal banner: a fresh publisher *and* an outsized
        // diff in the same release is the textbook account-takeover
        // pattern (event-stream, ua-parser-js, @solana/web3.js, …).
        const supplyChainBanner = PackageDetailPanel._supplyChainRisk(report.maintainer, report.churn);
        if (supplyChainBanner) {
            wrap.appendChild(supplyChainBanner);
        }

        if (vulnCount === 0 && scriptCount === 0 && patternCount === 0 && binaryCount === 0
            && !interestingChurn && !interestingMaintainer && report.vulns !== null) {
            const ok = document.createElement('div');
            ok.className = 'pdp-placeholder';
            ok.textContent = I18n.t('No known CVEs (OSV.dev), no suspicious install scripts, no notable file churn, no known code patterns and no binary files.');
            wrap.appendChild(ok);
            return wrap;
        }

        wrap.appendChild(this._renderVulnsSection(report.vulns));
        wrap.appendChild(this._renderScriptsSection(report.scriptFindings));
        wrap.appendChild(this._renderIgnoreScriptsBanner(report.ignoreScripts));
        wrap.appendChild(this._renderPatternsSection(report.patternFindings));
        wrap.appendChild(this._renderBinariesSection(report.binaryFindings));
        wrap.appendChild(this._renderChurnSection(report.churn));
        wrap.appendChild(this._renderMaintainerSection(report.maintainer));
        wrap.appendChild(this._renderProvenanceSection(report.provenance));
        wrap.appendChild(this._renderFreshnessSection(report.freshness));
        wrap.appendChild(this._renderCadenceSection(report.cadence));
        wrap.appendChild(this._renderTyposquatSection(report.typosquat));
        return wrap;
    }

    /**
     * Typosquat / homoglyph section — silent when the verdict is
     * `exact` or `unrelated` (every legit package lands there and a
     * "✓ no typosquat suspected" line would be pure noise). For
     * warn + risk we surface the closest popular match and the
     * confusable flag explicitly.
     */
    private _renderTyposquatSection(finding: TyposquatFinding): HTMLElement {
        if (finding.level === TyposquatLevel.exact
            || finding.level === TyposquatLevel.unrelated) {
            // Returning an empty <div> keeps the appendChild chain
            // simple while contributing no visible content.
            const empty = document.createElement('div');
            empty.style.display = 'none';
            return empty;
        }

        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = I18n.t('Typosquat / homoglyph check');
        wrap.appendChild(heading);

        const card = document.createElement('div');
        card.className = `pdp-script pdp-script-${finding.level === TyposquatLevel.risk ? 'risk' : 'warn'}`;

        const head = document.createElement('div');
        head.className = 'pdp-script-head';
        const sev = document.createElement('span');
        sev.className = `pdp-sev pdp-sev-${finding.level === TyposquatLevel.risk ? 'risk' : 'warn'}`;
        sev.textContent = finding.level === TyposquatLevel.risk ? 'SQUAT!' : 'SQUAT?';
        head.appendChild(sev);

        if (finding.closestMatch) {
            const target = document.createElement('span');
            target.className = 'pdp-script-hook';
            target.textContent = `${I18n.t('closest popular')}: ${finding.closestMatch}` + (
                finding.distance !== null ? ` (d=${finding.distance})` : ''
            );
            head.appendChild(target);
        }
        card.appendChild(head);

        if (finding.hasConfusables) {
            const flag = document.createElement('div');
            flag.className = 'pdp-script-reason';
            flag.textContent = I18n.t('Name contains non-ASCII characters — homoglyph attack');
            card.appendChild(flag);
        }

        const reason = document.createElement('div');
        reason.className = 'pdp-script-reason';
        reason.textContent = finding.reason;
        card.appendChild(reason);

        wrap.appendChild(card);
        return wrap;
    }

    /**
     * `--ignore-scripts` recommendation banner. Sits right after
     * the Scripts section because it's meta-info about exactly
     * those hooks: should the user globally skip them on install?
     * Renders four distinct verdicts (unaffected / safe / needed /
     * avoid) — each with a unique colour and explicit action.
     */
    private _renderIgnoreScriptsBanner(finding: IgnoreScriptsFinding): HTMLElement {
        const banner = document.createElement('div');
        banner.className = `pdp-ignore pdp-ignore-${finding.level}`;

        const head = document.createElement('div');
        head.className = 'pdp-ignore-head';
        head.textContent = PackageDetailPanel._ignoreScriptsHeadline(finding.level);
        banner.appendChild(head);

        const body = document.createElement('div');
        body.className = 'pdp-ignore-body';
        body.textContent = finding.reason;
        banner.appendChild(body);

        return banner;
    }

    private static _ignoreScriptsHeadline(level: IgnoreScriptsLevel): string {
        switch (level) {
            case IgnoreScriptsLevel.unaffected:
                return I18n.t('--ignore-scripts: nothing to skip');
            case IgnoreScriptsLevel.safeToIgnore:
                return I18n.t('--ignore-scripts: safe to use');
            case IgnoreScriptsLevel.needsScripts:
                return I18n.t('--ignore-scripts: NOT safe — package needs the hook');
            case IgnoreScriptsLevel.avoidScripts:
                return I18n.t('--ignore-scripts: STRONGLY recommended');
        }
    }

    /**
     * Release-cadence section — answers "is this package still
     * alive?". Renders last release age, the median gap between
     * releases over the recent window, and a traffic-light pill.
     */
    private _renderCadenceSection(finding: CadenceFinding|null): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = I18n.t('Release cadence');
        wrap.appendChild(heading);

        if (!finding) {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = I18n.t('No release-history data — registry packument lacks a time map.');
            wrap.appendChild(empty);
            return wrap;
        }

        const card = document.createElement('div');
        card.className = `pdp-script pdp-script-${finding.level}`;

        const head = document.createElement('div');
        head.className = 'pdp-script-head';
        const sev = document.createElement('span');
        sev.className = `pdp-sev pdp-sev-${finding.level}`;
        sev.textContent = PackageDetailPanel._cadenceSeverityLabel(finding.level);
        head.appendChild(sev);
        card.appendChild(head);

        const body = document.createElement('div');
        body.className = 'pdp-fresh-body';

        const lastLine = document.createElement('div');
        lastLine.className = 'pdp-fresh-line';
        lastLine.textContent = finding.daysSinceLastRelease !== null
            ? I18n.t('Last release: {n} days ago', {n: finding.daysSinceLastRelease})
            : I18n.t('Last release: unknown');
        body.appendChild(lastLine);

        const cadenceLine = document.createElement('div');
        cadenceLine.className = 'pdp-fresh-line';
        cadenceLine.textContent = finding.medianCadenceDays !== null
            ? I18n.t('Median cadence: every {n} days over {count} releases', {
                n: finding.medianCadenceDays,
                count: finding.releaseCount
            })
            : I18n.t('Median cadence: not enough releases to compute');
        body.appendChild(cadenceLine);

        card.appendChild(body);

        const reason = document.createElement('div');
        reason.className = 'pdp-script-reason';
        reason.textContent = finding.reason;
        card.appendChild(reason);

        wrap.appendChild(card);
        return wrap;
    }

    private static _cadenceSeverityLabel(level: CadenceLevel): string {
        switch (level) {
            case CadenceLevel.info: return 'ALIVE';
            case CadenceLevel.warn: return 'STALE';
            case CadenceLevel.risk: return 'STALE!';
        }
    }

    /**
     * "Brand new" section — package age + maintainer-account age,
     * each on its own line with traffic-light colouring. Rendered
     * only when at least one signal is available; the heading stays
     * even on null so the user gets a "no data" placeholder rather
     * than wondering whether the scan failed.
     */
    private _renderFreshnessSection(finding: FreshnessFinding|null): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = I18n.t('Brand-new indicators');
        wrap.appendChild(heading);

        if (!finding) {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = I18n.t('No publish-date data available — cannot judge freshness.');
            wrap.appendChild(empty);
            return wrap;
        }

        const card = document.createElement('div');
        card.className = `pdp-script pdp-script-${finding.level}`;

        const head = document.createElement('div');
        head.className = 'pdp-script-head';
        const sev = document.createElement('span');
        sev.className = `pdp-sev pdp-sev-${finding.level}`;
        sev.textContent = PackageDetailPanel._freshnessSeverityLabel(finding.level);
        head.appendChild(sev);
        card.appendChild(head);

        const body = document.createElement('div');
        body.className = 'pdp-fresh-body';

        const pkgLine = document.createElement('div');
        pkgLine.className = 'pdp-fresh-line';
        pkgLine.textContent = finding.packageAgeDays !== null
            ? I18n.t('Package: first published {n} days ago', {n: finding.packageAgeDays})
            : I18n.t('Package: publish date unknown');
        body.appendChild(pkgLine);

        const mntLine = document.createElement('div');
        mntLine.className = 'pdp-fresh-line';
        mntLine.textContent = finding.maintainerAgeDays !== null
            ? I18n.t('Publisher account: {n} days old', {n: finding.maintainerAgeDays})
            : I18n.t('Publisher account: age unknown (registry did not disclose)');
        body.appendChild(mntLine);

        card.appendChild(body);

        const reason = document.createElement('div');
        reason.className = 'pdp-script-reason';
        reason.textContent = finding.reason;
        card.appendChild(reason);

        wrap.appendChild(card);
        return wrap;
    }

    private static _freshnessSeverityLabel(level: FreshnessLevel): string {
        switch (level) {
            case FreshnessLevel.info: return 'OK';
            case FreshnessLevel.warn: return 'NEW';
            case FreshnessLevel.risk: return 'NEW!';
        }
    }

    /**
     * Provenance / signing section. Three states map to three pills:
     *   - `provenance`: green ✓ — Sigstore-anchored, attestation URL
     *     surfaced as a link so the user can verify themselves
     *   - `signed`: grey baseline — npm-registry signature only
     *   - `unsigned`: faint info — no signature at all (very old or
     *     non-npm mirror)
     * `null` (no registry data) renders nothing at all so the section
     * doesn't become "we don't know" noise on cold cache.
     */
    private _renderProvenanceSection(finding: ProvenanceFinding|null): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = I18n.t('Provenance / Signing');
        wrap.appendChild(heading);

        if (!finding) {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = I18n.t('No registry record yet — try again once the cache warms.');
            wrap.appendChild(empty);
            return wrap;
        }

        const card = document.createElement('div');
        card.className = `pdp-script pdp-prov-${finding.level}`;

        const head = document.createElement('div');
        head.className = 'pdp-script-head';

        const pill = document.createElement('span');
        pill.className = `pdp-tfa pdp-prov-pill-${finding.level}`;
        pill.textContent = PackageDetailPanel._provenancePillLabel(finding.level);
        head.appendChild(pill);

        if (finding.signatureCount > 0) {
            const sig = document.createElement('span');
            sig.className = 'pdp-script-reason';
            sig.textContent = I18n.t('{n} registry signature(s)', {n: finding.signatureCount});
            head.appendChild(sig);
        }

        card.appendChild(head);

        const reason = document.createElement('div');
        reason.className = 'pdp-script-reason';
        reason.textContent = PackageDetailPanel._provenanceReason(finding.level);
        card.appendChild(reason);

        if (finding.attestationUrl) {
            const link = document.createElement('a');
            link.className = 'pdp-script-body';
            link.href = finding.attestationUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = finding.attestationUrl;
            card.appendChild(link);
        }

        if (finding.predicateType) {
            const pred = document.createElement('code');
            pred.className = 'pdp-script-body';
            pred.textContent = `predicateType: ${finding.predicateType}`;
            card.appendChild(pred);
        }

        wrap.appendChild(card);
        return wrap;
    }

    private static _provenancePillLabel(level: ProvenanceLevel): string {
        switch (level) {
            case ProvenanceLevel.provenance: return 'PROV ✓';
            case ProvenanceLevel.signed: return 'SIGNED';
            case ProvenanceLevel.unsigned: return 'UNSIGNED';
        }
    }

    private static _provenanceReason(level: ProvenanceLevel): string {
        switch (level) {
            case ProvenanceLevel.provenance:
                return I18n.t('Published with --provenance: Sigstore signs an SLSA attestation binding the tarball to a specific CI workflow + commit.');
            case ProvenanceLevel.signed:
                return I18n.t('Registry-signed only. The npm key proves the tarball came from npm — but not from any specific build job or repo.');
            case ProvenanceLevel.unsigned:
                return I18n.t('No signature at all — typical for very old releases or non-npm mirrors that strip signatures.');
        }
    }

    private static _supplyChainRisk(
        maintainer: MaintainerFinding|null,
        churn: ChurnFinding|null
    ): HTMLElement|null {
        if (!maintainer || maintainer.severity !== MaintainerSeverity.risk) {
            return null;
        }
        if (!churn || churn.severity === ChurnSeverity.info) {
            return null;
        }
        const banner = document.createElement('div');
        banner.className = 'pdp-supply-chain';
        banner.textContent = I18n.t(
            'Possible supply-chain attack: new publisher ({publisher}) + unusual file churn in the same release.',
            {publisher: maintainer.currentPublisher?.name ?? '?'}
        );
        return banner;
    }

    private _renderMaintainerSection(finding: MaintainerFinding|null): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = I18n.t('Maintainer / Publisher');
        wrap.appendChild(heading);

        if (!finding) {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = I18n.t('No registry record — git install or unknown package.');
            wrap.appendChild(empty);
            return wrap;
        }

        const card = document.createElement('div');
        card.className = `pdp-script pdp-script-${finding.severity}`;

        const head = document.createElement('div');
        head.className = 'pdp-script-head';

        const sev = document.createElement('span');
        sev.className = `pdp-sev pdp-sev-${finding.severity}`;
        sev.textContent = PackageDetailPanel._maintainerSeverityLabel(finding.severity);
        head.appendChild(sev);

        const publisher = document.createElement('span');
        publisher.className = 'pdp-script-hook';
        publisher.textContent = finding.currentPublisher?.name ?? '—';
        if (finding.currentPublisher?.email) {
            publisher.title = finding.currentPublisher.email;
        }
        head.appendChild(publisher);

        if (finding.gapDays !== null) {
            const gap = document.createElement('span');
            gap.className = 'pdp-script-reason';
            gap.textContent = I18n.t('{n} days since predecessor', {n: finding.gapDays});
            head.appendChild(gap);
        }

        // 2FA pill — `true` / `false` only render when the registry
        // was willing to answer; `undefined`/`null` (typical on the
        // public mirror) is rendered as a small "?" so the user knows
        // we asked but couldn't tell.
        const tfa = document.createElement('span');
        tfa.className = 'pdp-tfa';
        const tfaState = finding.currentPublisher2FA;
        if (tfaState === true) {
            tfa.classList.add('pdp-tfa-on');
            tfa.textContent = '2FA ✓';
            tfa.title = I18n.t('Publisher account has 2FA enabled');
        } else if (tfaState === false) {
            tfa.classList.add('pdp-tfa-off');
            tfa.textContent = '2FA ✗';
            tfa.title = I18n.t('Publisher account has no 2FA — credential-theft would be enough to publish');
        } else {
            tfa.classList.add('pdp-tfa-unknown');
            tfa.textContent = '2FA ?';
            tfa.title = I18n.t('Registry did not disclose the publisher\'s 2FA state (typical on the public mirror)');
        }
        head.appendChild(tfa);

        card.appendChild(head);

        const reason = document.createElement('div');
        reason.className = 'pdp-script-reason';
        reason.textContent = finding.reason;
        card.appendChild(reason);

        if (finding.trustedPublishers.length > 0) {
            const trust = document.createElement('code');
            trust.className = 'pdp-script-body';
            trust.textContent = I18n.t('Trust set: {names}', {names: finding.trustedPublishers.join(', ')});
            card.appendChild(trust);
        }

        wrap.appendChild(card);
        return wrap;
    }

    private static _maintainerSeverityLabel(s: MaintainerSeverity): string {
        switch (s) {
            case MaintainerSeverity.info: return 'OK';
            case MaintainerSeverity.warn: return 'WARN';
            case MaintainerSeverity.risk: return 'RISK';
        }
    }

    private _renderBinariesSection(findings: BinaryFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${I18n.t('Binaries')} (${findings.length})`;
        wrap.appendChild(heading);

        if (findings.length === 0) {
            return wrap;
        }

        const list = document.createElement('div');
        list.className = 'pdp-scripts';

        for (const b of findings) {
            const card = document.createElement('div');
            card.className = `pdp-script pdp-script-${b.severity}`;

            const head = document.createElement('div');
            head.className = 'pdp-script-head';

            const sev = document.createElement('span');
            sev.className = `pdp-sev pdp-sev-${b.severity}`;
            sev.textContent = PackageDetailPanel._binarySeverityLabel(b.severity);
            head.appendChild(sev);

            const kind = document.createElement('span');
            kind.className = 'pdp-script-hook';
            kind.textContent = b.kind;
            head.appendChild(kind);

            const size = document.createElement('span');
            size.className = 'pdp-script-reason';
            size.textContent = PackageDetailPanel._formatSize(b.size);
            head.appendChild(size);

            card.appendChild(head);

            const code = document.createElement('code');
            code.className = 'pdp-script-body';
            code.textContent = b.path;
            card.appendChild(code);

            list.appendChild(card);
        }

        wrap.appendChild(list);
        return wrap;
    }

    private static _binarySeverityLabel(s: BinarySeverity): string {
        switch (s) {
            case BinarySeverity.info: return 'INFO';
            case BinarySeverity.warn: return 'WARN';
            case BinarySeverity.risk: return 'RISK';
        }
    }

    private static _formatSize(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} kB`;
        }
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    private static _isGitVersion(v: string): boolean {
        return /^(git\+|git:\/\/|git@|github:|gitlab:|bitbucket:)/i.test(v.trim());
    }

    private _renderPatternsSection(findings: PatternFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${I18n.t('Code patterns')} (${findings.length})`;
        wrap.appendChild(heading);

        if (findings.length === 0) {
            return wrap;
        }

        const list = document.createElement('div');
        list.className = 'pdp-scripts';

        for (const f of findings) {
            const card = document.createElement('div');
            card.className = `pdp-script pdp-script-${f.severity}`;

            const head = document.createElement('div');
            head.className = 'pdp-script-head';

            const sev = document.createElement('span');
            sev.className = `pdp-sev pdp-sev-${f.severity}`;
            sev.textContent = PackageDetailPanel._patternSeverityLabel(f.severity);
            head.appendChild(sev);

            const pattern = document.createElement('span');
            pattern.className = 'pdp-script-hook';
            pattern.textContent = f.pattern;
            head.appendChild(pattern);

            const loc = document.createElement('span');
            loc.className = 'pdp-script-reason';
            loc.textContent = `${f.path}:${f.line}`;
            head.appendChild(loc);

            card.appendChild(head);

            const code = document.createElement('code');
            code.className = 'pdp-script-body';
            code.textContent = f.snippet;
            card.appendChild(code);

            list.appendChild(card);
        }

        wrap.appendChild(list);
        return wrap;
    }

    private static _patternSeverityLabel(s: PatternSeverity): string {
        switch (s) {
            case PatternSeverity.info: return 'INFO';
            case PatternSeverity.warn: return 'WARN';
            case PatternSeverity.risk: return 'RISK';
        }
    }

    private _renderChurnSection(churn: ChurnFinding|null): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = I18n.t('File churn (vs. predecessor)');
        wrap.appendChild(heading);

        if (!churn) {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = I18n.t('No predecessor stable in registry or tarball unavailable.');
            wrap.appendChild(empty);
            return wrap;
        }

        const card = document.createElement('div');
        card.className = `pdp-script pdp-script-${churn.severity}`;

        const head = document.createElement('div');
        head.className = 'pdp-script-head';

        const sev = document.createElement('span');
        sev.className = `pdp-sev pdp-sev-${churn.severity}`;
        sev.textContent = PackageDetailPanel._churnSeverityLabel(churn.severity);
        head.appendChild(sev);

        const bump = document.createElement('span');
        bump.className = 'pdp-script-hook';
        bump.textContent = `${churn.previousVersion} → ${churn.bumpType}-bump`;
        head.appendChild(bump);

        card.appendChild(head);

        const reason = document.createElement('div');
        reason.className = 'pdp-script-reason';
        reason.textContent = churn.reason;
        card.appendChild(reason);

        const stats = document.createElement('code');
        stats.className = 'pdp-script-body';
        stats.textContent = `+${churn.added} ${I18n.t('Added')}   ~${churn.modified} ${I18n.t('Modified')}   -${churn.removed} ${I18n.t('Removed')}`;
        card.appendChild(stats);

        wrap.appendChild(card);
        return wrap;
    }

    private static _churnSeverityLabel(s: ChurnSeverity): string {
        switch (s) {
            case ChurnSeverity.info: return 'OK';
            case ChurnSeverity.warn: return 'WARN';
            case ChurnSeverity.risk: return 'RISK';
        }
    }

    private _renderVulnsSection(vulns: OsvVulnerability[]|null): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = vulns === null
            ? 'CVEs — OSV.dev nicht erreichbar'
            : `CVEs (${vulns.length})`;
        wrap.appendChild(heading);

        if (vulns === null || vulns.length === 0) {
            return wrap;
        }

        const list = document.createElement('div');
        list.className = 'pdp-vulns';

        for (const v of vulns) {
            list.appendChild(this._renderVuln(v));
        }

        wrap.appendChild(list);
        return wrap;
    }

    private _renderVuln(v: OsvVulnerability): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pdp-vuln';

        const head = document.createElement('div');
        head.className = 'pdp-vuln-head';

        const id = document.createElement('span');
        id.className = 'pdp-vuln-id';
        id.textContent = v.id;
        head.appendChild(id);

        // First severity score wins for the badge — OSV often lists
        // both CVSS_V3 and the GHSA-derived score; either is fine for a
        // glance.
        if (v.severity.length > 0) {
            const sev = document.createElement('span');
            sev.className = 'pdp-vuln-sev';
            sev.textContent = v.severity[0].score;
            sev.title = v.severity[0].type;
            head.appendChild(sev);
        }

        card.appendChild(head);

        if (v.summary) {
            const sum = document.createElement('div');
            sum.className = 'pdp-vuln-summary';
            sum.textContent = v.summary;
            card.appendChild(sum);
        }

        const link = v.references.find((r) => r.url);
        if (link) {
            const a = document.createElement('a');
            a.className = 'pdp-vuln-link';
            a.href = link.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = link.url;
            card.appendChild(a);
        }

        return card;
    }

    private _renderScriptsSection(findings: ScriptFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${I18n.t('Install-scripts')} (${findings.length})`;
        wrap.appendChild(heading);

        if (findings.length === 0) {
            return wrap;
        }

        const list = document.createElement('div');
        list.className = 'pdp-scripts';

        for (const f of findings) {
            const card = document.createElement('div');
            card.className = `pdp-script pdp-script-${f.severity}`;

            const head = document.createElement('div');
            head.className = 'pdp-script-head';

            const sev = document.createElement('span');
            sev.className = `pdp-sev pdp-sev-${f.severity}`;
            sev.textContent = PackageDetailPanel._severityLabel(f.severity);
            head.appendChild(sev);

            const hook = document.createElement('span');
            hook.className = 'pdp-script-hook';
            hook.textContent = f.hook;
            head.appendChild(hook);

            card.appendChild(head);

            const reason = document.createElement('div');
            reason.className = 'pdp-script-reason';
            reason.textContent = f.reason;
            card.appendChild(reason);

            const code = document.createElement('code');
            code.className = 'pdp-script-body';
            code.textContent = f.script;
            card.appendChild(code);

            list.appendChild(card);
        }

        wrap.appendChild(list);
        return wrap;
    }

    private static _severityLabel(s: ScriptSeverity): string {
        switch (s) {
            case ScriptSeverity.info: return 'INFO';
            case ScriptSeverity.warn: return 'WARN';
            case ScriptSeverity.risk: return 'RISK';
        }
    }

    private _renderDiffTab(): void {
        if (!this._tabPane || !this._fingerprint || !this._diffTarget) {
            return;
        }

        if (this._diffCache) {
            this._tabPane.appendChild(this._renderDiffBody(this._diffCache));
            return;
        }

        if (this._diffError) {
            const err = document.createElement('div');
            err.className = 'pdp-error';
            err.textContent = this._diffError;
            this._tabPane.appendChild(err);
            return;
        }

        // Lazy fetch on first activation.
        const loading = document.createElement('div');
        loading.className = 'pdp-placeholder';
        loading.textContent = I18n.t('Loading diff …');
        this._tabPane.appendChild(loading);

        const name = this._fingerprint.name;
        const before = this._fingerprint.version;
        const after = this._diffTarget;

        void Api.fingerprintDiff(name, before, after).then((response) => {
            if (this._activeTab !== Tab.diff || !this._tabPane) {
                return;
            }

            if (!response.diff) {
                this._diffError = I18n.t('One of the two versions is unavailable.');
            } else {
                this._diffCache = response.diff;
            }

            this._renderActiveTab();
        }).catch((e: Error) => {
            this._diffError = e.message;
            if (this._activeTab === Tab.diff) {
                this._renderActiveTab();
            }
        });
    }

    private _renderDiffBody(diff: FingerprintDiff): HTMLElement {
        const wrap = document.createElement('div');
        wrap.appendChild(this._renderDiffSection(I18n.t('Added'), diff.added, 'added'));
        wrap.appendChild(this._renderDiffSection(I18n.t('Removed'), diff.removed, 'removed'));
        wrap.appendChild(this._renderModifiedSection(diff));
        return wrap;
    }

    private _renderFileList(files: FileFingerprint[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${I18n.t('Files')} (${files.length})`;
        wrap.appendChild(heading);

        const list = document.createElement('div');
        list.className = 'pdp-list';

        for (const f of files) {
            const row = document.createElement('div');
            row.className = 'pdp-row';

            const p = document.createElement('span');
            p.className = 'pdp-row-path';
            p.textContent = f.path;

            const s = document.createElement('span');
            s.className = 'pdp-row-size';
            s.textContent = PackageDetailPanel._formatSize(f.size);

            const h = document.createElement('span');
            h.className = 'pdp-row-hash';
            h.title = f.sha256;
            h.textContent = f.sha256.slice(0, 12);

            row.appendChild(p);
            row.appendChild(s);
            row.appendChild(h);
            list.appendChild(row);
        }

        wrap.appendChild(list);
        return wrap;
    }

    private _renderDiffSection(label: string, files: FileFingerprint[], cls: string): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = `pdp-section pdp-section-${cls}`;

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${label} (${files.length})`;
        wrap.appendChild(heading);

        if (files.length === 0) {
            return wrap;
        }

        const list = document.createElement('div');
        list.className = 'pdp-list';

        for (const f of files) {
            const row = document.createElement('div');
            row.className = `pdp-row pdp-row-${cls}`;
            row.textContent = `${f.path}  (${PackageDetailPanel._formatSize(f.size)})`;
            list.appendChild(row);
        }

        wrap.appendChild(list);
        return wrap;
    }

    private _renderModifiedSection(diff: FingerprintDiff): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section pdp-section-modified';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${I18n.t('Modified')} (${diff.modified.length})`;
        wrap.appendChild(heading);

        if (diff.modified.length === 0) {
            return wrap;
        }

        const list = document.createElement('div');
        list.className = 'pdp-list';

        for (const m of diff.modified) {
            const row = document.createElement('div');
            row.className = 'pdp-row pdp-row-modified';
            row.textContent =
                `${m.path}  (${PackageDetailPanel._formatSize(m.before.size)} → ${PackageDetailPanel._formatSize(m.after.size)})`;
            row.title = `${m.before.sha256}\n→\n${m.after.sha256}`;
            list.appendChild(row);
        }

        wrap.appendChild(list);
        return wrap;
    }
}

// `PackageFingerprintManifest` is re-exported so consumers that touch
// the panel's contract don't need to import from two places.
export type {PackageFingerprintManifest};