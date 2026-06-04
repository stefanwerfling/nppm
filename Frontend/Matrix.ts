import {ApiBulkUpgradePick, ApiBundleEntry, ApiMatrixIntegrityEntry} from '../Api/ApiTypes.js';
import {ConfigProjectType} from '../Config/Config.js';
import {DependencyType} from '../Project/PackageManifest.js';
import {MatrixResponse, MatrixRow, MatrixRowStatus} from '../Matrix/MatrixBuilder.js';
import {BinarySeverity, BinarySummary} from '../Security/BinaryScanner.js';
import {CadenceLevel, CadenceSummary} from '../Security/CadenceScanner.js';
import {FreshnessLevel, FreshnessSummary} from '../Security/FreshnessScanner.js';
import {IntegritySeverity} from '../Security/IntegrityScanner.js';
import {LicenseSeverity, LicenseSummary} from '../Security/LicenseScanner.js';
import {MaintainerSeverity, MaintainerSummary} from '../Security/MaintainerScanner.js';
import {PatternSeverity} from '../Security/PatternScanner.js';
import {ProvenanceLevel, ProvenanceSummary} from '../Security/ProvenanceScanner.js';
import {ScriptSeverity} from '../Security/ScriptScanner.js';
import {DeprecationLevel, DeprecationSummary} from '../Security/DeprecationScanner.js';
import {ExternalSeverity, ExternalSummary} from '../Security/ExternalSourcesScanner.js';
import {CapabilitySeverity, CapabilitySummary} from '../Security/CapabilityScanner.js';
import {ManifestRedFlagSeverity, ManifestRedFlagsSummary} from '../Security/ManifestRedFlagsScanner.js';
import {ObfuscationSeverity, ObfuscationSummary} from '../Security/ObfuscationScanner.js';
import {TyposquatLevel, TyposquatSummary} from '../Security/TyposquatScanner.js';
import {PatternSummary, ScriptSummary} from '../Security/SecurityScanner.js';
import {Api} from './Api.js';
import {I18n} from './I18n.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {Version} from './Version.js';

/**
 * Filter mode buttons above the matrix.
 *  - all: every row
 *  - drift: only rows where projects disagree
 *  - outdated: only rows behind registry latest
 *  - issues: drift ∪ outdated (everything that needs attention)
 *  - insecure: any row with CVE or risky install script
 */
export enum MatrixFilter {
    all = 'all',
    drift = 'drift',
    outdated = 'outdated',
    issues = 'issues',
    insecure = 'insecure',
    /**
     * Compliance filter: shows rows whose latest version's license is
     * problematic for typical commercial use — strong copyleft (GPL/
     * AGPL), proprietary, or unknown. Permissive + weak-copyleft are
     * hidden because legal teams usually pre-approve those buckets.
     */
    licenseIssue = 'license-issue'
}

/**
 * Row sort modes. `name` (default) is plain alphabetic. `status` puts
 * the most urgent rows at the top: drift > outdated > unknown > aligned,
 * with name as the tie-breaker. `severity` ranks by the aggregated
 * security score (CVE count + script severity) so the riskiest
 * packages float up regardless of drift state.
 */
export enum MatrixSort {
    name = 'name',
    status = 'status',
    severity = 'severity'
}

const STATUS_RANK: Record<MatrixRowStatus, number> = {
    [MatrixRowStatus.drift]: 0,
    [MatrixRowStatus.outdated]: 1,
    [MatrixRowStatus.unknown]: 2,
    [MatrixRowStatus.aligned]: 3
};

/**
 * Per-severity weight tables consumed by `Matrix._severityScore`.
 * Module-level for cheap-and-shared access; the score function lives
 * as a private static on the `Matrix` class.
 */
const SCRIPT_WEIGHT: Record<ScriptSeverity, number> = {
    [ScriptSeverity.info]: 1,
    [ScriptSeverity.warn]: 5,
    [ScriptSeverity.risk]: 20
};

const PATTERN_WEIGHT: Record<PatternSeverity, number> = {
    [PatternSeverity.info]: 1,
    [PatternSeverity.warn]: 3,
    [PatternSeverity.risk]: 15
};

const BINARY_WEIGHT: Record<BinarySeverity, number> = {
    [BinarySeverity.info]: 1,
    [BinarySeverity.warn]: 5,
    [BinarySeverity.risk]: 20
};

const MAINTAINER_WEIGHT: Record<MaintainerSeverity, number> = {
    [MaintainerSeverity.info]: 0,
    [MaintainerSeverity.warn]: 5,
    [MaintainerSeverity.risk]: 25
};

const INTEGRITY_WEIGHT: Record<IntegritySeverity, number> = {
    [IntegritySeverity.info]: 0,
    [IntegritySeverity.warn]: 8,
    [IntegritySeverity.risk]: 30
};

const FRESHNESS_WEIGHT: Record<FreshnessLevel, number> = {
    [FreshnessLevel.info]: 0,
    [FreshnessLevel.warn]: 5,
    [FreshnessLevel.risk]: 20
};

const CADENCE_WEIGHT: Record<CadenceLevel, number> = {
    [CadenceLevel.info]: 0,
    [CadenceLevel.warn]: 3,
    [CadenceLevel.risk]: 12
};

const TYPOSQUAT_WEIGHT: Record<TyposquatLevel, number> = {
    [TyposquatLevel.exact]: 0,
    [TyposquatLevel.unrelated]: 0,
    [TyposquatLevel.warn]: 10,
    [TyposquatLevel.risk]: 35
};

const EXTERNAL_WEIGHT: Record<ExternalSeverity, number> = {
    [ExternalSeverity.info]: 0,
    [ExternalSeverity.warn]: 4,
    [ExternalSeverity.risk]: 15
};

const DEPRECATION_WEIGHT: Record<DeprecationLevel, number> = {
    [DeprecationLevel.info]: 0,
    [DeprecationLevel.warn]: 6,
    [DeprecationLevel.risk]: 18
};

const OBFUSCATION_WEIGHT: Record<ObfuscationSeverity, number> = {
    [ObfuscationSeverity.info]: 0,
    [ObfuscationSeverity.warn]: 8,
    [ObfuscationSeverity.risk]: 25
};

const MANIFEST_REDFLAGS_WEIGHT: Record<ManifestRedFlagSeverity, number> = {
    [ManifestRedFlagSeverity.info]: 0,
    [ManifestRedFlagSeverity.warn]: 3,
    [ManifestRedFlagSeverity.risk]: 12
};

const CAPABILITY_WEIGHT: Record<CapabilitySeverity, number> = {
    [CapabilitySeverity.info]: 0,
    [CapabilitySeverity.warn]: 4,
    [CapabilitySeverity.risk]: 15
};

/**
 * Catalogue of every badge the matrix can render alongside a package
 * name. The Badge-Filter modal uses this to enumerate checkboxes; the
 * Matrix.render path uses `id` to gate each badge emit through
 * `_isBadgeVisible`. Order here is the display order in the modal
 * (group reputation / supply-chain / quality), not the rendering
 * order in the row (which the badge emits choose independently).
 */
export type MatrixBadgeId =
    | 'cve'
    | 'license'
    | 'script'
    | 'pattern'
    | 'binary'
    | 'maintainer'
    | 'integrity'
    | 'provenance'
    | 'freshness'
    | 'cadence'
    | 'typosquat'
    | 'external'
    | 'obfuscation'
    | 'manifestRedFlags'
    | 'capability'
    | 'deprecation';

export type MatrixBadgeMeta = {
    id: MatrixBadgeId;
    /**
     * Human-readable label rendered in the filter modal. Translated
     * via `I18n.t()` at render time.
     */
    label: string;
    /**
     * Sample text rendered inside a styled sample badge — usually the
     * strongest-variant label (e.g. `DEP!` instead of `DEP?`) so the
     * user sees the "alert" colour the badge actually uses.
     */
    sampleText: string;
    /**
     * Concatenated `class` value applied to the sample `<span>` — full
     * `matrix-badge matrix-badge-<id>[ matrix-badge-<id>-<sev>]`
     * so the CSS pulls in the correct colour family.
     */
    sampleClasses: string;
    /**
     * One-line explanation of what the badge means. Translated via
     * `I18n.t()` at render time.
     */
    description: string;
};

