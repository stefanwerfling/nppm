import fs from 'fs';
import {
    ApiDashboardGrowthResponse,
    ApiDashboardHistoryResponse,
    ApiDashboardResponse,
    ApiDashboardSnapshotResponse,
    ApiPackageTrendsResponse
} from '../../shared/Api/ApiTypes.js';
import {
    CellFinding,
    DashboardBuilder,
    DashboardCell,
    DashboardColumn,
    ScannerId,
    SCANNER_IDS
} from '../Dashboard/DashboardBuilder.js';
import {DashboardGrowthBuilder, GrowthProjectInput} from '../Dashboard/DashboardGrowthBuilder.js';
import {DownloadsAggregator} from '../Dashboard/DownloadsAggregator.js';
import {InstalledSize} from '../Dashboard/InstalledSize.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {PackageTrendsBuilder} from '../Package/PackageTrendsBuilder.js';
import {Lockfile} from '../Project/Lockfile.js';
import {Project} from '../Project/Project.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {MutableResolutionScanner} from '../Security/MutableResolutionScanner.js';
import {TemplateResolver} from '../Templates/TemplateResolver.js';
import {ServerContext} from './ServerContext.js';

/**
 * Dashboard endpoints + the per-package trends panel. Five routes
 * live here; the bulk of the file is `/api/dashboard/scan`'s SSE
 * orchestrator which walks every project × every scanner and emits
 * one `cell` event per intersection.
 *
 * Route map:
 *   GET /api/dashboard/snapshot       — last persisted scan snapshot
 *   GET /api/dashboard/history        — rolling per-day averages
 *   GET /api/dashboard/growth         — package-count timelines
 *   GET /api/packages/:name/trends    — per-package version + downloads timeline
 *   GET /api/dashboard/scan           — SSE: full scanner × project sweep
 *
 * The scan route persists its result to `dashboardSnapshotPath` and
 * appends a daily record to `dashboardHistoryStore` on every successful
 * run — both feeds the Trend tab's first-paint and the macro-donut
 * delta widget.
 */
export class DashboardController {

    public static register(ctx: ServerContext): void {
        DashboardController._registerSnapshot(ctx);
        DashboardController._registerHistory(ctx);
        DashboardController._registerGrowth(ctx);
        DashboardController._registerTrends(ctx);
        DashboardController._registerScan(ctx);
    }

