import {ConfigProjectType} from '../Config/Config.js';

/**
 * One source file in the graph. The id is the project-relative POSIX
 * path (forward slashes regardless of host OS) — stable across hosts
 * so the cache survives moving the project to a new machine. `kind`
 * carries the broad role of the file so the renderer can colour-code
 * (entry / source / test / config / unknown). `loc` is a cheap
 * line-count for node sizing; we don't need a real LOC algorithm,
 * the file's newline count is good enough.
 */
export type SourceFile = {
    id: string;
    kind: SourceFileKind;
    loc: number;
};

export type SourceFileKind = 'entry'|'source'|'test'|'config';

/**
 * One directed import edge `from → to`. Both ids reference entries in
 * `SourceGraphData.files`. Only resolved relative imports become
 * edges; bare specifiers (npm package deps) are handled by the
 * existing dep-graph pipeline.
 */
export type SourceEdge = {
    from: string;
    to: string;
};

/**
 * Aggregate response for `GET /api/projects/:id/source-graph`.
 * `supported: false` is the sentinel for remote projects (GitHub /
 * Gitea) — the contents-API walk would be too expensive for v1, same
 * reasoning as `UnusedDetector`.
 */
export type SourceGraphData = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    supported: boolean;
    /** Set when `supported = false` — human-readable explanation. */
    unsupportedReason?: string;
    files: SourceFile[];
    edges: SourceEdge[];
    /**
     * Specifiers the regex parser couldn't resolve (dynamic
     * `import(varName)`, missing target file, etc). The edge is
     * dropped so the graph stays in sync with what we can actually
     * draw; the user sees a count in the UI.
     */
    unresolved: number;
    /** Files walked (matched a source extension). */
    filesScanned: number;
};