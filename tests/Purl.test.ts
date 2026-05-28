import {describe, expect, it} from 'vitest';
import {Purl} from '../Sbom/Purl.js';

describe('Purl.npm', () => {
    it('encodes a plain package', () => {
        expect(Purl.npm('lodash', '4.17.21')).toBe('pkg:npm/lodash@4.17.21');
    });

    it('encodes a scoped package without keeping the @ prefix', () => {
        expect(Purl.npm('@babel/core', '7.24.0')).toBe('pkg:npm/babel/core@7.24.0');
    });

    it('lowercases the name', () => {
        expect(Purl.npm('Lodash', '1.0.0')).toBe('pkg:npm/lodash@1.0.0');
    });

    it('percent-encodes a range-style version', () => {
        const out = Purl.npm('foo', '^1.0.0');
        expect(out).toBe('pkg:npm/foo@%5E1.0.0');
    });

    it('handles a malformed scoped name without throwing', () => {
        const out = Purl.npm('@noslash', '1.0.0');
        expect(out).toMatch(/^pkg:npm\/.+@1\.0\.0$/);
    });
});