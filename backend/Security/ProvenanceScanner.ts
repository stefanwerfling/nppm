import {RegistryDist} from '../Registry/Registry.js';

/**
 * Three-level signing/provenance state for one published version.
 *
 *  - `provenance`: maintainer published with `--provenance`. The
 *    registry returns an `attestations` block pointing to a Sigstore-
 *    signed SLSA provenance bundle. Strongest trust signal we have —
 *    cryptographically binds the tarball to a specific CI workflow
 *    run, source repo, and commit SHA.
 *  - `signed`: regular publish. The registry signed the tarball with
 *    its own key (`dist.signatures`) but no maintainer-side
 *    attestation exists. This is the baseline for every modern npm
 *    publish since registry-signing rolled out in 2018.
 *  - `unsigned`: neither attestation nor registry signature. Typical
 *    for pre-2018 releases, mirrors that strip signatures, or
 *    private registries that never signed at all.
 */
export enum ProvenanceLevel {
    provenance = 'provenance',
    signed = 'signed',
    unsigned = 'unsigned'
}

/**
 * One finding row produced by `ProvenanceScanner.classify`. `null` is
 * reserved for "registry has no `dist` for this version at all" — the
 * caller usually wants to render that as "no data" rather than as
 * `unsigned` (the two states are not the same: unsigned means we
 * looked and there was nothing; null means we couldn't look).
 *
 * `predicateType` (when present) is the SLSA predicate name from the
 * attestation block, e.g. `https://slsa.dev/provenance/v0.2`. It is
 * surfaced verbatim so the UI can tell SLSA v0.2 from v1.0 without
 * the scanner having to keep a switch up to date.
 *
 * `attestationUrl` is the registry URL of the provenance bundle.
 * We do not fetch it in this scanner — that would be a per-package
 * network call on cold cache. Surfacing the URL lets the UI hand
 * users a "verify yourself" link if they want to drill in.
 *
 * `signatureCount` is the number of `dist.signatures` entries; > 1
 * happens on packages signed by multiple registry keys during a
 * rotation window.
 */
export type ProvenanceFinding = {
    level: ProvenanceLevel;
    predicateType?: string;
    attestationUrl?: string;
    signatureCount: number;
};

/**
 * Reads the per-version `dist` block from a `RegistryPackage` and
 * decides whether the published tarball carries Sigstore-anchored
 * provenance, only the registry's own signature, or neither. Static
 * by design: there is no policy to configure (npm provenance is a
 * binary fact, not a gradient like license severity).
 */
export class ProvenanceScanner {

    /**
     * Classify one `dist` entry. Returns `null` when the registry
     * doesn't have a record for this specific version (cold cache or
     * old envelope written before `_extractDist` learned about
     * `signatures`/`attestations` — the regular TTL refresh fills it
     * in on the next request).
     */
    public static classify(dist: RegistryDist|undefined|null): ProvenanceFinding|null {
        if (!dist) {
            return null;
        }
        const sigCount = dist.signatures?.length ?? 0;

        if (dist.attestations && dist.attestations.url) {
            const finding: ProvenanceFinding = {
                level: ProvenanceLevel.provenance,
                attestationUrl: dist.attestations.url,
                signatureCount: sigCount
            };
            const predicate = dist.attestations.provenance?.predicateType;
            if (predicate) {
                finding.predicateType = predicate;
            }
            return finding;
        }

        if (sigCount > 0) {
            return {
                level: ProvenanceLevel.signed,
                signatureCount: sigCount
            };
        }

        return {
            level: ProvenanceLevel.unsigned,
            signatureCount: 0
        };
    }

}

/**
 * Compact summary for the matrix badge — same shape as the other
 * heuristic summaries. `level` is `null` when the registry had no
 * `dist` for the target version (cold cache / unpublished).
 */
export type ProvenanceSummary = {
    name: string;
    version: string;
    level: ProvenanceLevel|null;
};