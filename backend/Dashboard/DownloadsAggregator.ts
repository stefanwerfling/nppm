/**
 * Result of folding per-name downloads into per-project + ecosystem
 * totals. The two layers have intentionally different dedupe
 * semantics:
 *
 *   - `perProject[unid]` sums each project's *distinct* installed
 *     package names once. A project that pulls in `react` through
 *     multiple paths counts it once, but two projects each pull it
 *     in independently.
 *
 *   - `ecosystemDeduped` is the union: every name installed *anywhere*
 *     counted exactly once. A package shared between three projects
 *     drives `Σ perProject` higher than `ecosystemDeduped` — that gap
 *     is itself informative (how much overlap there is across the
 *     fleet's dep trees).
 */
export type DownloadsAggregateResult = {
    perProject: Map<string, number>;
    ecosystemDeduped: number;
};

/**
 * Folds per-name download counts into per-project + ecosystem
 * aggregates. Pure, stateless, sync — the SSE handler and the test
 * suite share the same code path.
 */
export class DownloadsAggregator {

    /**
     * @param projectNames   Map<projectUnid, names[]> — every name
     *                       declared/installed in that project. Order
     *                       doesn't matter; duplicates are tolerated
     *                       (collapsed in the per-project Set).
     * @param downloadsByName Map<name, weekly-downloads | null>.
     *                       `null` (and missing keys) contribute zero
     *                       — best-effort floor like the size aggregate.
     */
    public static fold(
        projectNames: Map<string, string[]>,
        downloadsByName: Map<string, number|null>
    ): DownloadsAggregateResult {
        const perProject = new Map<string, number>();
        const seenAcrossEcosystem = new Set<string>();
        let ecosystem = 0;

        for (const [unid, names] of projectNames) {
            const distinct = new Set<string>(names);
            let projectSum = 0;
            for (const name of distinct) {
                const d = downloadsByName.get(name);
                if (typeof d === 'number') {
                    projectSum += d;
                }
                if (!seenAcrossEcosystem.has(name)) {
                    seenAcrossEcosystem.add(name);
                    if (typeof d === 'number') {
                        ecosystem += d;
                    }
                }
            }
            perProject.set(unid, projectSum);
        }

        return {perProject, ecosystemDeduped: ecosystem};
    }
}