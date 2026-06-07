import {describe, it, expect} from 'vitest';
import {Template} from '../backend/Templates/Template.js';
import {TemplateResolver} from '../backend/Templates/TemplateResolver.js';

function mk(id: string, body: Partial<Template> = {}): Template {
    return {id: id, ...body};
}

describe('TemplateResolver', () => {

    it('resolves an empty id list to the empty template', () => {
        const r = new TemplateResolver(new Map());
        const out = r.resolve([]);
        expect(out.sourceIds).toEqual([]);
        expect(out.packages.runtime).toEqual({});
        expect(out.forbidden).toEqual([]);
    });

    it('returns one template flat when nothing extends', () => {
        const cat = new Map<string, Template>([
            ['base', mk('base', {
                packages: {runtime: {express: {version: '^5.0.0'}}}
            })]
        ]);
        const out = new TemplateResolver(cat).resolve(['base']);
        expect(out.sourceIds).toEqual(['base']);
        expect(out.packages.runtime).toEqual({express: {version: '^5.0.0'}});
    });

    it('later templates in the chain override earlier ones', () => {
        const cat = new Map<string, Template>([
            ['base', mk('base', {
                packages: {runtime: {express: {version: '^4.0.0', required: true}}}
            })],
            ['backend', mk('backend', {
                packages: {runtime: {express: {version: '^5.0.0'}}}
            })]
        ]);
        const out = new TemplateResolver(cat).resolve(['base', 'backend']);
        // override on `version`, but `required` should survive from base
        expect(out.packages.runtime.express).toEqual({version: '^5.0.0', required: true});
        expect(out.sourceIds).toEqual(['base', 'backend']);
    });

    it('flattens the extends graph depth-first', () => {
        const cat = new Map<string, Template>([
            ['root', mk('root', {
                packages: {runtime: {a: {version: '1'}}}
            })],
            ['mid', mk('mid', {
                extends: ['root'],
                packages: {runtime: {b: {version: '2'}}}
            })],
            ['leaf', mk('leaf', {
                extends: ['mid'],
                packages: {runtime: {c: {version: '3'}}}
            })]
        ]);
        const out = new TemplateResolver(cat).resolve(['leaf']);
        expect(out.sourceIds).toEqual(['root', 'mid', 'leaf']);
        expect(Object.keys(out.packages.runtime).sort()).toEqual(['a', 'b', 'c']);
    });

    it('multiple extends parents resolve in order', () => {
        const cat = new Map<string, Template>([
            ['a', mk('a', {packages: {runtime: {x: {version: '1'}}}})],
            ['b', mk('b', {packages: {runtime: {x: {version: '2'}}}})],
            ['c', mk('c', {extends: ['a', 'b']})]
        ]);
        const out = new TemplateResolver(cat).resolve(['c']);
        expect(out.packages.runtime.x.version).toBe('2');
    });

    it('unions forbidden across the chain', () => {
        const cat = new Map<string, Template>([
            ['a', mk('a', {forbidden: ['moment']})],
            ['b', mk('b', {forbidden: ['request', 'moment']})]
        ]);
        const out = new TemplateResolver(cat).resolve(['a', 'b']);
        expect(out.forbidden).toEqual(['moment', 'request']);
    });

    it('mode propagates last-wins, defaulting to additive', () => {
        const cat = new Map<string, Template>([
            ['a', mk('a', {mode: 'strict'})],
            ['b', mk('b', {})]
        ]);
        const out = new TemplateResolver(cat).resolve(['a', 'b']);
        expect(out.mode).toBe('strict');

        const out2 = new TemplateResolver(cat).resolve(['b', 'a']);
        expect(out2.mode).toBe('strict');
    });

    it('throws on unknown template', () => {
        const r = new TemplateResolver(new Map());
        expect(() => r.resolve(['nope'])).toThrow(/unknown template "nope"/u);
    });

    it('throws on extends cycle', () => {
        const cat = new Map<string, Template>([
            ['a', mk('a', {extends: ['b']})],
            ['b', mk('b', {extends: ['a']})]
        ]);
        expect(() => new TemplateResolver(cat).resolve(['a'])).toThrow(/cycle/u);
    });

    it('dedupes a diamond-extends graph', () => {
        const cat = new Map<string, Template>([
            ['base', mk('base')],
            ['left', mk('left', {extends: ['base']})],
            ['right', mk('right', {extends: ['base']})],
            ['top', mk('top', {extends: ['left', 'right']})]
        ]);
        const out = new TemplateResolver(cat).resolve(['top']);
        // base must appear once (deduped by `seen`)
        const occurrences = out.sourceIds.filter((id) => id === 'base').length;
        expect(occurrences).toBe(1);
    });
});