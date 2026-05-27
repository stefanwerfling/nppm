import {describe, expect, it} from 'vitest';
import {isGitVersion, resolveGitTarball} from '../Fingerprint/GitResolver.js';

describe('isGitVersion', () => {
    it('detects every git-shape npm understands', () => {
        expect(isGitVersion('git+https://github.com/a/b.git')).toBe(true);
        expect(isGitVersion('git+ssh://git@github.com/a/b.git')).toBe(true);
        expect(isGitVersion('git@github.com:a/b.git')).toBe(true);
        expect(isGitVersion('git://github.com/a/b.git')).toBe(true);
        expect(isGitVersion('github:a/b')).toBe(true);
        expect(isGitVersion('gitlab:a/b')).toBe(true);
        expect(isGitVersion('bitbucket:a/b')).toBe(true);
    });

    it('returns false for plain semver and ranges', () => {
        expect(isGitVersion('1.2.3')).toBe(false);
        expect(isGitVersion('^1.2.3')).toBe(false);
        expect(isGitVersion('>=2.0.0 <3.0.0')).toBe(false);
        expect(isGitVersion('latest')).toBe(false);
    });
});

describe('resolveGitTarball', () => {
    it('handles git+https://github.com with ref', () => {
        const r = resolveGitTarball('git+https://github.com/OpenSourcePKG/vts.git#main')!;
        expect(r.url).toBe('https://codeload.github.com/OpenSourcePKG/vts/tar.gz/main');
    });

    it('handles git+https://github.com without ref → HEAD', () => {
        const r = resolveGitTarball('git+https://github.com/OpenSourcePKG/vts.git')!;
        expect(r.url).toBe('https://codeload.github.com/OpenSourcePKG/vts/tar.gz/HEAD');
    });

    it('handles git@github.com:owner/repo.git (SCP-style)', () => {
        const r = resolveGitTarball('git@github.com:foo/bar.git#v1')!;
        expect(r.url).toBe('https://codeload.github.com/foo/bar/tar.gz/v1');
    });

    it('handles github: shorthand', () => {
        const r = resolveGitTarball('github:foo/bar#abc123')!;
        expect(r.url).toBe('https://codeload.github.com/foo/bar/tar.gz/abc123');
    });

    it('strips a trailing .git when none would be expected (shorthand)', () => {
        // `github:foo/bar` shouldn't carry a `.git`, but tolerate it.
        const r = resolveGitTarball('git+https://github.com/foo/bar#v2')!;
        expect(r.url).toBe('https://codeload.github.com/foo/bar/tar.gz/v2');
    });

    it('handles gitlab.com URLs (archive endpoint with filename)', () => {
        const r = resolveGitTarball('git+https://gitlab.com/foo/bar.git#v2')!;
        expect(r.url).toBe('https://gitlab.com/foo/bar/-/archive/v2/bar-v2.tar.gz');

        const shorthand = resolveGitTarball('gitlab:foo/bar')!;
        expect(shorthand.url).toBe('https://gitlab.com/foo/bar/-/archive/HEAD/bar-HEAD.tar.gz');
    });

    it('handles bitbucket.org URLs (/get/<ref>.tar.gz)', () => {
        const r = resolveGitTarball('git+https://bitbucket.org/foo/bar.git#abc')!;
        expect(r.url).toBe('https://bitbucket.org/foo/bar/get/abc.tar.gz');

        const shorthand = resolveGitTarball('bitbucket:foo/bar')!;
        expect(shorthand.url).toBe('https://bitbucket.org/foo/bar/get/HEAD.tar.gz');
    });

    it('handles SCP-style ssh for gitlab/bitbucket', () => {
        expect(resolveGitTarball('git@gitlab.com:foo/bar.git')!.url)
            .toBe('https://gitlab.com/foo/bar/-/archive/HEAD/bar-HEAD.tar.gz');
        expect(resolveGitTarball('git@bitbucket.org:foo/bar.git')!.url)
            .toBe('https://bitbucket.org/foo/bar/get/HEAD.tar.gz');
    });

    it('returns null for hosts we still do not handle (e.g. self-hosted)', () => {
        expect(resolveGitTarball('git+https://gitea.example.com/a/b.git')).toBeNull();
        expect(resolveGitTarball('git+ssh://git@my-gitlab.internal/a/b.git')).toBeNull();
    });
});