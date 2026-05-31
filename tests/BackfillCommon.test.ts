import {describe, expect, it} from 'vitest';
import {BackfillCommon} from '../History/BackfillCommon.js';

describe('BackfillCommon.parsePackageJsonToPackages', () => {

    it('flattens dependencies into name@range pairs', () => {
        const raw = JSON.stringify({
            dependencies: {foo: '^1.0.0', bar: '~2.0.0'}
        });
        const out = BackfillCommon.parsePackageJsonToPackages(raw);
        expect(out?.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            {name: 'bar', version: '~2.0.0'},
            {name: 'foo', version: '^1.0.0'}
        ]);
    });

    it('flattens devDependencies + peer + optional alongside runtime deps', () => {
        const raw = JSON.stringify({
            dependencies: {a: '^1'},
            devDependencies: {b: '^2'},
            peerDependencies: {c: '^3'},
            optionalDependencies: {d: '^4'}
        });
        const out = BackfillCommon.parsePackageJsonToPackages(raw);
        expect(out).toHaveLength(4);
        const names = out!.map((p) => p.name).sort();
        expect(names).toEqual(['a', 'b', 'c', 'd']);
    });

    it('uses first-bucket-wins on name collision (runtime > dev)', () => {
        const raw = JSON.stringify({
            dependencies: {foo: '^1.0.0'},
            devDependencies: {foo: '^2.0.0'}
        });
        const out = BackfillCommon.parsePackageJsonToPackages(raw);
        expect(out).toEqual([{name: 'foo', version: '^1.0.0'}]);
    });

    it('returns null on broken JSON', () => {
        expect(BackfillCommon.parsePackageJsonToPackages('not json')).toBeNull();
        expect(BackfillCommon.parsePackageJsonToPackages('')).toBeNull();
    });

    it('returns an empty array when no buckets present', () => {
        expect(BackfillCommon.parsePackageJsonToPackages('{}')).toEqual([]);
        expect(BackfillCommon.parsePackageJsonToPackages(
            JSON.stringify({name: 'x', version: '1.0.0'})
        )).toEqual([]);
    });

    it('skips non-string values (typo / wrong shape)', () => {
        const raw = JSON.stringify({
            dependencies: {foo: '^1.0.0', bar: 2, baz: null}
        });
        const out = BackfillCommon.parsePackageJsonToPackages(raw);
        expect(out).toEqual([{name: 'foo', version: '^1.0.0'}]);
    });
});

describe('BackfillCommon.diffSnapshots', () => {

    it('threads source through to the resulting entry', () => {
        const e = BackfillCommon.diffSnapshots(
            [],
            [{name: 'foo', version: '^1.0.0'}],
            1000,
            'aaa',
            'package-json'
        );
        expect(e?.lockfileSource).toBe('package-json');
        expect(e?.source).toBe('git');
    });

    it('defaults source to committed when not passed', () => {
        const e = BackfillCommon.diffSnapshots(
            [],
            [{name: 'foo', version: '1.0.0'}],
            1000,
            'aaa'
        );
        expect(e?.lockfileSource).toBe('committed');
    });
});