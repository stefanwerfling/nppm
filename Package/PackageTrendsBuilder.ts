import {RegistryPackage} from '../Registry/Registry.js';

/**
 * One row in the per-version timeline. Sorted chronologically
 * (oldest first) so the frontend can iterate left-to-right without a
 * re-sort. `releasedAt: null` only happens on very old packages
 * whose registry record predates the `time` field — those rows are
 * still emitted so the dep / publisher columns of the panel can show
 * them, just without a date.
 */
export type PackageVersionMeta = {
    version: string;
    releasedAt: string|null;
    unpackedSize: number|null;
    fileCount: number|null;
    publisher: string|null;
};

/**
 * Releases bucketed by calendar month, YYYY-MM keys. Months without
 * any release are omitted — the renderer back-fills zeros across the
 * displayed range.
 */
export type ReleaseMonthBucket = {
    month: string;
    count: number;
};

/**
 * Compact per-package response surfaced via `/api/packages/:name/trends`.
 * Downloads attached separately by the route handler (fetched async
 * from the npm public downloads API) — kept on the same response so
 * the frontend renders all three charts from a single fetch.
 */
export type PackageTrendsResponse = {
    name: string;
    versions: PackageVersionMeta[];
    releasesByMonth: ReleaseMonthBucket[];
    downloads: {day: string; downloads: number}[]|null;
};

/**
 * Folds a `RegistryPackage` into the timeline shape the per-package
 * Trends tab consumes. Pure, stateless, sync — the downloads pass
 * happens in the route handler because it's async and IO-bound.
 *
 * The registry's `time` map carries auxiliary keys like `modified`
 * and `created` alongside the per-version timestamps. We strip those
 * before mapping; only entries whose key matches a real version go
 * into the timeline.
 */
export class PackageTrendsBuilder {

    /**
     * Build the timeline + monthly histogram from one packument.
     * Versions listed under `pkg.versions` but missing from `time`
     * still appear in the timeline with `releasedAt: null`; releases
     * with a date but no matching version (mostly the `modified` /
     * `created` aux keys) are dropped.
     */
    public static build(pkg: RegistryPackage): Omit<PackageTrendsResponse, 'downloads'> {
        const knownVersions = new Set(pkg.versions);
        const time = pkg.time ?? {};

        const meta: PackageVersionMeta[] = [];
        for (const version of pkg.versions) {
            const releasedAt = typeof time[version] === 'string' ? time[version] : null;
            const dist = pkg.dist?.[version];
            const publisher = pkg.publishers?.[version]?.name ?? null;
            meta.push({
                version,
                releasedAt,
                unpackedSize: typeof dist?.unpackedSize === 'number' ? dist.unpackedSize : null,
                fileCount: typeof dist?.fileCount === 'number' ? dist.fileCount : null,
                publisher
            });
        }

        // Chronological — undated rows sort to the bottom so the
        // chart doesn't bunch them at the left edge of the X axis.
        meta.sort((a, b) => {
            if (a.releasedAt === null && b.releasedAt === null) {
                return a.version.localeCompare(b.version);
            }
            if (a.releasedAt === null) {
                return 1;
            }
            if (b.releasedAt === null) {
                return -1;
            }
            return a.releasedAt.localeCompare(b.releasedAt);
        });

        // Releases per calendar month. Keys are sorted lexically;
        // YYYY-MM sorts chronologically as text so no Date() parsing
        // needed in the bucket loop.
        const byMonth = new Map<string, number>();
        for (const [version, ts] of Object.entries(time)) {
            if (!knownVersions.has(version)) {
                continue;
            }
            if (typeof ts !== 'string' || ts.length < 7) {
                continue;
            }
            const month = ts.slice(0, 7);
            byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
        }
        const releasesByMonth: ReleaseMonthBucket[] = [];
        for (const [month, count] of byMonth) {
            releasesByMonth.push({month, count});
        }
        releasesByMonth.sort((a, b) => a.month.localeCompare(b.month));

        return {
            name: pkg.name,
            versions: meta,
            releasesByMonth
        };
    }
}