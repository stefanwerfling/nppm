import {Lockfile, LockedPackage} from '../Project/Lockfile.js';

/**
 * Three-level severity for each individual lockfile entry. A
 * `synthesized` lockfile (walked from node_modules with no
 * `resolved`/`integrity` to work with) inherently can't satisfy this
 * scanner — the per-project rollup reports a `note` instead of a
 * misleading "perfect" verdict.
 */
export enum MutableResolutionSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

/**
 * Per-entry verdict shape.
 *
 *  - `risk`: `resolved` points at a mutable git ref — branch or tag,
 *    not a commit SHA. The next install can pull a different tree.
 *  - `warn`: `integrity` field missing in a lockfile that should
 *    carry one (committed/hidden v2/v3 lockfiles, registry-resolved
 *    entries). npm doesn't refuse such an install but the integrity
 *    cross-check has no anchor.
 *  - `info`: `file:` / `link:` protocols — intentional, but
 *    inherently non-reproducible across machines.
 */
export type MutableResolutionKind = 'git-branch-ref'|'missing-integrity'|'file-protocol'|'link-protocol';

export type MutableResolutionFinding = {
    name: string;
    version: string;
    severity: MutableResolutionSeverity;
    kind: MutableResolutionKind;
    /** Short reason rendered next to the package in the panel. */
    detail: string;
    /** The lockfile's `resolved` value (or undefined when missing). */
    resolved: string|undefined;
};

export type MutableResolutionReport = {
    supported: boolean;
    /**
     * `null` only when `supported` is false (synthesized lockfile, no
     * committed file). Otherwise the worst-of-all severity across
     * `findings`; reports `null` when nothing flagged.
     */
    maxSeverity: MutableResolutionSeverity|null;
    findings: MutableResolutionFinding[];
    /** Total packages walked — the denominator for the score formula. */
    packagesScanned: number;
    /** When `supported` is false, the reason. */
    unsupportedReason?: string;
};

/**
 * Static-only scanner: takes the parsed `Lockfile` and produces a
 * per-project report. No I/O — the Lockfile already lives in memory
 * by the time this runs.
 *
 * Skips `synthesized` lockfiles (no `resolved`/`integrity` data to
 * judge); for those the report reports `supported: false`.
 */
export class MutableResolutionScanner {

    public static scan(lockfile: Lockfile|null): MutableResolutionReport {
        if (!lockfile) {
            return {
                supported: false,
                maxSeverity: null,
                findings: [],
                packagesScanned: 0,
                unsupportedReason: 'no lockfile available'
            };
        }
        if (lockfile.source === 'synthesized') {
            return {
                supported: false,
                maxSeverity: null,
                findings: [],
                packagesScanned: lockfile.packages.length,
                unsupportedReason: 'lockfile synthesized from node_modules — no resolved/integrity data to check'
            };
        }

        const findings: MutableResolutionFinding[] = [];
        for (const pkg of lockfile.packages) {
            const f = MutableResolutionScanner._classifyEntry(pkg);
            if (f) {
                findings.push(f);
            }
        }

        const rank: Record<MutableResolutionSeverity, number> = {
            [MutableResolutionSeverity.info]: 1,
            [MutableResolutionSeverity.warn]: 2,
            [MutableResolutionSeverity.risk]: 3
        };
        let max: MutableResolutionSeverity|null = null;
        let maxRank = 0;
        for (const f of findings) {
            const r = rank[f.severity];
            if (r > maxRank) {
                max = f.severity;
                maxRank = r;
            }
        }

        return {
            supported: true,
            maxSeverity: max,
            findings,
            packagesScanned: lockfile.packages.length
        };
    }

    /**
     * Public for unit tests. Walks one entry; returns null when the
     * entry resolves to a normal registry tarball with an integrity
     * hash.
     */
    public static _classifyEntry(pkg: LockedPackage): MutableResolutionFinding|null {
        const resolved = pkg.resolved;

        // Workspace / self entry: the lockfile's `""` root key and
        // `node_modules/<workspace>` entries pointing at the source
        // tree. No `resolved`, no `integrity` — skip silently.
        if (!resolved && !pkg.integrity && pkg.path === '') {
            return null;
        }

        if (resolved) {
            // `link:` and `file:` protocols cover workspace / local
            // tarball / link-to-relative-path installs. Intentional
            // when used; still inherently non-reproducible across
            // machines (the linked tree changes whenever the user
            // edits it). Info-grade signal.
            if (resolved.startsWith('link:')) {
                return {
                    name: pkg.name, version: pkg.version,
                    severity: MutableResolutionSeverity.info,
                    kind: 'link-protocol',
                    detail: `link:${resolved.slice('link:'.length)}`,
                    resolved
                };
            }
            if (resolved.startsWith('file:')) {
                return {
                    name: pkg.name, version: pkg.version,
                    severity: MutableResolutionSeverity.info,
                    kind: 'file-protocol',
                    detail: `file:${resolved.slice('file:'.length)}`,
                    resolved
                };
            }
            if (MutableResolutionScanner._isGitResolved(resolved)) {
                const isImmutable = MutableResolutionScanner._gitRefLooksLikeSha(resolved);
                if (!isImmutable) {
                    return {
                        name: pkg.name, version: pkg.version,
                        severity: MutableResolutionSeverity.risk,
                        kind: 'git-branch-ref',
                        detail: 'git ref is a branch/tag, not a commit SHA',
                        resolved
                    };
                }
                // SHA-pinned git refs are fine — no integrity needed,
                // npm verifies the SHA itself.
                return null;
            }
        }

        // Registry tarball without integrity (npm v1 lockfiles or
        // alt-registries that strip it). Warn-grade.
        if (resolved && resolved.startsWith('http') && !pkg.integrity) {
            return {
                name: pkg.name, version: pkg.version,
                severity: MutableResolutionSeverity.warn,
                kind: 'missing-integrity',
                detail: 'registry tarball without integrity hash',
                resolved
            };
        }

        return null;
    }

    /**
     * Whether the `resolved` URL looks like a git endpoint. Covers
     * the four shapes npm understands (`git+https://`, `git+ssh://`,
     * `git://`, plus `git@host:path` SSH-with-colon).
     */
    private static _isGitResolved(resolved: string): boolean {
        return /^(?:git\+|git:|git@)/.test(resolved);
    }

    /**
     * Whether the `#`-fragment of a git `resolved` URL is a 40-char
     * (or 7-char short) hex SHA — the "immutable" form. Branch / tag
     * refs (`#main`, `#v1.2.3`) return false.
     */
    private static _gitRefLooksLikeSha(resolved: string): boolean {
        const hash = resolved.indexOf('#');
        if (hash < 0) {
            // No fragment at all → npm pulls HEAD of the default
            // branch. Mutable.
            return false;
        }
        const ref = resolved.slice(hash + 1);
        return /^[0-9a-f]{7,40}$/i.test(ref);
    }
}