import {DepGraphNode, DepGraphResponse, DepGraphStatus} from '../DepGraph/DepGraphBuilder.js';

/**
 * One reachable instance of the queried package inside a single
 * project's resolved dep-graph. `kind` distinguishes a *declared*
 * top-level dep (`direct`) from a dep pulled in only via the
 * transitive closure. `path` is the shortest dependency chain from
 * a root dep to the hit, expressed as `name@version` keys (the same
 * keys the DepGraph uses), so the UI can render
 * `react → some-lib → lodash@4.17.21`.
 */
export type ImpactHit = {
    name: string;
    version: string;
    kind: 'direct'|'transitive';
    path: string[];
    status: DepGraphStatus;
    vulnCount: number;
};

/**
 * Per-project outcome of an impact query. `error` carries the
 * project-level failure (no lockfile, parse error) so the UI can
 * separate "scanned but clean" from "couldn't scan".
 */
export type ImpactProjectReport = {
    project: {unid: string; name: string; type: string;};
    hits: ImpactHit[];
    error?: string;
};

/**
 * Aggregate report for one impact query across every configured
 * project. Sort order:
 *  - `projects` (≥1 hit) — descending by hit count, ties broken by name
 *  - `cleanProjects` — name asc (scanned, zero matches)
 *  - `skippedProjects` — name asc (no lockfile or build error)
 */
export type ImpactReport = {
    query: {name: string; versionPattern: string|null;};
    totalHits: number;
    projects: ImpactProjectReport[];
    cleanProjects: {unid: string; name: string; type: string;}[];
    skippedProjects: {unid: string; name: string; type: string; reason: string;}[];
};

/**
 * Cross-project "blast-radius" analyzer. Given a `name` (and optional
 * `versionPattern`), walks every project's already-resolved dep-graph
 * and reports every reachable instance of the queried package — both
 * direct top-level deps and transitive paths.
 *
 * Use case: incident response. "lodash 4.17.x was just CVE'd, which
 * of my projects ship it, and which dep brings it in?" — the same
 * question that took half a day to answer during the event-stream /
 * ua-parser-js / colors.js / XZ-utils incidents.
 *
 * Implementation is intentionally stateless; the caller composes
 * `analyzeGraph` results across projects.
 */
export class ImpactAnalyzer {

    /**
     * Run the impact query against a single project's DepGraph.
     * Returns the per-project report; combine across projects in the
     * caller. Shortest-path reconstruction uses a BFS from the
     * declared root deps so the path always starts at something the
     * `package.json` actually lists.
     */
    public static analyzeGraph(
        graph: DepGraphResponse,
        name: string,
        versionPattern: string|null
    ): ImpactProjectReport {
        const matches: string[] = [];
        for (const key of Object.keys(graph.packages)) {
            const node = graph.packages[key];
            if (node.name !== name) {
                continue;
            }
            if (versionPattern !== null && !ImpactAnalyzer.versionMatches(node.version, versionPattern)) {
                continue;
            }
            matches.push(key);
        }

        if (matches.length === 0) {
            return {project: graph.project, hits: []};
        }

        const rootKeys = new Set<string>();
        for (const rd of graph.rootDeps) {
            rootKeys.add(`${rd.name}@${rd.version}`);
        }

        const hits: ImpactHit[] = [];
        for (const matchKey of matches) {
            const node = graph.packages[matchKey];
            const path = ImpactAnalyzer._bfsShortestPath(graph, matchKey);
            const kind: 'direct'|'transitive' = rootKeys.has(matchKey) ? 'direct' : 'transitive';
            hits.push({
                name: node.name,
                version: node.version,
                kind: kind,
                path: path,
                status: node.status,
                vulnCount: node.vulnCount
            });
        }

        hits.sort(ImpactAnalyzer._compareHits);
        return {project: graph.project, hits: hits};
    }