export const MATRIX_BADGES: MatrixBadgeMeta[] = [
    {id: 'cve', label: 'CVE',
        sampleText: '5 CVEs', sampleClasses: 'matrix-badge matrix-badge-cve',
        description: 'Known vulnerabilities from OSV.dev affecting this name@version.'},
    {id: 'license', label: 'License',
        sampleText: 'UNLIC', sampleClasses: 'matrix-badge matrix-badge-license matrix-badge-license-proprietary',
        description: 'License classification (strong-copyleft, proprietary, unknown).'},
    {id: 'script', label: 'Install scripts',
        sampleText: 'SCRIPT!', sampleClasses: 'matrix-badge matrix-badge-script matrix-badge-script-risk',
        description: 'Lifecycle scripts that fetch the network or exec child processes.'},
    {id: 'pattern', label: 'Code patterns',
        sampleText: '3 patterns', sampleClasses: 'matrix-badge matrix-badge-pattern',
        description: 'Regex hits on risky JS patterns (eval, child_process, webhook URLs, env reads…).'},
    {id: 'binary', label: 'Binaries',
        sampleText: '2 bins', sampleClasses: 'matrix-badge matrix-badge-binary',
        description: 'Native binary files shipped inside the tarball.'},
    {id: 'maintainer', label: 'Maintainer',
        sampleText: 'MAINT!', sampleClasses: 'matrix-badge matrix-badge-maintainer',
        description: 'Publisher handover on a mature package — the event-stream / ua-parser-js takeover pattern.'},
    {id: 'integrity', label: 'Integrity',
        sampleText: 'INT!', sampleClasses: 'matrix-badge matrix-badge-integrity',
        description: 'Lockfile integrity hash mismatches the registry — possible mirror hijack.'},
    {id: 'provenance', label: 'Provenance',
        sampleText: 'PROV ✓', sampleClasses: 'matrix-badge matrix-badge-provenance',
        description: 'Latest version was published with `--provenance` (Sigstore-anchored CI attestation).'},
    {id: 'freshness', label: 'Freshness',
        sampleText: 'NEW!', sampleClasses: 'matrix-badge matrix-badge-freshness matrix-badge-freshness-risk',
        description: 'Brand-new package or brand-new publisher — the classic typosquat profile.'},
    {id: 'cadence', label: 'Release cadence',
        sampleText: 'STALE!', sampleClasses: 'matrix-badge matrix-badge-cadence matrix-badge-cadence-risk',
        description: 'Very stale or unusually bursty release cadence — abandoned or volatile project.'},
    {id: 'typosquat', label: 'Typosquat',
        sampleText: 'SQUAT!', sampleClasses: 'matrix-badge matrix-badge-typosquat matrix-badge-typosquat-risk',
        description: 'Name is Levenshtein-1 away from a popular package or contains Unicode confusables.'},
    {id: 'external', label: 'External sources',
        sampleText: 'EXT!', sampleClasses: 'matrix-badge matrix-badge-external matrix-badge-external-risk',
        description: 'Worst-of-three from socket.dev, OpenSSF Scorecard, deps.dev.'},
    {id: 'obfuscation', label: 'Obfuscation',
        sampleText: 'OBF!', sampleClasses: 'matrix-badge matrix-badge-obfuscation matrix-badge-obfuscation-risk',
        description: 'JS file looks intentionally obfuscated (eval(atob(…)), hex-string arrays, etc.).'},
    {id: 'manifestRedFlags', label: 'Manifest red-flags',
        sampleText: 'MAN!', sampleClasses: 'matrix-badge matrix-badge-manifestRedFlags matrix-badge-manifestRedFlags-risk',
        description: 'package.json heuristics: missing README/description/files, many bins, native+postinstall combo.'},
    {id: 'capability', label: 'Capabilities',
        sampleText: 'CAP!', sampleClasses: 'matrix-badge matrix-badge-capability matrix-badge-capability-risk',
        description: 'Dangerous capability combinations (child_process + network, env-read + network, …).'},
    {id: 'deprecation', label: 'Deprecation',
        sampleText: 'DEP!', sampleClasses: 'matrix-badge matrix-badge-deprecation matrix-badge-deprecation-risk',
        description: 'Installed version (risk) or latest (warn) was marked deprecated by the maintainer.'}
];

/**
 * Persisted UI state — keeps filter, sort, and search across reloads
 * via localStorage. Stored as one JSON blob so we can extend later
 * without touching every reader.
 */
const STATE_STORAGE_KEY = 'nppm.matrix.state.v1';

type StoredMatrixState = {
    filter?: MatrixFilter;
    sort?: MatrixSort;
    search?: string;
    /**
     * IDs of badges the user explicitly hid via the Badge-Filter
     * modal. Empty / absent = all badges visible (the default). Stored
     * as an array because Set is not JSON-serialisable.
     */
    hiddenBadges?: MatrixBadgeId[];
};

/**
 * Renders the cross-project dependency grid. Rows = packages, columns
 * = configured projects + a trailing "Latest" column from the
 * registry.
 */
export class Matrix {

    private readonly _root: HTMLElement;
    private _data: MatrixResponse|null = null;
    private _filter: MatrixFilter = MatrixFilter.all;
    private _sort: MatrixSort = MatrixSort.name;
    /**
     * Badges the user explicitly hid via the Badge-Filter modal.
     * Default empty = every badge renders. Mutated through
     * `setHiddenBadges()` so the persistence + re-render stay
     * coupled.
     */
    private _hiddenBadges: Set<MatrixBadgeId> = new Set();
    private _search: string = '';
    private _onProjectClick: ((unid: string) => void)|null = null;
    private _onCellClick: ((pkg: string, version: string, latest: string|null) => void)|null = null;
    private _onWorkspaceDriftClick: ((projectUnid: string, projectName: string, packageName: string) => void)|null = null;
    private _onScoresChanged: ((scores: Map<string, number>) => void)|null = null;
    private _onSecurityClick: ((pkg: string, version: string) => void)|null = null;
    private _onBadgeFilterClick: (() => void)|null = null;
    private _onBulkUpgradeClick: ((picks: ApiBulkUpgradePick[]) => void)|null = null;
    // Multi-select state for the cross-project Bulk-Upgrade Wizard.
    // Keyed by `${unid}|${pkg}` — workspace is always root in the global
    // matrix (cells aggregate workspaces), so the key collapses to that
    // pair. Cleared on `setData`.
    private _selected: Map<string, ApiBulkUpgradePick> = new Map();
    // Cached batched vuln lookups, keyed by package name (we always
    // batch against `latest`, so the version is implicit). `null` means
    // OSV failed for that package; `[]` means "asked, no vulns".
    private _vulnsByName: Map<string, string[]|null> = new Map();
    // Cached script summaries, same keying as `_vulnsByName`. Populated
    // by the (slow on cold start) /api/matrix/heuristics endpoint.
    private _scriptsByName: Map<string, ScriptSummary> = new Map();
    private _patternsByName: Map<string, PatternSummary> = new Map();
    private _binariesByName: Map<string, BinarySummary> = new Map();
    private _maintainersByName: Map<string, MaintainerSummary> = new Map();
    private _licensesByName: Map<string, LicenseSummary> = new Map();
    private _provenanceByName: Map<string, ProvenanceSummary> = new Map();
    private _freshnessByName: Map<string, FreshnessSummary> = new Map();
    private _cadenceByName: Map<string, CadenceSummary> = new Map();
    private _typosquatByName: Map<string, TyposquatSummary> = new Map();
    private _externalByName: Map<string, ExternalSummary> = new Map();
    private _deprecationByName: Map<string, DeprecationSummary> = new Map();
    private _obfuscationByName: Map<string, ObfuscationSummary> = new Map();
    private _manifestRedFlagsByName: Map<string, ManifestRedFlagsSummary> = new Map();
    private _capabilityByName: Map<string, CapabilitySummary> = new Map();
    // Bundlephobia size keyed by package name (we always query against
    // `latest`, so the version is implicit). `null` means asked-and-
    // unbuildable; missing key means not yet asked.
    private _bundlesByName: Map<string, ApiBundleEntry> = new Map();
    // Per-name aggregated integrity status, loaded once after `setData`.
    // Missing key means "not yet asked" or "no finding"; present key
    // carries the worst severity any project's lockfile reported.
    private _integrityByName: Map<string, ApiMatrixIntegrityEntry> = new Map();
    // Generation counter so a late security response from a previous
    // `setData` call cannot overwrite a newer matrix.
    private _securityGen: number = 0;

