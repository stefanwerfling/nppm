import {describe, expect, it} from 'vitest';
import {PackageJsonEditor} from '../backend/Upgrade/PackageJsonEditor.js';

describe('PackageJsonEditor.apply', () => {
    it('bumps the range in dependencies and preserves 2-space indent', () => {
        const src = [
            '{',
            '  "name": "app",',
            '  "dependencies": {',
            '    "lodash": "^4.17.20"',
            '  }',
            '}',
            ''
        ].join('\n');
        const r = PackageJsonEditor.apply(src, 'dependency', 'lodash', '^4.17.21');
        expect(r.changed).toBe(true);
        expect(r.after).toContain('"lodash": "^4.17.21"');
        expect(r.after.endsWith('\n')).toBe(true);
        expect(r.before).toBe(src);
    });

    it('handles tab indentation by emitting tabs', () => {
        const src = '{\n\t"dependencies": {\n\t\t"lodash": "^4.17.20"\n\t}\n}\n';
        const r = PackageJsonEditor.apply(src, 'dependency', 'lodash', '^4.17.21');
        expect(r.changed).toBe(true);
        expect(r.after.includes('\t"dependencies"')).toBe(true);
    });

    it('handles 4-space indentation', () => {
        const src = '{\n    "dependencies": {\n        "lodash": "^4.17.20"\n    }\n}\n';
        const r = PackageJsonEditor.apply(src, 'dependency', 'lodash', '^4.17.21');
        expect(r.after.includes('    "dependencies"')).toBe(true);
    });

    it('writes to devDependencies when depType=dev', () => {
        const src = '{\n  "devDependencies": {\n    "vitest": "^3.0.0"\n  }\n}\n';
        const r = PackageJsonEditor.apply(src, 'dev', 'vitest', '^4.0.0');
        expect(r.changed).toBe(true);
        expect(r.after).toContain('"vitest": "^4.0.0"');
    });

    it('returns changed:false when the dep is missing from the bucket', () => {
        const src = '{\n  "dependencies": {\n    "lodash": "^4.17.20"\n  }\n}\n';
        const r = PackageJsonEditor.apply(src, 'dependency', 'ghost', '^1.0.0');
        expect(r.changed).toBe(false);
        expect(r.after).toBe(src);
    });

    it('returns changed:false when already at the target range', () => {
        const src = '{\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}\n';
        const r = PackageJsonEditor.apply(src, 'dependency', 'lodash', '^4.17.21');
        expect(r.changed).toBe(false);
    });

    it('throws on an unknown depType', () => {
        expect(() => PackageJsonEditor.apply('{}', 'unknown', 'lodash', '1.0.0')).toThrow(/unknown depType/u);
    });

    it('preserves the absence of a trailing newline', () => {
        const src = '{"dependencies":{"a":"1"}}';
        const r = PackageJsonEditor.apply(src, 'dependency', 'a', '2');
        expect(r.after.endsWith('\n')).toBe(false);
    });
});

describe('PackageJsonEditor.currentRange', () => {
    it('returns the declared range', () => {
        const src = '{"devDependencies":{"vitest":"^3.0.0"}}';
        expect(PackageJsonEditor.currentRange(src, 'dev', 'vitest')).toBe('^3.0.0');
    });

    it('returns null when the bucket is missing', () => {
        expect(PackageJsonEditor.currentRange('{}', 'dev', 'vitest')).toBeNull();
    });

    it('returns null on malformed JSON', () => {
        expect(PackageJsonEditor.currentRange('{nope', 'dev', 'vitest')).toBeNull();
    });

    it('returns null for an unknown depType', () => {
        expect(PackageJsonEditor.currentRange('{}', 'bogus', 'vitest')).toBeNull();
    });
});