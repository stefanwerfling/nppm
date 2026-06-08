import {ConfigProjectType} from '../Config/Config.js';
import {PatternFinding, PatternSeverity} from '../Security/PatternScanner.js';

/**
 * Per-file roll-up. `score` collapses the per-pattern findings to a
 * single 0–100 value the UI can paint as a ring colour: clean (no
 * findings) is 100; each finding subtracts a weight based on its
 * severity (info / warn / risk).
 */
export type SelfCodeFileScore = {
    /** Project-relative POSIX path, identical to `SourceFile.id`. */
    id: string;
    score: number;
    findings: PatternFinding[];
    severity: PatternSeverity|null;
};

/**
 * Response of `GET /api/projects/:id/self-code`. `supported: false`
 * is the sentinel for remote projects, same shape as the source-graph
 * endpoint.
 */
export type SelfCodeData = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    supported: boolean;
    unsupportedReason?: string;
    files: SelfCodeFileScore[];
    /** Worst severity across all files; `null` when there are zero findings. */
    worst: PatternSeverity|null;
    /** Total findings across the project, by severity bucket. */
    totals: {info: number; warn: number; risk: number;};
    filesScanned: number;
};