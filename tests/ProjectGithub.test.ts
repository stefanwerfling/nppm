import {describe, expect, it} from 'vitest';
import {ProjectGithub} from '../Project/ProjectGithub.js';

/**
 * `getKey()` is `github:<repo>@<ref>` so we use it as a witness for
 * the normalised repo string the constructor stored — without making
 * `_repo` public.
 */
function repoFromKey(p: ProjectGithub): string {
    const key = p.getKey();
    return key.slice('github:'.length).split('@')[0];
}

describe('ProjectGithub.constructor normalisation', () => {
    it('keeps the short-form owner/repo verbatim', () => {
        const p = new ProjectGithub('OpenSourcePKG/nppm', 'nppm');
        expect(repoFromKey(p)).toBe('OpenSourcePKG/nppm');
    });

    it('shortens the https://github.com URL the user pasted from the address bar', () => {
        const p = new ProjectGithub('https://github.com/OpenSourcePKG/projektxd_tbplugin', 'tbplugin');
        expect(repoFromKey(p)).toBe('OpenSourcePKG/projektxd_tbplugin');
    });

    it('strips a trailing `.git` and any trailing slash', () => {
        const p = new ProjectGithub('https://github.com/OpenSourcePKG/nppm.git', 'nppm');
        expect(repoFromKey(p)).toBe('OpenSourcePKG/nppm');
        const q = new ProjectGithub('https://github.com/OpenSourcePKG/nppm/', 'nppm');
        expect(repoFromKey(q)).toBe('OpenSourcePKG/nppm');
    });

    it('handles SSH and shorthand prefixes', () => {
        expect(repoFromKey(new ProjectGithub('git@github.com:OpenSourcePKG/nppm.git', 'nppm')))
            .toBe('OpenSourcePKG/nppm');
        expect(repoFromKey(new ProjectGithub('git+https://github.com/OpenSourcePKG/nppm.git', 'nppm')))
            .toBe('OpenSourcePKG/nppm');
        expect(repoFromKey(new ProjectGithub('github:OpenSourcePKG/nppm', 'nppm')))
            .toBe('OpenSourcePKG/nppm');
    });

    it('leaves a clearly malformed input untouched so the caller sees a real failure later', () => {
        const p = new ProjectGithub('not a repo', 'broken');
        expect(repoFromKey(p)).toBe('not a repo');
    });
});