    private static _registerSnapshot(ctx: ServerContext): void {
        ctx.app.get('/api/dashboard/snapshot', (_req, res): void => {
            try {
                if (!fs.existsSync(ctx.dashboardSnapshotPath)) {
                    const empty: ApiDashboardSnapshotResponse = {snapshot: null, timestamp: null};
                    res.status(200).json(empty);
                    return;
                }
                const raw = fs.readFileSync(ctx.dashboardSnapshotPath, 'utf-8');
                const payload = JSON.parse(raw) as ApiDashboardSnapshotResponse;
                res.status(200).json(payload);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerHistory(ctx: ServerContext): void {
        ctx.app.get('/api/dashboard/history', (req, res): void => {
            try {
                const raw = typeof req.query.days === 'string'
                    ? Number.parseInt(req.query.days, 10) : 90;
                const days = Math.min(3650, Math.max(1, Number.isFinite(raw) ? raw : 90));
                const entries = ctx.dashboardHistoryStore.readRange(days);
                let previous: ReturnType<typeof ctx.dashboardHistoryStore.readPrevious> = null;
                if (entries.length > 0) {
                    previous = ctx.dashboardHistoryStore.readPrevious(entries[entries.length - 1].timestamp);
                }
                const payload: ApiDashboardHistoryResponse = {entries: entries, previous: previous};
                res.status(200).json(payload);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerGrowth(ctx: ServerContext): void {
        ctx.app.get('/api/dashboard/growth', (req, res): void => {
            try {
                const raw = typeof req.query.days === 'string'
                    ? Number.parseInt(req.query.days, 10) : 90;
                const days = Math.min(3650, Math.max(1, Number.isFinite(raw) ? raw : 90));
                const sinceMs = Date.now() - (days * 86400_000);

                const inputs: GrowthProjectInput[] = [];
                for (const [unid, project] of ctx.projects) {
                    const name = project.getName();
                    const history = ctx.historyStore.read(unid, name);
                    inputs.push({unid: unid, name: name, history: history});
                }
                const payload: ApiDashboardGrowthResponse =
                    DashboardGrowthBuilder.build(inputs, sinceMs);
                res.status(200).json(payload);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerTrends(ctx: ServerContext): void {
        ctx.app.get('/api/packages/:name/trends', async(req, res): Promise<void> => {
            try {
                const name = decodeURIComponent(req.params.name);
                const pkg = await ctx.loaded.registry.fetchOne(name);
                if (!pkg) {
                    res.status(404).json({success: false, msg: 'package not found'});
                    return;
                }
                const base = PackageTrendsBuilder.build(pkg);
                const downloads = await ctx.downloadsFetcher.fetchRange(name, 'last-year');
                const payload: ApiPackageTrendsResponse = {...base, downloads: downloads};
                res.status(200).json(payload);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

    private static _registerScan(ctx: ServerContext): void {
        ctx.app.get('/api/dashboard/scan', async(req, res): Promise<void> => {
            res.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            res.flushHeaders();

            const send = (event: string, data: object): void => {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            let aborted = false;
            req.on('close', (): void => {
                aborted = true;
            });

            const projectEntries = Array.from(ctx.projects.entries());
            const totalCells = projectEntries.length * SCANNER_IDS.length;
            const columns: DashboardColumn[] = [];
            let cellsDone = 0;
            /*
             * Per-project name set, collected as each column is
             * built, so the downloads pass after the loop can do
             * one big batched fetch.
             */
            const projectNames = new Map<string, string[]>();

            send('start', {scanners: SCANNER_IDS, totalProjects: projectEntries.length});

            /*
             * Hooks built once outside the loop so the inner arrows
             * close over a stable scope (no-loop-func) — `cellsDone`
             * and `aborted` mutate across iterations but they live in
             * this outer frame, which is exactly what we want.
             */
            const hooks: ScanColumnHooks = {
                totalCells: totalCells,
                getCellsDone: (): number => cellsDone,
                bumpCellsDone: (): void => {
                    cellsDone++;
                },
                send: send,
                isAborted: (): boolean => aborted,
                captureNames: (unid: string, names: string[]): void => {
                    projectNames.set(unid, names);
                }
            };

            try {
                for (let projectIdx = 0; projectIdx < projectEntries.length; projectIdx++) {
                    if (aborted) {
                        return;
                    }
                    const [unid, project] = projectEntries[projectIdx];
                    const projectName = project.getName();

                    send('column-start', {
                        projectIndex: projectIdx,
                        projectUnid: unid,
                        projectName: projectName
                    });

                    // eslint-disable-next-line no-await-in-loop
                    const column = await DashboardController._scanProject(ctx, unid, project, projectName, hooks);
                    if (aborted) {
                        return;
                    }
                    columns.push(column);
                    send('column-end', {column: column});
                }

                if (!aborted) {
                    const ecosystemDownloads = await DashboardController._fetchDownloads(
                        ctx, projectNames, columns, cellsDone, totalCells, send
                    );

                    const dashboard: ApiDashboardResponse = {
                        scanners: [...SCANNER_IDS],
                        columns: columns
                    };
                    DashboardController._persistSnapshot(ctx, dashboard, ecosystemDownloads);
                    send('end', {dashboard: dashboard});
                }
            } catch (e) {
                send('error', {msg: (e as Error).message});
            } finally {
                res.end();
            }
        });
    }

    /**
     * Run every scanner against one project and return the
     * `DashboardColumn`. Lockfile success path is fully scanned;
     * manifest fallback resolves declared deps to registry `latest`
     * and stamps a `column.note`. Any thrown error is captured into
     * `column.error` and the remaining cells emit as N/A.
     */
    // eslint-disable-next-line max-lines-per-function
    private static async _scanProject(
        ctx: ServerContext,
        unid: string,
        project: Project,
        projectName: string,
        hooks: ScanColumnHooks
    ): Promise<DashboardColumn> {
        const cells: Partial<Record<ScannerId, DashboardCell>> = {};
        let columnError: string|undefined;
        let columnNote: string|undefined;
        let columnSize: {totalBytes: number; coveredCount: number; totalCount: number;}|undefined;

        const emitCell = (scanner: ScannerId, cell: DashboardCell): void => {
            cells[scanner] = cell;
            hooks.send('cell', {projectUnid: unid, scanner: scanner, cell: cell});
            hooks.bumpCellsDone();
            hooks.send('progress', {
                current: hooks.getCellsDone(),
                total: hooks.totalCells,
                projectName: projectName,
                scanner: scanner
            });
        };

        const skipColumnAsNa = (msg: string): void => {
            columnError = msg;
            for (const id of SCANNER_IDS) {
                emitCell(id, DashboardBuilder.naCell(msg));
            }
        };

        try {
            hooks.send('progress', {
                current: hooks.getCellsDone(),
                total: hooks.totalCells,
                projectName: projectName,
                scanner: null,
                detail: `Loading lockfile for ${projectName}`
            });
            const lockfile = await project.loadLockfile();
            /*
             * Build the package list — either from the lockfile
             * (exact installed versions) or as a best-effort fallback
             * from the manifest's declared deps resolved to the
             * registry's `latest`. The fallback is what lets remote
             * projects without a committed package-lock.json still
             * get scanned instead of every cell turning N/A.
             */
            const packages: {name: string; version: string; displayVersion: string;}[] = lockfile
                ? DashboardController._packagesFromLockfile(lockfile, project, projectName, ctx)
                : await DashboardController._packagesFromManifest(project, projectName, ctx, hooks);

            if (!lockfile) {
                if (packages.length === 0) {
                    skipColumnAsNa('no lockfile and no resolvable declared deps');
                } else {
                    columnNote = 'no lockfile — scanned against registry latest';
                }
            }

            if (packages.length > 0) {
                const packageCount = packages.length;
                hooks.captureNames(unid, packages.map((p) => p.name));

                /*
                 * Installed-size aggregate over the *display* (registry-
                 * semver) versions so the packument lookup hits — using
                 * `pkg.resolved` for git deps here would miss the cache
                 * entirely. Git deps fall out of the sum and show up in
                 * `coverage.covered / coverage.total`.
                 */
                try {
                    columnSize = await InstalledSize.compute(
                        packages.map((p) => ({name: p.name, version: p.displayVersion})),
                        ctx.loaded.registry
                    );
                } catch {
                    // best-effort; leave undefined
                }

                await DashboardController._runPerPackageScanners(
                    ctx, projectName, packages, packageCount, emitCell, hooks
                );
                if (hooks.isAborted()) {
                    return DashboardController._buildColumn(unid, project, projectName, cells, columnError, columnNote, columnSize);
                }

                await DashboardController._runPerProjectScanners(
                    ctx, project, projectName, lockfile, packageCount, emitCell, hooks
                );
            }
        } catch (e) {
            columnError = (e as Error).message;
            for (const id of SCANNER_IDS) {
                if (!(id in cells)) {
                    emitCell(id, DashboardBuilder.naCell(columnError));
                }
            }
        }

        return DashboardController._buildColumn(unid, project, projectName, cells, columnError, columnNote, columnSize);
    }

    private static _buildColumn(
        unid: string,
        project: Project,
        projectName: string,
        cells: Partial<Record<ScannerId, DashboardCell>>,
        columnError: string|undefined,
        columnNote: string|undefined,
        columnSize: {totalBytes: number; coveredCount: number; totalCount: number;}|undefined
    ): DashboardColumn {
        return {
            project: {unid: unid, name: projectName, type: project.getType()},
            cells: cells,
            ...columnError ? {error: columnError} : {},
            ...columnNote ? {note: columnNote} : {},
            ...columnSize === undefined ? {} : {sizeBytes: columnSize.totalBytes},
            ...columnSize ? {
                sizeCoverage: {
                    covered: columnSize.coveredCount,
                    total: columnSize.totalCount
                }
            } : {}
        };
    }

    /*
     * Lockfile path: snapshots the package set into the HistoryStore so
     * the Trend tab "Packages" metric stays populated for Dashboard-only
     * users, then dedupes by `name@scanVersion`. Git-sourced deps use
     * the resolved URL as the scan version so name-keyed lookups don't
     * hit an unrelated public package; the human-readable semver is
     * kept around as `displayVersion`.
     */
    private static _packagesFromLockfile(
        lockfile: Lockfile,
        project: Project,
        projectName: string,
        ctx: ServerContext
    ): {name: string; version: string; displayVersion: string;}[] {
        try {
            ctx.historyStore.recordSnapshot(
                project.getKey(),
                projectName,
                lockfile.source,
                lockfile.packages.map((p) => ({name: p.name, version: p.version}))
            );
        } catch (e) {
            console.warn(`nppm: dashboard history snapshot failed for ${projectName}: ${(e as Error).message}`);
        }

        const seen = new Set<string>();
        const out: {name: string; version: string; displayVersion: string;}[] = [];
        for (const pkg of lockfile.packages) {
            const useGitUrl = pkg.resolved && GitResolver.isGitVersion(pkg.resolved);
            const scanVersion = useGitUrl ? pkg.resolved! : pkg.version;
            const key = `${pkg.name}@${scanVersion}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push({name: pkg.name, version: scanVersion, displayVersion: pkg.version});
        }
        return out;
    }

    /*
     * Manifest fallback: resolve every declared dep to the registry's
     * `latest` — what `npm install` would pull today. Deps with no
     * registry entry (private packages, git URLs) are kept by reference
     * to the user-typed range so they still appear; OSV / name-keyed
     * scanners skip them via the `GitResolver.isGitVersion` guard.
     */
    private static async _packagesFromManifest(
        project: Project,
        projectName: string,
        ctx: ServerContext,
        hooks: ScanColumnHooks
    ): Promise<{name: string; version: string; displayVersion: string;}[]> {
        hooks.send('progress', {
            current: hooks.getCellsDone(),
            total: hooks.totalCells,
            projectName: projectName,
            scanner: null,
            detail: `No lockfile — resolving declared deps for ${projectName}`
        });
        const manifests = await project.loadManifests();
        const rootManifest = manifests.find((m) => m.workspace === undefined);
        const declared = rootManifest?.dependencies ?? [];
        const resolved = await Promise.all(declared.map(async(d) => {
            if (GitResolver.isGitVersion(d.version)) {
                return {name: d.name, version: d.version, displayVersion: d.version};
            }
            const reg = await ctx.loaded.registry.fetchOne(d.name);
            const latest = reg?.latest ?? null;
            if (!latest) {
                return null;
            }
            return {name: d.name, version: latest, displayVersion: d.version};
        }));
        const seen = new Set<string>();
        const out: {name: string; version: string; displayVersion: string;}[] = [];
        for (const entry of resolved) {
            if (!entry) {
                continue;
            }
            const key = `${entry.name}@${entry.version}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push(entry);
        }
        return out;
    }

    /*
     * Per-package scanner phase: kicks off the three batched calls
     * (OSV + scanHeuristicsBatch + scanChurnBatch) in parallel, then
     * folds each package's result into 16 per-package cells.
     */
    // eslint-disable-next-line max-lines-per-function
    private static async _runPerPackageScanners(
        ctx: ServerContext,
        projectName: string,
        packages: {name: string; version: string; displayVersion: string;}[],
        packageCount: number,
        emitCell: (scanner: ScannerId, cell: DashboardCell) => void,
        hooks: ScanColumnHooks
    ): Promise<void> {
        const {osvClient, securityScanner} = ctx.loaded;

        /*
         * Announce the slow phase first so the progress bar already
         * shows what's happening while the parallel batches run. We
         * thread per-package onProgress callbacks into the heuristics
         * + churn batches so the user sees "Fingerprinting lodash@4.17.21
         * (32/84)" instead of a frozen 0/84 — OSV is one HTTP request
         * so its only sub-phase is "Querying OSV.dev for N packages".
         */
        hooks.send('progress', {
            current: hooks.getCellsDone(),
            total: hooks.totalCells,
            projectName: projectName,
            scanner: 'cve' as ScannerId,
            detail: `Querying OSV.dev for ${packages.length} package(s) — ${projectName}`
        });

        const emitPkgDetail = (phase: string) =>
            (pkgDone: number, pkgTotal: number, pkg: {name: string; version: string;}): void => {
                hooks.send('progress', {
                    current: hooks.getCellsDone(),
                    total: hooks.totalCells,
                    projectName: projectName,
                    scanner: 'cve' as ScannerId,
                    detail: `${phase} ${pkg.name}@${pkg.version} (${pkgDone}/${pkgTotal}) — ${projectName}`
                });
            };

        const [osvMap, heuristics, churns] = await Promise.all([
            osvClient.queryBatch(packages),
            securityScanner.scanHeuristicsBatch(packages, 10, emitPkgDetail('Fingerprinting')),
            securityScanner.scanChurnBatch(packages, 10, emitPkgDetail('Churn for'))
        ]);

        if (hooks.isAborted()) {
            return;
        }

        const perScanner: Record<string, (ReturnType<typeof DashboardBuilder.cveSeverity>)[]> = {
            cve: [], license: [], scripts: [], patterns: [],
            binaries: [], obfuscation: [], manifestRedFlags: [], capability: [],
            maintainer: [], churn: [], cadence: [],
            freshness: [], ignoreScripts: [], typosquat: [], provenance: [],
            external: [], deprecation: []
        };
        const perFindings: Record<string, CellFinding[]> = {
            cve: [], license: [], scripts: [], patterns: [],
            binaries: [], obfuscation: [], manifestRedFlags: [], capability: [],
            maintainer: [], churn: [], cadence: [],
            freshness: [], ignoreScripts: [], typosquat: [], provenance: [],
            external: [], deprecation: []
        };

        const pushFinding = (scanner: ScannerId, label: string,
            sev: ReturnType<typeof DashboardBuilder.cveSeverity>, detail?: string): void => {
            if (sev === null) {
                return;
            }
            perFindings[scanner].push({label: label, severity: sev, detail: detail});
        };

        for (let i = 0; i < packages.length; i++) {
            const h = heuristics[i];
            /*
             * Label uses the human-readable semver (e.g.
             * `figtree@1.0.21`); the OSV map is keyed by the
             * exact coordinate that was queried, which for
             * git deps is the resolved git URL.
             */
            const label = `${packages[i].name}@${packages[i].displayVersion}`;
            const pkgKey = `${packages[i].name}@${packages[i].version}`;
            const osvIds = osvMap.get(pkgKey) ?? null;

            const cve = DashboardBuilder.cveSeverity(osvIds);
            perScanner.cve.push(cve);
            pushFinding('cve', label, cve, osvIds && osvIds.length > 0
                ? osvIds.slice(0, 3).join(', ') : undefined);

            const lic = DashboardBuilder.licenseSeverity(h.license);
            perScanner.license.push(lic);
            pushFinding('license', label, lic, h.license.spdx ?? undefined);

            const sc = DashboardBuilder.scriptsSeverity(h.scripts);
            perScanner.scripts.push(sc);
            pushFinding('scripts', label, sc, `${h.scripts.count} hook(s)`);

            const pat = DashboardBuilder.patternsSeverity(h.patterns);
            perScanner.patterns.push(pat);
            pushFinding('patterns', label, pat, `${h.patterns.count} match(es)`);

            const bin = DashboardBuilder.binariesSeverity(h.binaries);
            perScanner.binaries.push(bin);
            pushFinding('binaries', label, bin, `${h.binaries.totalCount} file(s)`);

            const obf = DashboardBuilder.obfuscationSeverity(h.obfuscation);
            perScanner.obfuscation.push(obf);
            pushFinding('obfuscation', label, obf,
                h.obfuscation.count > 0 ? `${h.obfuscation.count} file(s)` : undefined);

            const mrf = DashboardBuilder.manifestRedFlagsSeverity(h.manifestRedFlags);
            perScanner.manifestRedFlags.push(mrf);
            pushFinding('manifestRedFlags', label, mrf,
                h.manifestRedFlags.count > 0 ? `${h.manifestRedFlags.count} flag(s)` : undefined);

            const cap = DashboardBuilder.capabilitySeverity(h.capability);
            perScanner.capability.push(cap);
            pushFinding('capability', label, cap,
                h.capability.count > 0 ? `${h.capability.count} capability(ies)` : undefined);

            const main = DashboardBuilder.maintainerSeverity(h.maintainer);
            perScanner.maintainer.push(main);
            pushFinding('maintainer', label, main, h.maintainer.publisher ?? undefined);

            const ch = DashboardBuilder.churnSeverity(churns[i]);
            perScanner.churn.push(ch);
            if (ch !== null && churns[i]) {
                const f = churns[i]!;
                pushFinding('churn', label, ch, `${f.bumpType} bump · ${f.added + f.removed + f.modified} files`);
            }

            const cad = DashboardBuilder.cadenceSeverity(h.cadence);
            perScanner.cadence.push(cad);
            pushFinding('cadence', label, cad,
                h.cadence.daysSinceLastRelease === null
                    ? undefined
                    : `${h.cadence.daysSinceLastRelease}d since last release`);

            const fr = DashboardBuilder.freshnessSeverity(h.freshness);
            perScanner.freshness.push(fr);
            pushFinding('freshness', label, fr,
                h.freshness.packageAgeDays === null
                    ? undefined
                    : `${h.freshness.packageAgeDays}d package age`);

            /*
             * ignoreScripts is derived heuristically from the
             * batched scripts.maxSeverity since the batch entry
             * doesn't carry the IgnoreScriptsFinding directly.
             */
            const ign = DashboardController._ignoreScriptsSeverity(h.scripts.maxSeverity);
            perScanner.ignoreScripts.push(ign);
            pushFinding('ignoreScripts', label, ign,
                DashboardController._ignoreScriptsDetail(ign));

            const ty = DashboardBuilder.typosquatSeverity(h.typosquat);
            perScanner.typosquat.push(ty);
            pushFinding('typosquat', label, ty,
                h.typosquat.closestMatch
                    ? `vs. ${h.typosquat.closestMatch}` : undefined);

            const pv = DashboardBuilder.provenanceSeverity(h.provenance);
            perScanner.provenance.push(pv);
            pushFinding('provenance', label, pv,
                h.provenance.level ?? undefined);

            const ext = DashboardBuilder.externalSeverity(h.external);
            perScanner.external.push(ext);
            pushFinding('external', label, ext,
                h.external.count > 0 ? `${h.external.count} source(s)` : undefined);

            const dep = DashboardBuilder.deprecationSeverity(h.deprecation);
            perScanner.deprecation.push(dep);
            pushFinding('deprecation', label, dep, DashboardController._deprecationDetail(dep));
        }

        /*
         * Per-package cells (16 scanners). Each one's findings list
         * is sorted + capped inside the builder.
         */
        const perPackageScanners: ScannerId[] = [
            'cve', 'license', 'scripts', 'patterns', 'binaries', 'obfuscation',
            'manifestRedFlags', 'capability',
            'maintainer', 'churn', 'cadence', 'freshness',
            'ignoreScripts', 'typosquat', 'provenance', 'deprecation'
        ];
        for (const id of perPackageScanners) {
            emitCell(id, DashboardBuilder.scorePerPackage(
                perScanner[id], packageCount, perFindings[id]
            ));
            if (hooks.isAborted()) {
                return;
            }
        }

        /*
         * External-sources column: N/A when no source is configured
         * (avoids a misleading 100/100 when every flag is off). When
         * at least one source is enabled, normal per-package scoring
         * applies.
         */
        if (securityScanner.hasExternalSources()) {
            emitCell('external', DashboardBuilder.scorePerPackage(
                perScanner.external, packageCount, perFindings.external
            ));
        } else {
            emitCell('external', DashboardBuilder.naCell('no external source configured'));
        }
    }

    /*
     * Per-project phase: scanners that need the whole lockfile or
     * project context (integrity, mutable resolution, unused,
     * template). Each one emits its own cell + progress event.
     */
    private static async _runPerProjectScanners(
        ctx: ServerContext,
        project: Project,
        projectName: string,
        lockfile: Lockfile|null,
        packageCount: number,
        emitCell: (scanner: ScannerId, cell: DashboardCell) => void,
        hooks: ScanColumnHooks
    ): Promise<void> {
        /*
         * Integrity + Mutable-resolution both walk the lockfile, so
         * they have nothing to compare against when we're scanning
         * from the manifest fallback. Emit a clear N/A instead of
         * silently scoring 100/100.
         */
        hooks.send('progress', {
            current: hooks.getCellsDone(),
            total: hooks.totalCells,
            projectName: projectName,
            scanner: 'integrity' as ScannerId
        });
        if (lockfile) {
            const integrityFindings = await ctx.integrityScanner.scan(lockfile.packages);
            const integritySevs = integrityFindings.map((f) => DashboardBuilder.integritySeverity(f));
            const integrityCellFindings: CellFinding[] = integrityFindings.map((f) => ({
                label: `${f.name}@${f.version}`,
                severity: DashboardBuilder.integritySeverity(f),
                detail: f.kind
            }));
            emitCell('integrity', DashboardBuilder.scorePerProject(
                integritySevs, packageCount, integrityCellFindings
            ));
        } else {
            emitCell('integrity', DashboardBuilder.naCell('no lockfile'));
        }

        hooks.send('progress', {
            current: hooks.getCellsDone(),
            total: hooks.totalCells,
            projectName: projectName,
            scanner: 'mutableResolution' as ScannerId
        });
        if (lockfile) {
            const mutableResolutionReport = MutableResolutionScanner.scan(lockfile);
            emitCell('mutableResolution', DashboardBuilder.mutableResolutionCell(mutableResolutionReport));
        } else {
            emitCell('mutableResolution', DashboardBuilder.naCell('no lockfile'));
        }

        /*
         * Unused — only on local projects; remote sources surface as
         * N/A via the detector's `supported` flag, which `unusedCell`
         * translates for us.
         */
        hooks.send('progress', {
            current: hooks.getCellsDone(),
            total: hooks.totalCells,
            projectName: projectName,
            scanner: 'unused' as ScannerId
        });
        const unusedReport = await ctx.loaded.unusedDetector.scan(project);
        emitCell('unused', DashboardBuilder.unusedCell(unusedReport, packageCount));

        /*
         * Template compliance — runs only when the project lists at
         * least one template id; the resolver is the same as the
         * per-project /api/projects/:id/compliance route.
         */
        hooks.send('progress', {
            current: hooks.getCellsDone(),
            total: hooks.totalCells,
            projectName: projectName,
            scanner: 'template' as ScannerId
        });
        const declared = project.getTemplates();
        if (declared.length === 0) {
            emitCell('template', DashboardBuilder.naCell('no templates declared'));
            return;
        }
        const templates = ctx.refreshTemplates();
        const knownIds = declared.filter((id) => templates.has(id));
        const resolver = new TemplateResolver(
            templates,
            (id) => ctx.templateLoader.getFilesDir(id)
        );
        const resolved = resolver.resolve(knownIds);
        const manifests = await project.loadManifests();
        const projectRoot = project instanceof ProjectLocal
            ? project.getRoot()
            : undefined;
        const report = ctx.templateChecker.check(manifests, resolved, {projectRoot: projectRoot});
        const sevs = report.findings.map((f) => DashboardBuilder.complianceSeverity(f));
        const tplCellFindings: CellFinding[] = report.findings.map((f) => ({
            label: f.target,
            severity: DashboardBuilder.complianceSeverity(f),
            detail: f.kind
        }));
        emitCell('template', DashboardBuilder.scorePerProject(
            sevs, packageCount, tplCellFindings
        ));
    }

    /**
     * Post-loop downloads pass: collect every distinct name installed
     * by any project, batch-fetch from the npm public downloads API,
     * then fold into per-project sums (within-project deduped) +
     * ecosystem-deduped total. Best-effort — a network failure here
     * just leaves the downloads fields unset on the columns.
     */
    private static async _fetchDownloads(
        ctx: ServerContext,
        projectNames: Map<string, string[]>,
        columns: DashboardColumn[],
        cellsDone: number,
        totalCells: number,
        send: (event: string, data: object) => void
    ): Promise<number|null> {
        try {
            const everyName = new Set<string>();
            for (const ns of projectNames.values()) {
                for (const n of ns) {
                    everyName.add(n);
                }
            }
            if (everyName.size === 0) {
                return null;
            }
            send('progress', {
                current: cellsDone,
                total: totalCells,
                projectName: '',
                scanner: null,
                detail: `Fetching weekly downloads for ${everyName.size} distinct package(s)`
            });
            const downloadsByName = await ctx.downloadsFetcher.fetchMany(
                Array.from(everyName),
                (fetched, total): void => {
                    send('progress', {
                        current: cellsDone,
                        total: totalCells,
                        projectName: '',
                        scanner: null,
                        detail: `Fetching weekly downloads (${fetched}/${total})`
                    });
                }
            );
            const folded = DownloadsAggregator.fold(projectNames, downloadsByName);
            for (const col of columns) {
                const v = folded.perProject.get(col.project.unid);
                if (typeof v === 'number') {
                    col.downloadsLastWeek = v;
                }
            }
            return folded.ecosystemDeduped;
        } catch (e) {
            console.warn(`nppm: dashboard downloads fetch failed: ${(e as Error).message}`);
            return null;
        }
    }

    /**
     * Persist the result so the next view-open can render an
     * immediate first-paint without waiting for a fresh SSE scan.
     * Failure to write is non-fatal — the user just gets the empty
     * state next time. Also appends (or overwrites, for same-UTC-day)
     * the compact daily record powering the Trend tab + macro-donut
     * delta.
     */
    private static _persistSnapshot(
        ctx: ServerContext,
        dashboard: ApiDashboardResponse,
        ecosystemDownloads: number|null
    ): void {
        try {
            const cacheDir = ctx.loaded.cacheDir;
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, {recursive: true});
            }
            const payload: ApiDashboardSnapshotResponse = {
                snapshot: dashboard,
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(ctx.dashboardSnapshotPath, JSON.stringify(payload));
            try {
                ctx.dashboardHistoryStore.recordScan(
                    dashboard, payload.timestamp!, ecosystemDownloads
                );
            } catch (e) {
                console.warn(`nppm: dashboard history save failed: ${(e as Error).message}`);
            }
        } catch (e) {
            console.warn(`nppm: dashboard snapshot save failed: ${(e as Error).message}`);
        }
    }

    /*
     * Scripts.maxSeverity → ignoreScripts severity. The batch entry
     * doesn't carry the IgnoreScriptsFinding directly so we derive it
     * by mapping `risk → risk` and `warn → info`; everything else
     * (incl. null) is null.
     */
    private static _ignoreScriptsSeverity(
        maxSeverity: 'risk'|'warn'|'info'|null|undefined
    ): ReturnType<typeof DashboardBuilder.cveSeverity> {
        if (maxSeverity === 'risk') {
            return 'risk';
        }
        if (maxSeverity === 'warn') {
            return 'info';
        }
        return null;
    }

    private static _ignoreScriptsDetail(
        sev: ReturnType<typeof DashboardBuilder.cveSeverity>
    ): string|undefined {
        if (sev === 'risk') {
            return 'avoid --ignore-scripts';
        }
        if (sev === 'info') {
            return 'needs scripts';
        }
        return undefined;
    }

    private static _deprecationDetail(
        sev: ReturnType<typeof DashboardBuilder.cveSeverity>
    ): string|undefined {
        if (sev === 'risk') {
            return 'this version deprecated';
        }
        if (sev === 'warn') {
            return 'latest deprecated';
        }
        if (sev === 'info') {
            return 'older version(s) deprecated';
        }
        return undefined;
    }

}

/**
 * Closure-shaped state shared between `_scanProject` and its sub-
 * scanners. Kept as a single bag so the method signatures stay
 * readable — `cellsDone` is the only piece that mutates across
 * iterations, hence the getter/bump pair instead of passing a number.
 */
type ScanColumnHooks = {
    totalCells: number;
    getCellsDone: () => number;
    bumpCellsDone: () => void;
    send: (event: string, data: object) => void;
    isAborted: () => boolean;
    captureNames: (unid: string, names: string[]) => void;
};