    constructor(root: HTMLElement) {
        this._root = root;

        const state = Matrix._loadState();
        if (state.filter) {
            this._filter = state.filter;
        }
        if (state.sort) {
            this._sort = state.sort;
        }
        if (typeof state.search === 'string') {
            this._search = state.search;
        }
        if (Array.isArray(state.hiddenBadges)) {
            // Trust nothing from localStorage — a badge id that no
            // longer exists in the catalogue is silently dropped so
            // a deleted scanner doesn't leak hidden state forever.
            const known = new Set<MatrixBadgeId>(MATRIX_BADGES.map((b) => b.id));
            for (const id of state.hiddenBadges) {
                if (known.has(id)) {
                    this._hiddenBadges.add(id);
                }
            }
        }
    }

    /**
     * Get the current set of hidden badge ids. Returned as a fresh
     * Set so the caller can iterate without worrying about mutation.
     */
    public getHiddenBadges(): Set<MatrixBadgeId> {
        return new Set(this._hiddenBadges);
    }

    /**
     * Replace the hidden-badges set in one shot. Persists + re-renders
     * the table; the toolbar button doesn't need its own re-render
     * because the filter modal closes itself.
     */
    public setHiddenBadges(ids: Set<MatrixBadgeId>): void {
        this._hiddenBadges = new Set(ids);
        this._persist();
        this._rerenderTable();
    }

    private _isBadgeVisible(id: MatrixBadgeId): boolean {
        return !this._hiddenBadges.has(id);
    }

    private _persist(): void {
        Matrix._saveState({
            filter: this._filter,
            sort: this._sort,
            search: this._search,
            hiddenBadges: [...this._hiddenBadges]
        });
    }

    private static _loadState(): StoredMatrixState {
        try {
            const raw = localStorage.getItem(STATE_STORAGE_KEY);
            return raw ? JSON.parse(raw) as StoredMatrixState : {};
        } catch {
            return {};
        }
    }

    private static _saveState(state: StoredMatrixState): void {
        try {
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
        } catch {
            // localStorage may be disabled (private mode etc) — best effort.
        }
    }

    /**
     * Weighted aggregate of CVE + heuristic severities. Higher =
     * worse. Designed so one CVE outweighs a benign-but-present
     * prepare-script (10 vs 1) and a single risky postinstall outweighs
     * a CVE (20 vs 10). Score is computed against whatever heuristic
     * data has arrived; absent pieces contribute 0 — the badge
     * progressively gets more accurate as the lazy batch endpoints
     * settle.
     */
    private static _severityScore(
        vulnIds: string[]|null|undefined,
        scripts: ScriptSummary|undefined,
        patterns: PatternSummary|undefined,
        binaries: BinarySummary|undefined,
        maintainer: MaintainerSummary|undefined,
        integrity: ApiMatrixIntegrityEntry|undefined,
        freshness: FreshnessSummary|undefined,
        cadence: CadenceSummary|undefined,
        typosquat: TyposquatSummary|undefined,
        external: ExternalSummary|undefined,
        deprecation: DeprecationSummary|undefined,
        obfuscation: ObfuscationSummary|undefined,
        manifestRedFlags: ManifestRedFlagsSummary|undefined,
        capability: CapabilitySummary|undefined
    ): number {
        let score = 0;
        if (vulnIds && vulnIds.length > 0) {
            score += vulnIds.length * 10;
        }
        if (scripts && scripts.maxSeverity !== null) {
            score += SCRIPT_WEIGHT[scripts.maxSeverity];
        }
        if (patterns && patterns.maxSeverity !== null) {
            // count multiplied by per-finding weight, capped at one
            // full "risk hit" — otherwise a noisy library (50
            // child_process refs) dominates the sort and drowns out
            // the true outliers.
            const perWeight = PATTERN_WEIGHT[patterns.maxSeverity];
            score += Math.min(patterns.count, 5) * perWeight;
        }
        if (binaries && binaries.maxSeverity !== null) {
            score += BINARY_WEIGHT[binaries.maxSeverity];
        }
        if (maintainer && maintainer.severity !== null) {
            score += MAINTAINER_WEIGHT[maintainer.severity];
        }
        if (integrity && integrity.severity !== null) {
            score += INTEGRITY_WEIGHT[integrity.severity];
        }
        if (freshness && freshness.level !== null) {
            score += FRESHNESS_WEIGHT[freshness.level];
        }
        if (cadence && cadence.level !== null) {
            score += CADENCE_WEIGHT[cadence.level];
        }
        if (typosquat && typosquat.level !== null) {
            score += TYPOSQUAT_WEIGHT[typosquat.level];
        }
        if (external && external.level !== null) {
            score += EXTERNAL_WEIGHT[external.level];
        }
        if (deprecation && deprecation.level !== null) {
            score += DEPRECATION_WEIGHT[deprecation.level];
        }
        if (obfuscation && obfuscation.maxSeverity !== null) {
            score += OBFUSCATION_WEIGHT[obfuscation.maxSeverity];
        }
        if (manifestRedFlags && manifestRedFlags.severity !== null) {
            score += MANIFEST_REDFLAGS_WEIGHT[manifestRedFlags.severity];
        }
        if (capability && capability.severity !== null) {
            score += CAPABILITY_WEIGHT[capability.severity];
        }
        return score;
    }

    public onProjectClick(handler: (unid: string) => void): void {
        this._onProjectClick = handler;
    }

    public onCellClick(handler: (pkg: string, version: string, latest: string|null) => void): void {
        this._onCellClick = handler;
    }

    public onWorkspaceDriftClick(
        handler: (projectUnid: string, projectName: string, packageName: string) => void
    ): void {
        this._onWorkspaceDriftClick = handler;
    }

    /**
     * Fires every time the matrix re-renders with fresh security or
     * heuristic data — i.e. as the asynchronous CVE / script /
     * pattern / maintainer / integrity / … badge loaders settle. The
     * Treeview consumes the scores to render the per-project health
     * ring; firing on every update gives a live "filling in" effect
     * instead of one blocking wait.
     */
    public onScoresChanged(handler: (scores: Map<string, number>) => void): void {
        this._onScoresChanged = handler;
    }

    /**
     * Aggregate per-package severity scores into a 0–100 health
     * value per project. The package score is capped at 30 (the
     * "risk" tier weight in `_severityScore`) so a single very
     * loud package can't dominate the whole project's number, then
     * averaged across the project's package count. The result
     * inverts to "health %": 100 = every package clean, 0 = every
     * package capped at risk.
     *
     * Returns an empty map when matrix data hasn't loaded yet —
     * callers should keep the previous scores visible until the
     * next emit.
     */
    public computeProjectScores(): Map<string, number> {
        const out = new Map<string, number>();
        if (!this._data) {
            return out;
        }
        const totals = new Map<string, {score: number; count: number}>();
        for (const project of this._data.projects) {
            totals.set(project.unid, {score: 0, count: 0});
        }
        const PACKAGE_CAP = 30;
        for (const row of this._data.rows) {
            const rowScore = Math.min(this._scoreFor(row), PACKAGE_CAP);
            for (const unid of Object.keys(row.cells)) {
                const t = totals.get(unid);
                if (!t) {
                    continue;
                }
                t.score += rowScore;
                t.count += 1;
            }
        }
        for (const [unid, t] of totals) {
            if (t.count === 0) {
                continue;
            }
            const cap = t.count * PACKAGE_CAP;
            const health = Math.round(100 * Math.max(0, 1 - t.score / cap));
            out.set(unid, health);
        }
        return out;
    }

