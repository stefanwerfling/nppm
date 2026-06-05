import {describe, it, expect} from 'vitest';
import {ConfigProjectType, SchemaConfig} from '../backend/Config/Config.js';

describe('Config schema', () => {

    it('accepts a minimal valid config', () => {
        const errors: unknown[] = [];
        const ok = SchemaConfig.validate({projects: []}, errors as never);
        expect(ok).toBe(true);
        expect(errors).toEqual([]);
    });

    it('accepts each project source variant', () => {
        const cfg = {
            projects: [
                {type: ConfigProjectType.local, path: '/x', name: 'one'},
                {type: ConfigProjectType.github, repo: 'a/b', name: 'two'},
                {
                    type: ConfigProjectType.gitea,
                    url: 'https://g.example/a/b',
                    ref: 'main',
                    token: '$T'
                }
            ]
        };

        expect(SchemaConfig.validate(cfg, [])).toBe(true);
    });

    it('rejects an unknown project type', () => {
        const cfg = {projects: [{type: 'something', path: '/x'}]};
        expect(SchemaConfig.validate(cfg, [])).toBe(false);
    });

    it('rejects a local project missing the path field', () => {
        const cfg = {projects: [{type: ConfigProjectType.local}]};
        expect(SchemaConfig.validate(cfg, [])).toBe(false);
    });

    it('rejects when projects is not an array', () => {
        expect(SchemaConfig.validate({projects: 'no'}, [])).toBe(false);
    });

    it('accepts optional registry / cache / server / browser sections', () => {
        const cfg = {
            projects: [],
            server: {port: 5190},
            browser: {open: false},
            registry: {url: 'https://r.example', auth: 'tok'},
            cache: {dir: '.cache', ttlMinutes: 10}
        };

        expect(SchemaConfig.validate(cfg, [])).toBe(true);
    });

    it('accepts an optional security.maintainer section', () => {
        const cfg = {
            projects: [],
            security: {
                maintainer: {
                    quickHandoverDays: 14,
                    suspiciousGapDays: 90,
                    matureVersions: 5,
                    trustWindow: 30
                }
            }
        };
        expect(SchemaConfig.validate(cfg, [])).toBe(true);
    });

    it('accepts an optional security.license section', () => {
        const cfg = {
            projects: [],
            security: {
                license: {
                    allowlist: ['MIT', 'Apache-2.0', 'BSD-*', 'ISC'],
                    denylist: ['AGPL-*'],
                    treatUnknownAs: 'proprietary'
                }
            }
        };
        expect(SchemaConfig.validate(cfg, [])).toBe(true);
    });

    it('accepts an optional security.unused section', () => {
        const cfg = {
            projects: [],
            security: {
                unused: {
                    allowlist: ['my-internal-bin'],
                    devPathGlobs: ['**/cypress/**']
                }
            }
        };
        expect(SchemaConfig.validate(cfg, [])).toBe(true);
    });

    it('accepts security.unused with no fields', () => {
        const cfg = {
            projects: [],
            security: {unused: {}}
        };
        expect(SchemaConfig.validate(cfg, [])).toBe(true);
    });

    it('rejects non-array allowlist in security.unused', () => {
        const cfg = {
            projects: [],
            security: {unused: {allowlist: 'foo'}}
        };
        expect(SchemaConfig.validate(cfg, [])).toBe(false);
    });
});