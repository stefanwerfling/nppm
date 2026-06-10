import {LicenseSeverity} from './LicenseScanner.js';
import {HeuristicsBatchEntry} from './SecurityScanner.js';

/**
 * Discriminator for the finding kind a user can dismiss. Mirrors the
 * 1:1 mapping between SecurityReport fields and the scanner that
 * produced them, plus `cve` for OSV vuln IDs (which live as an array
 * keyed by vuln id).
 */
export type IgnoredKind =
    'cve'
    |'script'|'pattern'|'binary'|'obfuscation'
    |'maintainer'|'license'|'provenance'|'cadence'|'freshness'
    |'churn'|'typosquat'|'capability'|'deprecation'
    |'manifest-red-flag'|'ignore-scripts'|'external'|'integrity';

/**
 * One ignored finding. Persisted as part of `nppm.json` (`security.
 * ignored`) so the dismissal is committed alongside the rest of the
 * configuration and shared across the team.
 *  - `name`/`version`: pin the suppression to one published release.
 *    Empty `version === '*'` means "for every version of the package".
 *  - `kind`: which scanner the finding came from (see {@link IgnoredKind}).
 *  - `identifier`: optional sub-key inside the kind — currently only
 *    used for `cve` (the OSV vuln id, e.g. `CVE-2024-1234`). Absent for
 *    every other kind, meaning "ignore the whole kind for this version".
 *  - `reason`: optional free-text the user can leave behind so the
 *    next maintainer knows why the dismissal exists.
 *  - `addedAt`: unix-ms timestamp when the entry was created. Used by
 *    the Settings UI to sort the list newest-first.
 */
export type IgnoredFinding = {
    name: string;
    version: string;
    kind: IgnoredKind;
    identifier?: string;
    reason?: string;
    addedAt: number;
};

/**
 * Immutable snapshot of the user's per-(package, finding) dismissal
 * list. Built once per config load + per mutation; controllers consult
 * the current snapshot from `ServerContext.getIgnoredFindings()` so
 * every scan path applies the same suppressions.
 */
export class IgnoredFindings {

    private readonly _entries: IgnoredFinding[];

    public constructor(entries: IgnoredFinding[]) {
        this._entries = entries;
    }

    public list(): IgnoredFinding[] {
        return [...this._entries];
    }

    /**
     * Does `(name, version, kind, identifier?)` match an existing
     * dismissal? An entry with `version === '*'` matches every version.
     * An entry with no `identifier` matches *every* finding of that
     * kind for the version; an entry *with* an identifier only matches
     * the specific id (e.g. one CVE-2024-x out of many).
     */
    public matches(name: string, version: string, kind: IgnoredKind, identifier?: string): boolean {
        return this._entries.some((e) => {
            if (e.name !== name || e.kind !== kind) {
                return false;
            }
            if (e.version !== '*' && e.version !== version) {
                return false;
            }
            if (e.identifier !== undefined && e.identifier !== identifier) {
                return false;
            }
            return true;
        });
    }

    /**
     * Entries that apply to a single `(name, version)`. Used by the
     * PackageDetailPanel Security tab to render dismissed findings as
     * a muted card with a "re-enable" button — the panel can show
     * them only when the entry list contains a match.
     */
    public forPackage(name: string, version: string): IgnoredFinding[] {
        return this._entries.filter((e) =>
            e.name === name && (e.version === '*' || e.version === version)
        );
    }

    /**
     * Zero out the summary fields of one batched scanner entry so
     * its severity stops contributing to badges and the Dashboard
     * score. Returns a new object; the input stays intact for callers
     * that still need the un-filtered shape.
     */
    public applyToBatchEntry(e: HeuristicsBatchEntry): HeuristicsBatchEntry {
        const m = (kind: IgnoredKind): boolean => this.matches(e.name, e.version, kind);
        return {
            name: e.name,
            version: e.version,
            scripts: m('script')
                ? {...e.scripts, maxSeverity: null, count: 0}
                : e.scripts,
            patterns: m('pattern')
                ? {...e.patterns, maxSeverity: null, count: 0}
                : e.patterns,
            binaries: m('binary')
                ? {...e.binaries, maxSeverity: null, riskCount: 0}
                : e.binaries,
            maintainer: m('maintainer')
                ? {...e.maintainer, severity: null}
                : e.maintainer,
            /*
             * License severity isn't nullable — collapse to the
             * lowest tier (`permissive`) so the scoring path treats
             * it as a no-op without weakening the type contract.
             */
            license: m('license')
                ? {...e.license, severity: LicenseSeverity.permissive}
                : e.license,
            provenance: m('provenance')
                ? {...e.provenance, level: null}
                : e.provenance,
            freshness: m('freshness')
                ? {...e.freshness, level: null}
                : e.freshness,
            cadence: m('cadence')
                ? {...e.cadence, level: null}
                : e.cadence,
            typosquat: m('typosquat')
                ? {...e.typosquat, level: null}
                : e.typosquat,
            external: m('external')
                ? {...e.external, level: null}
                : e.external,
            deprecation: m('deprecation')
                ? {...e.deprecation, level: null}
                : e.deprecation,
            obfuscation: m('obfuscation')
                ? {...e.obfuscation, maxSeverity: null, count: 0}
                : e.obfuscation,
            manifestRedFlags: m('manifest-red-flag')
                ? {...e.manifestRedFlags, severity: null}
                : e.manifestRedFlags,
            capability: m('capability')
                ? {...e.capability, severity: null}
                : e.capability
        };
    }

    /**
     * Replace the entire list. Used by the controllers right after
     * `mutateConfig` writes a fresh ignored list to `nppm.json` so the
     * in-memory snapshot tracks the persisted state without a full
     * server restart.
     */
    public static fromEntries(entries: IgnoredFinding[]): IgnoredFindings {
        return new IgnoredFindings(entries);
    }

}