    public onSecurityClick(handler: (pkg: string, version: string) => void): void {
        this._onSecurityClick = handler;
    }

    /**
     * Wired by `Nppm` to open the BadgeFilterModal. The matrix
     * doesn't own the modal — opening it from here would couple two
     * concerns we want to keep separable (the modal lives a layer up,
     * just like ImpactModal / UpgradeModal).
     */
    public onBadgeFilterClick(handler: () => void): void {
        this._onBadgeFilterClick = handler;
    }

    public onBulkUpgradeClick(handler: (picks: ApiBulkUpgradePick[]) => void): void {
        this._onBulkUpgradeClick = handler;
    }

    public renderLoading(): void {
        this._root.innerHTML = `<div class="list-placeholder">${I18n.t('Loading matrix …')}</div>`;
    }

    public renderError(msg: string): void {
        this._root.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'list-error';
        err.textContent = msg;
        this._root.appendChild(err);
    }

    public setData(data: MatrixResponse): void {
        this._data = data;
        this._selected = new Map();
        this._vulnsByName = new Map();
        this._scriptsByName = new Map();
        this._patternsByName = new Map();
        this._binariesByName = new Map();
        this._maintainersByName = new Map();
        this._licensesByName = new Map();
        this._provenanceByName = new Map();
        this._freshnessByName = new Map();
        this._cadenceByName = new Map();
        this._typosquatByName = new Map();
        this._externalByName = new Map();
        this._deprecationByName = new Map();
        this._obfuscationByName = new Map();
        this._manifestRedFlagsByName = new Map();
        this._capabilityByName = new Map();
        this._bundlesByName = new Map();
        this._integrityByName = new Map();
        this._render();
        this._emitScores();

        const gen = ++this._securityGen;
        const packages: {name: string; version: string}[] = [];
        for (const row of data.rows) {
            if (!row.latest) {
                continue;
            }
            // Skip git-only rows. `row.latest` here is the registry's
            // latest for `row.name`, which is meaningless when every
            // declared cell is a git URL — the registry entry is an
            // unrelated package with the same name (the figtree /
            // fundon case). Querying CVE / cadence / freshness /
            // maintainer for that registry entry would mis-attribute
            // its data to the user's git dep.
            const allGit = Object.values(row.cells).every(
                (c) => GitResolver.isGitVersion(c.version)
            );
            if (allGit) {
                continue;
            }
            packages.push({name: row.name, version: Version.cleanRange(row.latest)});
        }

        // CVE lookup is fast (OSV batch); the fingerprint-derived
        // heuristics (scripts + patterns) are slow on cold start
        // (tarball downloads). Fire all in parallel — whichever
        // returns first repaints, the others follow.
        void this._loadVulnBadges(gen, packages);
        void this._loadHeuristicBadges(gen, packages);
        void this._loadIntegrityBadges(gen);
        void this._loadBundleSizes(gen, packages);
    }

    private async _loadBundleSizes(gen: number, packages: {name: string; version: string}[]): Promise<void> {
        if (packages.length === 0) {
            return;
        }
        try {
            const response = await Api.matrixBundles(packages);
            if (gen !== this._securityGen) {
                return;
            }
            let anyHit = false;
            for (const entry of response.results) {
                this._bundlesByName.set(entry.name, entry);
                if (entry.gzip !== null) {
                    anyHit = true;
                }
            }
            if (anyHit) {
                this._rerenderTable();
            }
        } catch {
            // Best-effort — bundlephobia outages must not break the
            // matrix itself.
        }
    }

    private async _loadVulnBadges(gen: number, packages: {name: string; version: string}[]): Promise<void> {
        if (packages.length === 0) {
            return;
        }

        try {
            const response = await Api.matrixSecurity(packages);

            if (gen !== this._securityGen) {
                return;
            }

            let anyHit = false;
            for (const entry of response.results) {
                this._vulnsByName.set(entry.name, entry.vulnIds);
                if (entry.vulnIds && entry.vulnIds.length > 0) {
                    anyHit = true;
                }
            }

            if (anyHit) {
                this._rerenderTable();
            }
        } catch {
            // Best-effort: silent on failure (detail panel still has it).
        }
    }

    private async _loadIntegrityBadges(gen: number): Promise<void> {
        try {
            const response = await Api.matrixIntegrity();
            if (gen !== this._securityGen) {
                return;
            }
            let anyHit = false;
            for (const entry of response.results) {
                this._integrityByName.set(entry.name, entry);
                if (entry.severity === IntegritySeverity.risk) {
                    anyHit = true;
                }
            }
            if (anyHit) {
                this._rerenderTable();
            }
        } catch {
            // Best-effort: silent on failure (per-project view still surfaces it).
        }
    }

    private async _loadHeuristicBadges(gen: number, packages: {name: string; version: string}[]): Promise<void> {
        if (packages.length === 0) {
            return;
        }

        try {
            const response = await Api.matrixHeuristics(packages);

            if (gen !== this._securityGen) {
                return;
            }

            let anyHit = false;
            for (const entry of response.results) {
                this._scriptsByName.set(entry.name, entry.scripts);
                this._patternsByName.set(entry.name, entry.patterns);
                this._binariesByName.set(entry.name, entry.binaries);
                this._maintainersByName.set(entry.name, entry.maintainer);
                this._licensesByName.set(entry.name, entry.license);
                this._provenanceByName.set(entry.name, entry.provenance);
                this._freshnessByName.set(entry.name, entry.freshness);
                this._cadenceByName.set(entry.name, entry.cadence);
                this._typosquatByName.set(entry.name, entry.typosquat);
                this._externalByName.set(entry.name, entry.external);
                this._deprecationByName.set(entry.name, entry.deprecation);
                this._obfuscationByName.set(entry.name, entry.obfuscation);
                this._manifestRedFlagsByName.set(entry.name, entry.manifestRedFlags);
                this._capabilityByName.set(entry.name, entry.capability);
                if (entry.scripts.maxSeverity !== null
                    || entry.patterns.maxSeverity !== null
                    || entry.binaries.maxSeverity !== null
                    || (entry.maintainer.severity !== null
                        && entry.maintainer.severity !== MaintainerSeverity.info)
                    || Matrix._isLicenseNotable(entry.license.severity)
                    || entry.provenance.level === ProvenanceLevel.provenance
                    || entry.freshness.level === FreshnessLevel.risk
                    || entry.freshness.level === FreshnessLevel.warn
                    || entry.cadence.level === CadenceLevel.risk
                    || entry.cadence.level === CadenceLevel.warn
                    || entry.typosquat.level === TyposquatLevel.risk
                    || entry.typosquat.level === TyposquatLevel.warn
                    || entry.external.level === ExternalSeverity.risk
                    || entry.external.level === ExternalSeverity.warn
                    || entry.deprecation.level === DeprecationLevel.risk
                    || entry.deprecation.level === DeprecationLevel.warn
                    || entry.obfuscation.maxSeverity === ObfuscationSeverity.risk
                    || entry.obfuscation.maxSeverity === ObfuscationSeverity.warn
                    || entry.manifestRedFlags.severity === ManifestRedFlagSeverity.risk
                    || entry.manifestRedFlags.severity === ManifestRedFlagSeverity.warn
                    || entry.capability.severity === CapabilitySeverity.risk
                    || entry.capability.severity === CapabilitySeverity.warn) {
                    anyHit = true;
                }
            }

            if (anyHit) {
                this._rerenderTable();
            }
        } catch {
            // Best-effort: silent on failure.
        }
    }

    private _render(): void {
        if (!this._data) {
            return;
        }

        this._root.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'matrix-header';
        header.appendChild(this._renderFilters());
        header.appendChild(this._renderStats());
        this._root.appendChild(header);

        const tableWrap = document.createElement('div');
        tableWrap.className = 'matrix-wrap';
        tableWrap.appendChild(this._renderTable());
        this._root.appendChild(tableWrap);

        this._root.appendChild(this._renderBulkFooter());
    }

