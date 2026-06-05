import {Registry} from '../Registry/Registry.js';

/**
 * Result of one project's installed-size aggregation. `totalBytes` is
 * the sum of `dist.unpackedSize` for every (name, version) pair the
 * lockfile lists, looked up against the registry packument cache.
 *
 * `coveredCount / totalCount` lets the UI label the number as a
 * best-effort floor: very old npm packages, git-resolved deps, and
 * private registries that don't expose `unpackedSize` all drop out
 * of the sum. A coverage of 0.9 means the displayed bytes are ~90 %
 * of the true installed footprint.
 */
export type InstalledSizeResult = {
    totalBytes: number;
    coveredCount: number;
    totalCount: number;
};

/**
 * Sums installed bytes across a lockfile-derived package set by
 * looking up each (name, version) in the registry packument cache.
 * Stateless — both inputs and outputs are plain data, so the
 * dashboard SSE handler and the test suite share the same code
 * path. All registry calls go through the existing `Registry`
 * instance, which is cache-first; warm runs add no HTTP.
 */
export class InstalledSize {

    /**
     * Compute the total unpacked-bytes footprint for one project's
     * package list. Git-versioned coordinates (where `version`
     * doesn't appear in the packument's `dist` map) are skipped from
     * the sum and counted in `totalCount` only — they show up in the
     * UI as "uncovered" without skewing the size.
     */
    public static async compute(
        packages: {name: string; version: string;}[],
        registry: Registry
    ): Promise<InstalledSizeResult> {
        let totalBytes = 0;
        let covered = 0;
        for (const pkg of packages) {
            const reg = await registry.fetchOne(pkg.name);
            const sz = reg?.dist?.[pkg.version]?.unpackedSize;
            if (typeof sz === 'number' && sz >= 0) {
                totalBytes += sz;
                covered++;
            }
        }
        return {totalBytes: totalBytes, coveredCount: covered, totalCount: packages.length};
    }

}