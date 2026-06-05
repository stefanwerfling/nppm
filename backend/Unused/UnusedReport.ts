import {ConfigProjectType} from '../Config/Config.js';

/**
 * Severity ladder for unused-deps findings. Mirrors the other
 * scanners' three-level shape (info/warn/risk) so the frontend can
 * reuse the same colour ramp.
 */
export enum UnusedSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

/**
 * Which manifest bucket a finding refers to. Matches the npm dep-type
 * conventions one-to-one.
 */
export type UnusedDepBucket = 'dependency'|'devDependency'|'peerDependency'|'optionalDependency';

/**
 * One package declared in `dependencies` (or devDeps / peerDeps /
 * optionalDeps) that nothing in the project's source imports. `risk`
 * tier suggests it can be removed; `info` means the allowlist or a
 * `scripts` entry covers it so we hid it from the "unused" list and
 * just record the inspection.
 */
export type UnusedFinding = {
    name: string;
    declaredIn: UnusedDepBucket;
    severity: UnusedSeverity;
    reason: string;
};

/**
 * A dep imported only from dev paths (`*.test.ts`, `vite.config.*`,
 * …) but listed in plain `dependencies`. The fix is usually a
 * `package.json` edit: move it to `devDependencies` so it's not
 * installed in production.
 */
export type MisplacedFinding = {
    name: string;
    /** First dev-path import site, for the UI. */
    firstImport: string;
};

/**
 * A name found via `import`/`require` but not declared in any bucket.
 * Usually a transitive leak the user accidentally relied on; sometimes
 * an intentional peer dep that was forgotten.
 */
export type MissingFinding = {
    name: string;
    /** First import site, for the UI. */
    firstImport: string;
};

/**
 * Files the regex scanner couldn't fully resolve (dynamic `require`,
 * `import(varName)`). Reported separately so the user understands the
 * `unused` list isn't authoritative for those.
 */
export type ScanLimit = {
    file: string;
    reason: string;
};

/**
 * Aggregated per-project report. `supported: false` is returned for
 * remote projects (GitHub/Gitea) where the FS walk doesn't apply.
 */
export type UnusedReport = {
    project: {
        unid: string;
        name: string;
        type: ConfigProjectType;
    };
    supported: boolean;
    /** Set when `supported = false` — human-readable explanation. */
    unsupportedReason?: string;
    unused: UnusedFinding[];
    misplaced: MisplacedFinding[];
    missing: MissingFinding[];
    scanLimits: ScanLimit[];
    /**
     * How many source files the scanner actually read. Useful as a
     * sanity check ("did the glob find anything?") and surfaced in
     * the UI footer.
     */
    filesScanned: number;
};