    private _renderFilters(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'matrix-filters';

        const opts: {value: MatrixFilter; label: string}[] = [
            {value: MatrixFilter.all, label: I18n.t('All')},
            {value: MatrixFilter.issues, label: I18n.t('Issues')},
            {value: MatrixFilter.drift, label: I18n.t('Drift')},
            {value: MatrixFilter.outdated, label: I18n.t('Outdated')},
            {value: MatrixFilter.insecure, label: I18n.t('Unsafe')},
            {value: MatrixFilter.licenseIssue, label: I18n.t('Licenses')}
        ];

        for (const opt of opts) {
            const btn = document.createElement('button');
            btn.className = 'matrix-filter-btn';
            if (this._filter === opt.value) {
                btn.classList.add('matrix-filter-btn-active');
            }
            btn.textContent = opt.label;
            btn.addEventListener('click', () => {
                this._filter = opt.value;
                this._persist();
                this._render();
            });
            bar.appendChild(btn);
        }

        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'matrix-search';
        search.placeholder = I18n.t('Search package …');
        search.value = this._search;
        // Re-render on each keystroke. The dataset is small (≤ a few
        // hundred rows) and re-rendering also re-applies the filter +
        // sort, so this stays consistent without extra plumbing.
        search.addEventListener('input', () => {
            this._search = search.value;
            this._persist();
            this._rerenderTable();
        });
        bar.appendChild(search);

        const sortLabel = document.createElement('span');
        sortLabel.className = 'matrix-sort-label';
        sortLabel.textContent = I18n.t('Sort:');
        bar.appendChild(sortLabel);

        const sorts: {value: MatrixSort; label: string}[] = [
            {value: MatrixSort.name, label: I18n.t('Name')},
            {value: MatrixSort.status, label: I18n.t('Status')},
            {value: MatrixSort.severity, label: I18n.t('Severity')}
        ];

        for (const s of sorts) {
            const btn = document.createElement('button');
            btn.className = 'matrix-sort-btn';
            if (this._sort === s.value) {
                btn.classList.add('matrix-sort-btn-active');
            }
            btn.textContent = s.label;
            btn.addEventListener('click', () => {
                this._sort = s.value;
                this._persist();
                this._render();
            });
            bar.appendChild(btn);
        }

        // Badges button — opens the BadgeFilterModal. Renders an
        // active-state hint when at least one badge is hidden so the
        // user has a quick visual cue that the matrix is filtered.
        const badgesBtn = document.createElement('button');
        badgesBtn.className = 'matrix-sort-btn matrix-badges-btn';
        if (this._hiddenBadges.size > 0) {
            badgesBtn.classList.add('matrix-sort-btn-active');
            badgesBtn.textContent = I18n.t('Badges ({n} hidden)', {n: this._hiddenBadges.size});
        } else {
            badgesBtn.textContent = I18n.t('Badges');
        }
        badgesBtn.addEventListener('click', () => {
            this._onBadgeFilterClick?.();
        });
        bar.appendChild(badgesBtn);

        return bar;
    }

    /**
     * Re-render only the table region — used on each keystroke in the
     * search input so we don't blow away the input element (and thus
     * the focus + caret position) on every character.
     */
    private _rerenderTable(): void {
        const wrap = this._root.querySelector('.matrix-wrap');

        if (!wrap) {
            this._render();
            return;
        }

        wrap.innerHTML = '';
        wrap.appendChild(this._renderTable());
        this._emitScores();
    }

    private _emitScores(): void {
        if (this._onScoresChanged) {
            this._onScoresChanged(this.computeProjectScores());
        }
    }

    private _renderStats(): HTMLElement {
        const stats = document.createElement('div');
        stats.className = 'matrix-stats';

        if (!this._data) {
            return stats;
        }

        const counts = {
            aligned: 0,
            outdated: 0,
            drift: 0,
            unknown: 0
        };

        for (const row of this._data.rows) {
            counts[row.status]++;
        }

        stats.innerHTML = `
            <span class="matrix-stat matrix-stat-aligned">${counts.aligned} aligned</span>
            <span class="matrix-stat matrix-stat-outdated">${counts.outdated} outdated</span>
            <span class="matrix-stat matrix-stat-drift">${counts.drift} drift</span>
            <span class="matrix-stat matrix-stat-unknown">${counts.unknown} unknown</span>
        `;

        return stats;
    }

    private _renderTable(): HTMLElement {
        const table = document.createElement('table');
        table.className = 'matrix-table';

        // -- header row --------------------------------------------
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');

        trHead.appendChild(Matrix._th(I18n.t('Package'), 'matrix-th-name'));

        for (const project of this._data!.projects) {
            const th = Matrix._th(project.name, 'matrix-th-project');
            th.title = project.error ?? '';
            th.addEventListener('click', () => this._onProjectClick?.(project.unid));
            trHead.appendChild(th);
        }

        trHead.appendChild(Matrix._th(I18n.t('Latest'), 'matrix-th-latest'));
        thead.appendChild(trHead);
        table.appendChild(thead);

        // -- body --------------------------------------------------
        const tbody = document.createElement('tbody');
        const visibleRows = this._sortRows(this._data!.rows.filter((r) => this._isVisible(r)));

        if (visibleRows.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = this._data!.projects.length + 2;
            td.className = 'matrix-empty';
            td.textContent = I18n.t('No matches for this filter.');
            tr.appendChild(td);
            tbody.appendChild(tr);
        } else {
            for (const row of visibleRows) {
                tbody.appendChild(this._renderRow(row));
            }
        }

        table.appendChild(tbody);
        return table;
    }

