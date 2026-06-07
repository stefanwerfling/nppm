import {describe, expect, it} from 'vitest';
import {ProvenanceLevel, ProvenanceScanner} from '../backend/Security/ProvenanceScanner.js';

describe('ProvenanceScanner.classify', () => {
    it('returns null when no dist record is available', () => {
        expect(ProvenanceScanner.classify(undefined)).toBeNull();
        expect(ProvenanceScanner.classify(null)).toBeNull();
    });

    it('flags Sigstore-anchored attestations as `provenance`', () => {
        const finding = ProvenanceScanner.classify({
            tarball: 'https://r/p.tgz',
            attestations: {
                url: 'https://registry.npmjs.org/-/npm/v1/attestations/pkg@1.0.0',
                provenance: {predicateType: 'https://slsa.dev/provenance/v0.2'}
            },
            signatures: [{keyid: 'k', sig: 's'}]
        });
        expect(finding).not.toBeNull();
        expect(finding!.level).toBe(ProvenanceLevel.provenance);
        expect(finding!.predicateType).toBe('https://slsa.dev/provenance/v0.2');
        expect(finding!.attestationUrl).toMatch(/attestations/u);
        expect(finding!.signatureCount).toBe(1);
    });

    it('reports `signed` when the registry signed but no attestation exists', () => {
        const finding = ProvenanceScanner.classify({
            tarball: 'https://r/p.tgz',
            signatures: [{keyid: 'k', sig: 's'}]
        });
        expect(finding!.level).toBe(ProvenanceLevel.signed);
        expect(finding!.attestationUrl).toBeUndefined();
        expect(finding!.signatureCount).toBe(1);
    });

    it('reports `unsigned` when neither signature nor attestation is present', () => {
        const finding = ProvenanceScanner.classify({tarball: 'https://r/p.tgz'});
        expect(finding!.level).toBe(ProvenanceLevel.unsigned);
        expect(finding!.signatureCount).toBe(0);
    });

    it('handles attestation block without a predicateType field gracefully', () => {
        const finding = ProvenanceScanner.classify({
            tarball: 'https://r/p.tgz',
            attestations: {url: 'https://r/att'}
        });
        expect(finding!.level).toBe(ProvenanceLevel.provenance);
        expect(finding!.predicateType).toBeUndefined();
    });
});