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
    /** Top-level function declarations (`function X` + `const X = (…) =>`). */
    functions: number;
    /** Top-level `class X` / `export class X` declarations. */
    classes: number;
    /** Count of TODO / FIXME / XXX / HACK markers (anywhere in the file). */
    todos: number;
    /**
     * Cyclomatic-complexity *proxy*: McCabe-style branch count. Each
     * `if` / `for` / `while` / `case` / `catch` / `&&` / `||` / `?:`
     * adds one — same recipe as eslint's `complexity` rule, just
     * regex-cheap instead of AST-precise.
     */
    complexity: number;
    /**
     * Whether a sibling test file exists in the same project (e.g.
     * `Foo.test.ts` next to `Foo.ts`, or `__tests__/Foo.ts`). Test
     * files themselves report `false`.
     */
    hasTest: boolean;
    /**
     * npm package names this file imports directly (bare specifiers
     * that don't match any workspace). Deduplicated, sorted.
     */
    externalDeps: string[];
    /**
     * Symbols this file re-exports via `export {X} from './sub'` or
     * `export * from './sub'` (latter reported as the sentinel `*`).
     * Deduplicated, sorted.
     */
    reExports: string[];
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