    private _renderRow(row: MatrixRow): HTMLElement {
        const tr = document.createElement('tr');
        tr.className = `matrix-row matrix-row-${row.status}`;

        const nameCell = document.createElement('td');
        nameCell.className = 'matrix-cell-name';

        const nameText = document.createElement('span');
        nameText.textContent = row.name;
        nameCell.appendChild(nameText);

        // Bundle-size pill — informational rather than a warning.
        // Coloured by gzip-size threshold (muted < 50kB, warn 50–200kB,
        // risk > 200kB) so a glance at the matrix surfaces the
        // outliers without crowding every row.
        const bundle = this._bundlesByName.get(row.name);
        if (bundle && bundle.gzip !== null) {
            const pill = document.createElement('span');
            const bucket = Matrix._bundleBucket(bundle.gzip);
            pill.className = `matrix-bundle matrix-bundle-${bucket}`;
            pill.textContent = Matrix._formatBytes(bundle.gzip);
            pill.title = I18n.t('Bundle: {gzip} gzipped, {size} minified, {deps} transitive deps', {
                gzip: Matrix._formatBytes(bundle.gzip),
                size: bundle.size !== null ? Matrix._formatBytes(bundle.size) : '?',
                deps: bundle.dependencyCount ?? '?'
            });
            nameCell.appendChild(pill);
        }

        const vulnIds = this._vulnsByName.get(row.name);
        if (vulnIds && vulnIds.length > 0 && this._isBadgeVisible('cve')) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-cve';
            badge.textContent = `CVE ${vulnIds.length}`;
            badge.title = vulnIds.join('\n');
            // Clicking the badge opens the detail panel on the latest
            // version so the user lands on the security tab they care
            // about. We piggy-back on the existing cell-click contract.
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        const scripts = this._scriptsByName.get(row.name);
        if (scripts && scripts.maxSeverity !== null && this._isBadgeVisible('script')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-script matrix-badge-script-${scripts.maxSeverity}`;
            badge.textContent = Matrix._scriptBadgeLabel(scripts.maxSeverity);
            badge.title = I18n.t('{count} install hook(s) — severity {severity}', {count: scripts.count, severity: scripts.maxSeverity});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Pattern badge only for the loudest signal (`risk` = eval/
        // Function call) — `warn` patterns like `child_process` are
        // legitimate in dozens of libraries and would clutter every row.
        const patterns = this._patternsByName.get(row.name);
        if (patterns && patterns.maxSeverity === PatternSeverity.risk && this._isBadgeVisible('pattern')) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-pattern';
            badge.textContent = `EVAL ${patterns.count}`;
            badge.title = I18n.t('{count} dynamic code executions in tarball', {count: patterns.count});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Binary badge only for risk-tier — `.node`/`.wasm` (warn/info)
        // are routine in many native-binding packages and would
        // clutter every row otherwise.
        const binaries = this._binariesByName.get(row.name);
        if (binaries && binaries.maxSeverity === BinarySeverity.risk && this._isBadgeVisible('binary')) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-binary';
            badge.textContent = `BIN ${binaries.riskCount}`;
            badge.title = I18n.t('{count} native binary file(s) (.exe/.dll/.so/…) in tarball', {count: binaries.riskCount});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Maintainer badge only for risk-tier — first-time publishers
        // alone (`warn`) are common when a project moves to CI; we'd
        // train the user to ignore the badge.
        const maintainer = this._maintainersByName.get(row.name);
        if (maintainer && maintainer.severity === MaintainerSeverity.risk && this._isBadgeVisible('maintainer')) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-maintainer';
            badge.textContent = 'OWNER!';
            badge.title = I18n.t('New publisher ({publisher}) after long silence — possible account takeover', {publisher: maintainer.publisher ?? '?'});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // License badge only for strong-copyleft and proprietary —
        // weak-copyleft is too noisy (legal teams pre-approve LGPL /
        // MPL in most shops). `unknown` packages get a smaller grey
        // badge so they're noticeable without screaming.
        const license = this._licensesByName.get(row.name);
        if (license && this._isBadgeVisible('license')) {
            const badge = Matrix._licenseBadge(license);
            if (badge) {
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (row.latest) {
                        this._onSecurityClick?.(row.name, row.latest);
                    }
                });
                nameCell.appendChild(badge);
            }
        }

        // Integrity badge only for risk-tier — `warn` covers benign
        // custom mirrors and `info` covers private/unpublished
        // packages, both of which are noise on a cross-project view.
        // A `risk` finding means at least one project's lockfile pins
        // a tarball whose integrity differs from what the registry
        // now serves — real supply-chain signal.
        const integrity = this._integrityByName.get(row.name);
        if (integrity && integrity.severity === IntegritySeverity.risk && this._isBadgeVisible('integrity')) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-integrity';
            badge.textContent = 'INTEGRITY!';
            badge.title = I18n.t('{n} project(s) pin a tarball whose integrity differs from the registry', {n: integrity.riskCount});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Provenance badge — *positive* signal, only rendered for
        // `provenance`-level (Sigstore-anchored). `signed` is the
        // npm baseline and rendering it would clutter every row;
        // `unsigned` is too quiet to be actionable. The badge is
        // green by convention since it answers "this build is
        // verifiable" rather than warning of a risk.
        const provenance = this._provenanceByName.get(row.name);
        if (provenance && provenance.level === ProvenanceLevel.provenance && this._isBadgeVisible('provenance')) {
            const badge = document.createElement('span');
            badge.className = 'matrix-badge matrix-badge-provenance';
            badge.textContent = 'PROV ✓';
            badge.title = I18n.t('Latest version published with --provenance (Sigstore-anchored CI build attestation)');
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Freshness badge — "brand new" signal. Renders for warn and
        // risk; both colours via CSS modifier. Warn = young but past
        // the risk threshold (typically <30d); risk = very young
        // (typically <7d), the classic typosquat profile.
        const freshness = this._freshnessByName.get(row.name);
        if (freshness && (freshness.level === FreshnessLevel.risk
                          || freshness.level === FreshnessLevel.warn)
                && this._isBadgeVisible('freshness')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-freshness matrix-badge-freshness-${freshness.level}`;
            badge.textContent = freshness.level === FreshnessLevel.risk ? 'NEW!' : 'NEW';
            badge.title = Matrix._freshnessTooltip(freshness);
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Cadence badge — "is this package still alive?". Render
        // warn (slowing, yellow) and risk (likely abandoned, red);
        // info is silent to keep noise down. Threshold defaults:
        // 180d warn, 730d risk.
        const cadence = this._cadenceByName.get(row.name);
        if (cadence && (cadence.level === CadenceLevel.risk
                        || cadence.level === CadenceLevel.warn)
                && this._isBadgeVisible('cadence')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-cadence matrix-badge-cadence-${cadence.level}`;
            badge.textContent = cadence.level === CadenceLevel.risk ? 'STALE!' : 'STALE';
            badge.title = Matrix._cadenceTooltip(cadence);
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Typosquat badge — render warn (distance 2) + risk
        // (distance 1 OR Unicode confusables). Exact + unrelated
        // are silent; almost every package name lands there so a
        // badge would be useless noise.
        const typosquat = this._typosquatByName.get(row.name);
        if (typosquat && (typosquat.level === TyposquatLevel.risk
                          || typosquat.level === TyposquatLevel.warn)
                && this._isBadgeVisible('typosquat')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-typosquat matrix-badge-typosquat-${typosquat.level}`;
            badge.textContent = typosquat.level === TyposquatLevel.risk ? 'SQUAT!' : 'SQUAT?';
            badge.title = Matrix._typosquatTooltip(typosquat);
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // External-sources badge — aggregated worst-of-three across
        // socket.dev / OpenSSF Scorecard / deps.dev. Renders only at
        // warn/risk; info-only contributions (typical deps.dev) stay
        // silent so the badge actually means "look at this".
        const external = this._externalByName.get(row.name);
        if (external && (external.level === ExternalSeverity.risk
                         || external.level === ExternalSeverity.warn)
                && this._isBadgeVisible('external')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-external matrix-badge-external-${external.level}`;
            badge.textContent = external.level === ExternalSeverity.risk ? 'EXT!' : 'EXT?';
            badge.title = I18n.t('External sources flagged this package ({n} source(s))', {n: external.count});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Obfuscation badge — risk = code-obfuscation fingerprints in
        // a non-build path; warn = same in a build path or weaker
        // signal in source. Info (legit minification in dist/) stays
        // silent.
        const obfuscation = this._obfuscationByName.get(row.name);
        if (obfuscation && (obfuscation.maxSeverity === ObfuscationSeverity.risk
                            || obfuscation.maxSeverity === ObfuscationSeverity.warn)
                && this._isBadgeVisible('obfuscation')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-obfuscation matrix-badge-obfuscation-${obfuscation.maxSeverity}`;
            badge.textContent = obfuscation.maxSeverity === ObfuscationSeverity.risk ? 'OBF!' : 'OBF?';
            badge.title = I18n.t('Obfuscation signals detected in {n} file(s)', {n: obfuscation.count});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Manifest red-flags badge — `MAN!` for the native+postinstall
        // combo or ≥3 stacked flags, `MAN?` for two stacked flags.
        // Single flags stay info-grade and don't render a badge
        // (every other manifest in the registry has at least one
        // small quirk so the threshold has to be meaningful).
        const manifestRedFlags = this._manifestRedFlagsByName.get(row.name);
        if (manifestRedFlags && (manifestRedFlags.severity === ManifestRedFlagSeverity.risk
                                 || manifestRedFlags.severity === ManifestRedFlagSeverity.warn)
                && this._isBadgeVisible('manifestRedFlags')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-manifestRedFlags matrix-badge-manifestRedFlags-${manifestRedFlags.severity}`;
            badge.textContent = manifestRedFlags.severity === ManifestRedFlagSeverity.risk ? 'MAN!' : 'MAN?';
            badge.title = I18n.t('{n} manifest red-flag(s)', {n: manifestRedFlags.count});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Capability badge — `CAP!` for the dangerous combinations
        // (spawn+network, env+network, native+network), `CAP?` for
        // two heavy-hitter capabilities or dynamic-import alone.
        // Info-grade single capabilities stay silent (most packages
        // touch one platform API).
        const capability = this._capabilityByName.get(row.name);
        if (capability && (capability.severity === CapabilitySeverity.risk
                           || capability.severity === CapabilitySeverity.warn)
                && this._isBadgeVisible('capability')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-capability matrix-badge-capability-${capability.severity}`;
            badge.textContent = capability.severity === CapabilitySeverity.risk ? 'CAP!' : 'CAP?';
            badge.title = I18n.t('{n} capability(ies) detected', {n: capability.count});
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        // Deprecation badge — risk = installed version itself is
        // deprecated; warn = registry latest is deprecated.
        // info-only ("some older versions were deprecated") stays
        // silent because every long-lived package eventually has
        // some deprecated history.
        const deprecation = this._deprecationByName.get(row.name);
        if (deprecation && (deprecation.level === DeprecationLevel.risk
                            || deprecation.level === DeprecationLevel.warn)
                && this._isBadgeVisible('deprecation')) {
            const badge = document.createElement('span');
            badge.className = `matrix-badge matrix-badge-deprecation matrix-badge-deprecation-${deprecation.level}`;
            badge.textContent = deprecation.level === DeprecationLevel.risk ? 'DEP!' : 'DEP?';
            badge.title = deprecation.level === DeprecationLevel.risk
                ? I18n.t('Installed version was deprecated by the maintainer')
                : I18n.t('Latest version was deprecated by the maintainer');
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.latest) {
                    this._onSecurityClick?.(row.name, row.latest);
                }
            });
            nameCell.appendChild(badge);
        }

        tr.appendChild(nameCell);

        for (const project of this._data!.projects) {
            const cellData = row.cells[project.unid];
            const td = document.createElement('td');
            td.className = 'matrix-cell';

            if (!cellData) {
                td.classList.add('matrix-cell-missing');
                td.textContent = '—';
            } else {
                td.classList.add(`matrix-cell-${row.status}`);
                td.classList.add('matrix-cell-clickable');
                td.addEventListener('click', () => {
                    this._onCellClick?.(row.name, cellData.version, row.latest);
                });

                // Bulk-Upgrade checkbox: outdated OR drift rows on
                // local projects with a known registry `latest` and a
                // non-git installation. Drift rows are included so
                // the wizard can unify projects pinned to different
                // versions; `internalDrift` cells stay blocked because
                // a single pick can only target one workspace and the
                // partial-update would be misleading. Click is
                // stopped so it doesn't also open the detail panel.
                const eligibleStatus =
                    row.status === MatrixRowStatus.outdated
                    || row.status === MatrixRowStatus.drift;
                if (
                    eligibleStatus
                    && row.latest
                    && !cellData.installedVersion
                    && !cellData.internalDrift
                    && project.type === ConfigProjectType.local
                ) {
                    const key = Matrix._pickKey(project.unid, row.name);
                    const check = document.createElement('input');
                    check.type = 'checkbox';
                    check.className = 'matrix-cell-check';
                    check.checked = this._selected.has(key);
                    check.title = I18n.t('Add to Bulk Update');
                    check.addEventListener('click', (e) => e.stopPropagation());
                    check.addEventListener('change', () => {
                        if (check.checked) {
                            this._selected.set(key, {
                                projectUnid: project.unid,
                                workspace: cellData.workspace ?? '',
                                name: row.name,
                                depType: Matrix._toApiDepType(cellData.types[0]),
                                fromRange: cellData.version,
                                toRange: `^${row.latest}`
                            });
                        } else {
                            this._selected.delete(key);
                        }
                        this._refreshBulkFooter();
                    });
                    td.appendChild(check);
                }

                const v = document.createElement('span');
                v.className = 'matrix-cell-version';
                if (cellData.installedVersion) {
                    // Git-pinned cell: show the *installed* version
                    // primary, raw URL as tooltip. The clicked
                    // `version` is still the git URL so the detail
                    // panel can resolve the tarball.
                    v.textContent = cellData.installedVersion;
                    v.title = cellData.version;
                    const gitTag = document.createElement('span');
                    gitTag.className = 'matrix-cell-git';
                    gitTag.textContent = 'git';
                    gitTag.title = cellData.version;
                    td.appendChild(v);
                    td.appendChild(gitTag);
                } else {
                    v.textContent = cellData.version;
                    td.appendChild(v);
                }

                if (cellData.internalDrift) {
                    const badge = document.createElement('span');
                    badge.className = 'matrix-badge matrix-badge-drift';
                    badge.title = I18n.t('Workspaces of this project declared different versions — click for details');
                    badge.textContent = 'WS';
                    badge.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._onWorkspaceDriftClick?.(project.unid, project.name, row.name);
                    });
                    td.appendChild(badge);
                }

                const types = cellData.types
                    .filter((t) => t !== DependencyType.dependency)
                    .map(Matrix._depLabel)
                    .join('/');

                if (types) {
                    const tag = document.createElement('span');
                    tag.className = 'matrix-cell-type';
                    tag.textContent = types;
                    td.appendChild(tag);
                }
            }

            tr.appendChild(td);
        }

