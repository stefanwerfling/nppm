import {
    FileFingerprint,
    FingerprintDiff,
    PackageFingerprint,
    PackageFingerprintManifest
} from '../Fingerprint/Fingerprint.js';
import {Release, ReleasesResponse} from '../Releases/Releases.js';
import {BinaryFinding, BinarySeverity} from '../Security/BinaryScanner.js';
import {ChurnFinding, ChurnSeverity} from '../Security/ChurnScanner.js';
import {OsvVulnerability} from '../Security/OsvClient.js';
import {PatternFinding, PatternSeverity} from '../Security/PatternScanner.js';
import {ScriptFinding, ScriptSeverity} from '../Security/ScriptScanner.js';
import {SecurityReport} from '../Security/SecurityScanner.js';
import {Api} from './Api.js';
import {t} from './I18n.js';
import {cleanRange} from './Version.js';

function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} kB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

enum Tab {
    files = 'files',
    deps = 'deps',
    diff = 'diff',
    releases = 'releases',
    security = 'security'
}

/**
 * Modal-ish detail view for one `pkg@version` with three tabs:
 *  - Dateien: per-file SHA-256 + size of the tarball
 *  - Abhängigkeiten: dep/devDep/peer/optional declared by the package itself
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
        const version = cleanRange(rawVersion);
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
                this._renderEmpty(t('{name} is not available on the registry.', {name: `${name}@${version}`}));
                return;
            }

            this._fingerprint = response.fingerprint;

            const cleanedLatest = latest ? cleanRange(latest) : null;
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
        this._body.innerHTML = `<div class="pdp-placeholder">${t('Loading fingerprint …')}</div>`;
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
            {value: Tab.files, label: t('Files')},
            {value: Tab.deps, label: t('Dependencies')},
            {value: Tab.diff, label: this._diffTarget
                ? t('Diff against {target}', {target: this._diffTarget})
                : t('Diff')},
            {value: Tab.releases, label: t('Releases')},
            {value: Tab.security, label: this._securityTabLabel()}
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
                btn.title = t('No comparison version available (cell version = latest or latest unknown)');
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
        }
    }

    private _securityTabLabel(): string {
        // Adds a count badge to the tab once the report has loaded —
        // e.g. "Sicherheit (3)". The user can see "is there anything in
        // there" without clicking. Churn counts when severity > info.
        if (!this._securityReport) {
            return t('Security');
        }
        const v = this._securityReport.vulns?.length ?? 0;
        const s = this._securityReport.scriptFindings.length;
        const p = this._securityReport.patternFindings.length;
        const b = this._securityReport.binaryFindings.length;
        const c = this._securityReport.churn && this._securityReport.churn.severity !== ChurnSeverity.info ? 1 : 0;
        const n = v + s + p + b + c;
        return n > 0 ? `${t('Security')} (${n})` : t('Security');
    }

    private _renderFilesTab(fp: PackageFingerprint): HTMLElement {
        const wrap = document.createElement('div');
        const totalSize = fp.files.reduce((sum, f) => sum + f.size, 0);

        const summary = document.createElement('div');
        summary.className = 'pdp-summary';
        summary.innerHTML = `
            <span class="pdp-stat"><strong>${fp.files.length}</strong> ${t('Files')}</span>
            <span class="pdp-stat"><strong>${formatSize(totalSize)}</strong></span>
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
            empty.textContent = t('No package.json found in tarball.');
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
            empty.textContent = t('No declared dependencies in this package.');
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
        loading.textContent = t('Loading releases …');
        this._tabPane.appendChild(loading);

        if (this._releasesInflight) {
            return;
        }
        this._releasesInflight = true;
        const name = this._fingerprint.name;

        void Api.releases(name).then((response) => {
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
            empty.textContent = t('No published versions.');
            wrap.appendChild(empty);
            return wrap;
        }

        const hasAnyBody = data.releases.some((r) => r.body || r.name);
        if (!hasAnyBody && data.repository) {
            const hint = document.createElement('div');
            hint.className = 'pdp-releases-hint';
            hint.textContent = t('No GitHub release notes found — only npm publish dates available.');
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
        loading.textContent = t('Scanning CVEs and install scripts …');
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
            note.textContent = t(
                'Git package: OSV.dev only indexes registry-installed versions. Script + code-pattern heuristics still ran.'
            );
            wrap.appendChild(note);
        }

        const vulnCount = report.vulns?.length ?? 0;
        const scriptCount = report.scriptFindings.length;
        const patternCount = report.patternFindings.length;
        const binaryCount = report.binaryFindings.length;
        const interestingChurn = report.churn && report.churn.severity !== ChurnSeverity.info;

        if (vulnCount === 0 && scriptCount === 0 && patternCount === 0 && binaryCount === 0
            && !interestingChurn && report.vulns !== null) {
            const ok = document.createElement('div');
            ok.className = 'pdp-placeholder';
            ok.textContent = t('No known CVEs (OSV.dev), no suspicious install scripts, no notable file churn, no known code patterns and no binary files.');
            wrap.appendChild(ok);
            return wrap;
        }

        wrap.appendChild(this._renderVulnsSection(report.vulns));
        wrap.appendChild(this._renderScriptsSection(report.scriptFindings));
        wrap.appendChild(this._renderPatternsSection(report.patternFindings));
        wrap.appendChild(this._renderBinariesSection(report.binaryFindings));
        wrap.appendChild(this._renderChurnSection(report.churn));
        return wrap;
    }

    private _renderBinariesSection(findings: BinaryFinding[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${t('Binaries')} (${findings.length})`;
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
        heading.textContent = `${t('Code patterns')} (${findings.length})`;
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
        heading.textContent = t('File churn (vs. predecessor)');
        wrap.appendChild(heading);

        if (!churn) {
            const empty = document.createElement('div');
            empty.className = 'pdp-placeholder';
            empty.textContent = t('No predecessor stable in registry or tarball unavailable.');
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
        stats.textContent = `+${churn.added} ${t('Added')}   ~${churn.modified} ${t('Modified')}   -${churn.removed} ${t('Removed')}`;
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
        heading.textContent = `${t('Install-scripts')} (${findings.length})`;
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
        loading.textContent = t('Loading diff …');
        this._tabPane.appendChild(loading);

        const name = this._fingerprint.name;
        const before = this._fingerprint.version;
        const after = this._diffTarget;

        void Api.fingerprintDiff(name, before, after).then((response) => {
            if (this._activeTab !== Tab.diff || !this._tabPane) {
                return;
            }

            if (!response.diff) {
                this._diffError = t('One of the two versions is unavailable.');
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
        wrap.appendChild(this._renderDiffSection(t('Added'), diff.added, 'added'));
        wrap.appendChild(this._renderDiffSection(t('Removed'), diff.removed, 'removed'));
        wrap.appendChild(this._renderModifiedSection(diff));
        return wrap;
    }

    private _renderFileList(files: FileFingerprint[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'pdp-section';

        const heading = document.createElement('div');
        heading.className = 'pdp-section-head';
        heading.textContent = `${t('Files')} (${files.length})`;
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
            s.textContent = formatSize(f.size);

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
            row.textContent = `${f.path}  (${formatSize(f.size)})`;
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
        heading.textContent = `${t('Modified')} (${diff.modified.length})`;
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
                `${m.path}  (${formatSize(m.before.size)} → ${formatSize(m.after.size)})`;
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