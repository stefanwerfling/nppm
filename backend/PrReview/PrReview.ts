import {ConfigProjectType} from '../Config/Config.js';
import {DependencyType} from '../Project/PackageManifest.js';

/**
 * How a single dep moved between `base` and `head`. The four buckets
 * mirror the deltas a reviewer cares about — added/removed are
 * obvious, `updated` means the version (declared or resolved) changed,
 * `bucket-changed` flags moves between `dependencies` /
 * `devDependencies` / `peer` / `optional` (typically a hygiene fix the
 * reviewer should rubber-stamp).
 */
export type PrChangeKind = 'added'|'removed'|'updated'|'bucket-changed';

/**
 * One dep change between the two refs. Declared values come from the
 * project's `package.json` (so semver ranges, plus the bucket).
 * Resolved values come from `package-lock.json` (so concrete versions
 * that actually got installed). The two can disagree — e.g. a
 * `^4.0.0` range satisfied by `4.17.20` before and `4.17.21` after
 * carries an unchanged `declared*` but a bumped `resolved*` pair.
 *
 * `vulns*` are arrays of OSV vuln IDs sourced from the cache; `null`
 * means we never asked OSV for that coordinate. `vulnsAdded` /
 * `vulnsRemoved` are the set differences — the headline numbers in
 * the UI.
 */
export type PrDepChange = {
    name: string;
    kind: PrChangeKind;

    /** Bucket in `package.json` on the base ref (undefined when added). */
    declaredBucketBefore?: DependencyType;
    /** Bucket on the head ref (undefined when removed). */
    declaredBucketAfter?: DependencyType;

    /** Declared range on base (e.g. `^4.0.0`); undefined when added. */
    declaredRangeBefore?: string;
    declaredRangeAfter?: string;

    /** Resolved version from `package-lock.json` on base / head. */
    resolvedBefore?: string;
    resolvedAfter?: string;

    /** OSV vuln IDs sourced from the cache for each side. */
    vulnsBefore: string[]|null;
    vulnsAfter: string[]|null;
    /** IDs in `vulnsAfter` but not `vulnsBefore` — new exposures. */
    vulnsAdded: string[];
    /** IDs in `vulnsBefore` but not `vulnsAfter` — closed by the PR. */
    vulnsRemoved: string[];
};

/**
 * Aggregate counts for the summary banner at the top of the view.
 */
export type PrSummary = {
    added: number;
    removed: number;
    updated: number;
    bucketChanged: number;
    totalVulnsAdded: number;
    totalVulnsRemoved: number;
};

/**
 * Response of `GET /api/projects/:id/pr-review?base=&head=`. Wraps
 * the per-dep change list with enough metadata for the frontend to
 * render error banners (refs missing, project not local, etc).
 *
 * `notes` carries free-form caveats — e.g. "lockfile missing on base
 * — resolved-version delta unavailable for that side" — so reviewers
 * know what data they're missing without us having to throw.
 */
export type PrReviewReport = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    base: string;
    head: string;
    /** Whether the base ref resolved (false = unknown branch/sha). */
    baseExists: boolean;
    headExists: boolean;
    /** Sorted by `totalVulnsAdded` desc, then by name. */
    changes: PrDepChange[];
    summary: PrSummary;
    notes: string[];
};