        const latestTd = document.createElement('td');
        latestTd.className = 'matrix-cell-latest';
        if (row.latest) {
            latestTd.textContent = row.latest;
        } else {
            const allCellsGit = Object.values(row.cells).every(
                (c) => GitResolver.isGitVersion(c.version)
            );
            if (allCellsGit) {
                // Collect the distinct git refs so the user can see which
                // branches/tags are in play across projects without
                // hovering each cell separately.
                const refs = new Set<string>();
                for (const c of Object.values(row.cells)) {
                    const m = c.version.match(/#(.+)$/);
                    refs.add(m ? m[1] : 'HEAD');
                }
                latestTd.classList.add('matrix-cell-latest-git');
                // Prefer the HEAD info the backend resolved (version +
                // short SHA from the upstream repo). Fall back to the
                // plain "git" pill when the resolver was disabled or
                // the host couldn't be reached.
                if (row.gitLatest && (row.gitLatest.version || row.gitLatest.shortSha)) {
                    const parts: string[] = [];
                    if (row.gitLatest.version) {
                        parts.push(row.gitLatest.version);
                    }
                    if (row.gitLatest.shortSha) {
                        parts.push(row.gitLatest.shortSha);
                    }
                    latestTd.textContent = parts.join(' · ');
                    latestTd.title = I18n.t('Git HEAD — refs in projects: {refs}', {
                        refs: Array.from(refs).join(', ')
                    });
                } else {
                    latestTd.textContent = 'git';
                    latestTd.title = I18n.t('Git-only dependency — refs: {refs}', {
                        refs: Array.from(refs).join(', ')
                    });
                }
            } else {
                latestTd.textContent = '?';
            }
        }
        tr.appendChild(latestTd);

        return tr;
    }

    private _scoreFor(row: MatrixRow): number {
        return Matrix._severityScore(
            this._vulnsByName.get(row.name),
            this._scriptsByName.get(row.name),
            this._patternsByName.get(row.name),
            this._binariesByName.get(row.name),
            this._maintainersByName.get(row.name),
            this._integrityByName.get(row.name),
            this._freshnessByName.get(row.name),
            this._cadenceByName.get(row.name),
            this._typosquatByName.get(row.name),
            this._externalByName.get(row.name),
            this._deprecationByName.get(row.name),
            this._obfuscationByName.get(row.name),
            this._manifestRedFlagsByName.get(row.name),
            this._capabilityByName.get(row.name)
        );
    }

    private _isVisible(row: MatrixRow): boolean {
        const needle = this._search.trim().toLowerCase();
        if (needle && !row.name.toLowerCase().includes(needle)) {
            return false;
        }

        switch (this._filter) {
            case MatrixFilter.all:
                return true;
            case MatrixFilter.drift:
                return row.status === MatrixRowStatus.drift;
            case MatrixFilter.outdated:
                return row.status === MatrixRowStatus.outdated;
            case MatrixFilter.issues:
                return row.status === MatrixRowStatus.drift
                    || row.status === MatrixRowStatus.outdated;
            case MatrixFilter.insecure:
                return this._scoreFor(row) > 0;
            case MatrixFilter.licenseIssue: {
                const lic = this._licensesByName.get(row.name);
                return lic !== undefined && Matrix._isLicenseNotable(lic.severity);
            }
        }
    }

