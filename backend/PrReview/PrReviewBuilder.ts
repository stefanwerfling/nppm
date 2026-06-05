import {execFileSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {ConfigProjectType} from '../Config/Config.js';
import {LockfileReader} from '../Project/Lockfile.js';
import {DependencyType} from '../Project/PackageManifest.js';
import {OsvClient} from '../Security/OsvClient.js';
import {PrChangeKind, PrDepChange, PrReviewReport, PrSummary} from './PrReview.js';

/**
 * Pluggable shell for the two git commands the builder needs. Same
 * pattern as `GitHistoryBackfill.GitRunner` — keeps the suite offline
 * by letting tests inject an in-memory fake.
 */
export type GitFileReader = {
    isRepo: (cwd: string) => boolean;
    /** True when the ref resolves to a known commit. */
    refExists: (cwd: string, ref: string) => boolean;
    /** File contents at `<ref>:<file>`. Throws when the file is missing. */
    show: (cwd: string, ref: string, file: string) => string;
};

/** Minimal subset of `package.json` we read for the diff. */
type RawPackageJson = {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
};

/**
 * One side of the diff — a project's dep state at a specific ref.
 * Built from `package.json` + (optional) `package-lock.json`.
 */
type RefDepState = {
    /** Declared deps from `package.json`: name → {bucket, range}. */
    declared: Map<string, {bucket: DependencyType; range: string;}>;
    /** Top-level resolved versions from `package-lock.json`: name → version. */
    resolved: Map<string, string>;
    /** True when the lockfile was readable at this ref. */
    lockfilePresent: boolean;
};

/**
 * Builds a `PrReviewReport` for a local project by diffing
 * `package.json` + `package-lock.json` between two git refs.
 *
 * V1 surfaces only the CVE delta (the cheap, high-value signal):
 *  - decoupled per-dep adds / removes / updates / bucket-changes
 *  - OSV vuln IDs cached for the affected coordinates
 *  - the set differences `vulnsAdded` / `vulnsRemoved` per change
 *
 * Future expansion (out of V1 scope):
 *  - maintainer-change delta (one MaintainerScanner call per side)
 *  - install-script delta (full SecurityScanner.scan → tarball fetch)
 *  - bundle-size delta (would need a new bundlephobia-style fetcher)
 *
 * Local-only for now. Remote (GitHub/Gitea) would need the API path,
 * deferred to match `RemoteGitHistoryBackfill`'s arc.
 */
export class PrReviewBuilder {

    private readonly _reader: GitFileReader;
    private readonly _osv: OsvClient;

    constructor(osv: OsvClient, reader?: GitFileReader) {
        this._osv = osv;
        this._reader = reader ?? PrReviewBuilder._defaultReader();
    }

    public isAvailable(cwd: string): boolean {
        return this._reader.isRepo(cwd);
    }

    /**
     * Build the report for `cwd` between `baseRef` (typically `main`)
     * and `headRef` (typically `HEAD`). The result is fully populated
     * even when one of the refs is missing — the corresponding
     * `*Exists` flag flips and downstream code treats that side's
     * state as empty.
     */
    public async build(
        cwd: string,
        baseRef: string,
        headRef: string,
        meta: {unid: string; name: string; type: ConfigProjectType;}
    ): Promise<PrReviewReport> {
        const notes: string[] = [];

        if (!this._reader.isRepo(cwd)) {
            return PrReviewBuilder._emptyReport(meta, baseRef, headRef, false, false, [
                'Not a git repository — PR review unavailable.'
            ]);
        }

        const baseExists = this._reader.refExists(cwd, baseRef);
        const headExists = this._reader.refExists(cwd, headRef);

        if (!baseExists) {
            notes.push(`Base ref "${baseRef}" does not resolve.`);
        }
        if (!headExists) {
            notes.push(`Head ref "${headRef}" does not resolve.`);
        }

        const baseState = baseExists ? this._loadState(cwd, baseRef, notes, 'base') : PrReviewBuilder._emptyState();
        const headState = headExists ? this._loadState(cwd, headRef, notes, 'head') : PrReviewBuilder._emptyState();

        const changes = PrReviewBuilder._diffStates(baseState, headState);
        await this._annotateVulns(changes);

        changes.sort(PrReviewBuilder._compareChanges);

        const summary = PrReviewBuilder._summarize(changes);

        return {
            project: meta,
            base: baseRef,
            head: headRef,
            baseExists: baseExists,
            headExists: headExists,
            changes: changes,
            summary: summary,
            notes: notes
        };
    }

    private _loadState(cwd: string, ref: string, notes: string[], side: 'base'|'head'): RefDepState {
        let pkgJson: RawPackageJson;
        try {
            const raw = this._reader.show(cwd, ref, 'package.json');
            pkgJson = JSON.parse(raw) as RawPackageJson;
        } catch (e) {
            notes.push(`${side}: package.json unreadable (${(e as Error).message})`);
            return PrReviewBuilder._emptyState();
        }

        const declared = new Map<string, {bucket: DependencyType; range: string;}>();
        PrReviewBuilder._extractBucket(pkgJson.dependencies, DependencyType.dependency, declared);
        PrReviewBuilder._extractBucket(pkgJson.devDependencies, DependencyType.dev, declared);
        PrReviewBuilder._extractBucket(pkgJson.peerDependencies, DependencyType.peer, declared);
        PrReviewBuilder._extractBucket(pkgJson.optionalDependencies, DependencyType.optional, declared);

        let resolved = new Map<string, string>();
        let lockfilePresent = false;
        try {
            const raw = this._reader.show(cwd, ref, 'package-lock.json');
            const lockfile = LockfileReader.parse(raw, 'committed');
            resolved = LockfileReader.topLevelVersionMap(lockfile);
            lockfilePresent = true;
        } catch {
            /*
             * Missing lockfile at this ref is fine — the diff still
             * works off the declared deps. Resolved-version columns
             * just stay blank.
             */
            notes.push(`${side}: package-lock.json not committed at ${ref} — resolved-version delta omitted for that side.`);
        }

        return {declared: declared, resolved: resolved, lockfilePresent: lockfilePresent};
    }

    private static _extractBucket(
        raw: unknown,
        bucket: DependencyType,
        out: Map<string, {bucket: DependencyType; range: string;}>
    ): void {
        if (!raw || typeof raw !== 'object') {
            return;
        }
        for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof value === 'string') {
                /*
                 * First-bucket-wins matches npm semantics — a dep
                 * accidentally listed in both `dependencies` and
                 * `devDependencies` follows the runtime bucket.
                 */
                if (!out.has(name)) {
                    out.set(name, {bucket: bucket, range: value});
                }
            }
        }
    }

    private static _diffStates(base: RefDepState, head: RefDepState): PrDepChange[] {
        const allNames = new Set<string>();
        for (const n of base.declared.keys()) {
            allNames.add(n);
        }
        for (const n of head.declared.keys()) {
            allNames.add(n);
        }
        for (const n of base.resolved.keys()) {
            allNames.add(n);
        }
        for (const n of head.resolved.keys()) {
            allNames.add(n);
        }

        const out: PrDepChange[] = [];
        for (const name of allNames) {
            const beforeDecl = base.declared.get(name);
            const afterDecl = head.declared.get(name);
            const beforeResolved = base.resolved.get(name);
            const afterResolved = head.resolved.get(name);

            const declaredChanged = beforeDecl?.range !== afterDecl?.range;
            const bucketChanged = beforeDecl !== undefined
                && afterDecl !== undefined
                && beforeDecl.bucket !== afterDecl.bucket;
            const resolvedChanged = beforeResolved !== afterResolved;

            if (!declaredChanged && !bucketChanged && !resolvedChanged) {
                continue;
            }

            let kind: PrChangeKind;
            if (beforeDecl === undefined && beforeResolved === undefined) {
                kind = 'added';
            } else if (afterDecl === undefined && afterResolved === undefined) {
                kind = 'removed';
            } else if (bucketChanged && !declaredChanged && !resolvedChanged) {
                kind = 'bucket-changed';
            } else {
                kind = 'updated';
            }

            out.push({
                name: name,
                kind: kind,
                declaredBucketBefore: beforeDecl?.bucket,
                declaredBucketAfter: afterDecl?.bucket,
                declaredRangeBefore: beforeDecl?.range,
                declaredRangeAfter: afterDecl?.range,
                resolvedBefore: beforeResolved,
                resolvedAfter: afterResolved,
                vulnsBefore: null,
                vulnsAfter: null,
                vulnsAdded: [],
                vulnsRemoved: []
            });
        }
        return out;
    }

    private async _annotateVulns(changes: PrDepChange[]): Promise<void> {
        /*
         * Collect every (name, version) we want vuln data for. Only the
         * resolved (lockfile-pinned) versions go through OSV — the
         * declared ranges aren't OSV-queryable as-is.
         */
        const coords: {name: string; version: string;}[] = [];
        for (const c of changes) {
            if (c.resolvedBefore) {
                coords.push({name: c.name, version: c.resolvedBefore});
            }
            if (c.resolvedAfter) {
                coords.push({name: c.name, version: c.resolvedAfter});
            }
        }
        if (coords.length === 0) {
            return;
        }

        const map = await this._osv.queryBatch(coords);

        for (const c of changes) {
            if (c.resolvedBefore) {
                c.vulnsBefore = map.get(`${c.name}@${c.resolvedBefore}`) ?? null;
            }
            if (c.resolvedAfter) {
                c.vulnsAfter = map.get(`${c.name}@${c.resolvedAfter}`) ?? null;
            }

            const before = new Set(c.vulnsBefore ?? []);
            const after = new Set(c.vulnsAfter ?? []);
            c.vulnsAdded = [...after].filter((id) => !before.has(id)).sort();
            c.vulnsRemoved = [...before].filter((id) => !after.has(id)).sort();
        }
    }

    private static _summarize(changes: PrDepChange[]): PrSummary {
        let added = 0;
        let removed = 0;
        let updated = 0;
        let bucketChanged = 0;
        let totalVulnsAdded = 0;
        let totalVulnsRemoved = 0;
        for (const c of changes) {
            switch (c.kind) {
                case 'added': added++; break;
                case 'removed': removed++; break;
                case 'updated': updated++; break;
                case 'bucket-changed': bucketChanged++; break;
            }
            totalVulnsAdded += c.vulnsAdded.length;
            totalVulnsRemoved += c.vulnsRemoved.length;
        }
        return {added: added, removed: removed, updated: updated, bucketChanged: bucketChanged, totalVulnsAdded: totalVulnsAdded, totalVulnsRemoved: totalVulnsRemoved};
    }

    private static _compareChanges(a: PrDepChange, b: PrDepChange): number {
        if (a.vulnsAdded.length !== b.vulnsAdded.length) {
            return b.vulnsAdded.length - a.vulnsAdded.length;
        }
        if (a.vulnsRemoved.length !== b.vulnsRemoved.length) {
            return b.vulnsRemoved.length - a.vulnsRemoved.length;
        }
        return a.name.localeCompare(b.name);
    }

    private static _emptyState(): RefDepState {
        return {declared: new Map(), resolved: new Map(), lockfilePresent: false};
    }

    private static _emptyReport(
        meta: {unid: string; name: string; type: ConfigProjectType;},
        base: string,
        head: string,
        baseExists: boolean,
        headExists: boolean,
        notes: string[]
    ): PrReviewReport {
        return {
            project: meta,
            base: base,
            head: head,
            baseExists: baseExists,
            headExists: headExists,
            changes: [],
            summary: {
                added: 0,
                removed: 0,
                updated: 0,
                bucketChanged: 0,
                totalVulnsAdded: 0,
                totalVulnsRemoved: 0
            },
            notes: notes
        };
    }

    private static _defaultReader(): GitFileReader {
        const opts = {
            encoding: 'utf-8' as const,
            maxBuffer: 128 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'] as ('ignore'|'pipe')[]
        };
        return {
            isRepo: (cwd) => fs.existsSync(path.join(cwd, '.git')),
            refExists: (cwd, ref) => {
                try {
                    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {...opts, cwd: cwd});
                    return true;
                } catch {
                    return false;
                }
            },
            show: (cwd, ref, file) => execFileSync(
                'git',
                ['show', `${ref}:${file}`],
                {...opts, cwd: cwd}
            )
        };
    }

}