    /**
     * Build the aggregate report from per-project outcomes. The
     * caller wires the project loop (and decides whether a project
     * counts as "skipped" vs "error"); this just sorts + counts.
     */
    public static buildReport(
        query: {name: string; versionPattern: string|null;},
        perProject: ImpactProjectReport[],
        skipped: {unid: string; name: string; type: string; reason: string;}[]
    ): ImpactReport {
        const withHits: ImpactProjectReport[] = [];
        const clean: {unid: string; name: string; type: string;}[] = [];

        for (const pp of perProject) {
            if (pp.hits.length > 0) {
                withHits.push(pp);
            } else if (!pp.error) {
                clean.push({unid: pp.project.unid, name: pp.project.name, type: pp.project.type});
            }
        }

        withHits.sort((a, b) => {
            if (b.hits.length !== a.hits.length) {
                return b.hits.length - a.hits.length;
            }
            return a.project.name.localeCompare(b.project.name);
        });
        clean.sort((a, b) => a.name.localeCompare(b.name));
        skipped.sort((a, b) => a.name.localeCompare(b.name));

        let total = 0;
        for (const pp of withHits) {
            total += pp.hits.length;
        }

        return {
            query: query,
            totalHits: total,
            projects: withHits,
            cleanProjects: clean,
            skippedProjects: skipped
        };
    }

    /**
     * Permissive version-pattern matching used by the impact query.
     * Deliberately *not* full semver — the incident-response use case
     * is "match all 4.17.x" or "match 4.17.21 exactly", neither of
     * which needs `>=`/`<` semantics. Supported shapes:
     *   `4.17.21`  exact
     *   `4.17.x`   minor wildcard (treat `.x` as a trailing-dot prefix)
     *   `4.x`      major wildcard
     *   `4.17`     bare prefix — matches `4.17` and `4.17.*` but not `4.170.*`
     *   `4`        same idea at major level
     *   `*` / ``   match all (callers usually pass `null` instead)
     */
    public static versionMatches(version: string, pattern: string): boolean {
        if (pattern === '' || pattern === '*') {
            return true;
        }
        if (pattern.endsWith('.x')) {
            const prefix = pattern.slice(0, -1); // "4.17.x" → "4.17."
            return version.startsWith(prefix);
        }
        if (pattern === version) {
            return true;
        }
        return version.startsWith(`${pattern}.`);
    }

    private static _bfsShortestPath(graph: DepGraphResponse, target: string): string[] {
        const parent = new Map<string, string|null>();
        const queue: string[] = [];

        for (const rd of graph.rootDeps) {
            const key = `${rd.name}@${rd.version}`;
            if (!parent.has(key)) {
                parent.set(key, null);
                queue.push(key);
            }
        }

        let head = 0;
        let found = false;
        while (head < queue.length) {
            const cur = queue[head++];
            if (cur === target) {
                found = true;
                break;
            }
            const node: DepGraphNode|undefined = graph.packages[cur];
            if (!node) {
                continue;
            }
            for (const dep of node.deps) {
                const dk = `${dep.name}@${dep.version}`;
                if (parent.has(dk)) {
                    continue;
                }
                parent.set(dk, cur);
                queue.push(dk);
            }
        }

        if (!found) {
            /*
             * Target lives in the graph but isn't reachable from any
             * declared root — usually means a bundled / nohoist quirk.
             * Surface as a singleton path so the UI still renders it.
             */
            return [target];
        }

        const path: string[] = [];
        let cur: string|null = target;
        while (cur !== null) {
            path.unshift(cur);
            cur = parent.get(cur) ?? null;
        }
        return path;
    }

    private static _compareHits(a: ImpactHit, b: ImpactHit): number {
        /*
         * Direct hits first (more actionable for the user), then by
         * version desc so the newest pinned copy floats up, then by
         * path length asc so the shortest chain wins on ties.
         */
        if (a.kind !== b.kind) {
            return a.kind === 'direct' ? -1 : 1;
        }
        if (a.version !== b.version) {
            return b.version.localeCompare(a.version);
        }
        return a.path.length - b.path.length;
    }

}