    /**
     * Sort by name (alphabetic), status rank, or aggregated severity
     * score. Backend already delivers rows sorted by name, so the
     * `name` case is a no-op clone but kept explicit for clarity.
     */
    private _sortRows(rows: MatrixRow[]): MatrixRow[] {
        const copy = [...rows];

        if (this._sort === MatrixSort.status) {
            copy.sort((a, b) => {
                const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
                return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name);
            });
        } else if (this._sort === MatrixSort.severity) {
            copy.sort((a, b) => {
                const diff = this._scoreFor(b) - this._scoreFor(a);
                return diff !== 0 ? diff : a.name.localeCompare(b.name);
            });
        } else {
            copy.sort((a, b) => a.name.localeCompare(b.name));
        }

        return copy;
    }

    /**
     * Sticky footer that surfaces the Bulk-Upgrade selection state
     * and the "Update selected" trigger. Hidden (display:none via
     * `matrix-footer-empty`) until the first checkbox is ticked —
     * otherwise it would overlap the last matrix row in the default
     * "All" view without offering anything to act on.
     */
    private _renderBulkFooter(): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'matrix-footer';

        const count = document.createElement('span');
        count.className = 'matrix-footer-count';
        bar.appendChild(count);

        const clear = document.createElement('button');
        clear.className = 'matrix-footer-clear';
        clear.textContent = I18n.t('Clear selection');
        clear.addEventListener('click', () => {
            this._selected.clear();
            this._rerenderTable();
            this._refreshBulkFooter();
        });
        bar.appendChild(clear);

        const apply = document.createElement('button');
        apply.className = 'matrix-footer-apply';
        apply.textContent = I18n.t('Update selected');
        apply.addEventListener('click', () => {
            if (this._selected.size === 0) {
                return;
            }
            this._onBulkUpgradeClick?.(Array.from(this._selected.values()));
        });
        bar.appendChild(apply);

        Matrix._fillBulkFooter(bar, this._selected.size);
        return bar;
    }

    /**
     * In-place update of the sticky footer's count and disabled state
     * — avoids tearing down + re-rendering the whole table on every
     * checkbox toggle.
     */
    private _refreshBulkFooter(): void {
        const bar = this._root.querySelector<HTMLElement>('.matrix-footer');
        if (!bar) {
            return;
        }
        Matrix._fillBulkFooter(bar, this._selected.size);
    }

    private static _fillBulkFooter(bar: HTMLElement, n: number): void {
        const count = bar.querySelector<HTMLElement>('.matrix-footer-count');
        const apply = bar.querySelector<HTMLButtonElement>('.matrix-footer-apply');
        const clear = bar.querySelector<HTMLButtonElement>('.matrix-footer-clear');
        if (count) {
            count.textContent = I18n.t('{n} selected', {n});
        }
        if (apply) {
            apply.disabled = n === 0;
        }
        if (clear) {
            clear.disabled = n === 0;
        }
        bar.classList.toggle('matrix-footer-empty', n === 0);
    }

    private static _pickKey(projectUnid: string, name: string): string {
        return `${projectUnid}|${name}`;
    }

    /**
     * `DependencyType` (string enum) → the literal union the Upgrade
     * API request expects. Identity at runtime; the cast keeps the
     * static types narrow for the route handler.
     */
    private static _toApiDepType(t: DependencyType): 'dependency'|'dev'|'peer'|'optional' {
        return t as unknown as 'dependency'|'dev'|'peer'|'optional';
    }

    private static _th(label: string, cls: string): HTMLElement {
        const th = document.createElement('th');
        th.className = cls;
        th.textContent = label;
        return th;
    }

    private static _isLicenseNotable(s: LicenseSeverity): boolean {
        return s === LicenseSeverity.strongCopyleft
            || s === LicenseSeverity.proprietary
            || s === LicenseSeverity.unknown;
    }

    private static _licenseBadge(summary: LicenseSummary): HTMLElement|null {
        const sev = summary.severity;
        let label: string;
        let cls: string;

        switch (sev) {
            case LicenseSeverity.strongCopyleft:
                label = 'GPL';
                cls = 'matrix-badge-license-strong';
                break;
            case LicenseSeverity.proprietary:
                label = 'UNLIC';
                cls = 'matrix-badge-license-proprietary';
                break;
            case LicenseSeverity.unknown:
                label = 'LIC?';
                cls = 'matrix-badge-license-unknown';
                break;
            default:
                return null;
        }

        const badge = document.createElement('span');
        badge.className = `matrix-badge matrix-badge-license ${cls}`;
        badge.textContent = label;
        badge.title = summary.spdx
            ? I18n.t('License: {spdx}', {spdx: summary.spdx})
            : I18n.t('No license declared');
        return badge;
    }

    /**
     * Build the freshness-badge tooltip from whichever signals were
     * resolved. Missing maintainer age is the common case (registry
     * 401s on the public mirror) — the package-age fragment alone
     * still reads cleanly.
     */
    /**
     * Build the cadence-badge tooltip from whatever signals were
     * resolved. Both numbers may be missing (very old packument
     * without a `time` map) — in that case the badge wouldn't
     * render at all, but the helper stays defensive.
     */
    /**
     * Three-bucket gzip-size classifier for the bundle-size pill.
     * Thresholds picked from the bundlephobia hall-of-fame: a
     * typical utility lands well under 50kB, a UI framework hits
     * 50-200kB, and anything over 200kB is worth a second look.
     */
    private static _bundleBucket(gzipBytes: number): 'small'|'medium'|'large' {
        if (gzipBytes < 50_000) {
            return 'small';
        }
        if (gzipBytes < 200_000) {
            return 'medium';
        }
        return 'large';
    }

    /**
     * Format byte counts as `N kB` or `N.M MB`. Bundlephobia returns
     * decimal-kilobytes by convention so we follow suit.
     */
    private static _formatBytes(bytes: number): string {
        if (bytes < 1000) {
            return `${bytes} B`;
        }
        if (bytes < 1_000_000) {
            return `${Math.round(bytes / 1000)} kB`;
        }
        return `${(bytes / 1_000_000).toFixed(1)} MB`;
    }

    private static _typosquatTooltip(summary: TyposquatSummary): string {
        if (summary.hasConfusables) {
            return summary.closestMatch
                ? I18n.t('Contains non-ASCII characters and resembles popular "{name}"', {name: summary.closestMatch})
                : I18n.t('Contains non-ASCII characters — npm names are ASCII-only');
        }
        if (summary.closestMatch) {
            return I18n.t('Looks similar to popular "{name}" — possible typosquat', {name: summary.closestMatch});
        }
        return '';
    }

    private static _cadenceTooltip(summary: CadenceSummary): string {
        const parts: string[] = [];
        if (summary.daysSinceLastRelease !== null) {
            parts.push(I18n.t('Last release {n} days ago', {n: summary.daysSinceLastRelease}));
        }
        if (summary.medianCadenceDays !== null) {
            parts.push(I18n.t('median cadence every {n} days', {n: summary.medianCadenceDays}));
        }
        return parts.join(' · ');
    }

    private static _freshnessTooltip(summary: FreshnessSummary): string {
        const parts: string[] = [];
        if (summary.packageAgeDays !== null) {
            parts.push(I18n.t('Package first published {n} days ago', {n: summary.packageAgeDays}));
        }
        if (summary.maintainerAgeDays !== null) {
            parts.push(I18n.t('Publisher account {n} days old', {n: summary.maintainerAgeDays}));
        }
        return parts.join(' · ');
    }

    private static _scriptBadgeLabel(s: ScriptSeverity): string {
        switch (s) {
            case ScriptSeverity.risk: return 'SCRIPT!';
            case ScriptSeverity.warn: return 'SCRIPT';
            case ScriptSeverity.info: return 'script';
        }
    }

    private static _depLabel(t: DependencyType): string {
        switch (t) {
            case DependencyType.dependency:
                return 'dep';
            case DependencyType.dev:
                return 'dev';
            case DependencyType.peer:
                return 'peer';
            case DependencyType.optional:
                return 'opt';
        }
    }
}