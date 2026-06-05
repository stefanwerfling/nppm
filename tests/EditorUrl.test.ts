import {describe, expect, it} from 'vitest';
import {EditorUrl} from '../frontend/EditorUrl.js';

describe('EditorUrl', () => {

    it('builds vscode-family URLs with the file-prefix scheme', () => {
        expect(EditorUrl.build('vscode',   '/home/me/proj/node_modules/foo'))
            .toBe('vscode://file/home/me/proj/node_modules/foo');
        expect(EditorUrl.build('vscodium', '/home/me/proj/node_modules/foo'))
            .toBe('vscodium://file/home/me/proj/node_modules/foo');
        expect(EditorUrl.build('cursor',   '/home/me/proj/node_modules/foo'))
            .toBe('cursor://file/home/me/proj/node_modules/foo');
    });

    it('builds JetBrains URLs with an encoded `open?file=` query', () => {
        expect(EditorUrl.build('phpstorm', '/home/me/p/node_modules/a b'))
            .toBe('phpstorm://open?file=%2Fhome%2Fme%2Fp%2Fnode_modules%2Fa%20b');
        expect(EditorUrl.build('webstorm', '/x'))
            .toBe('webstorm://open?file=%2Fx');
        expect(EditorUrl.build('idea',     '/x'))
            .toBe('idea://open?file=%2Fx');
    });

    it('builds Sublime URL with a file:// prefix', () => {
        expect(EditorUrl.build('subl', '/home/me/foo'))
            .toBe('subl://open?url=file://%2Fhome%2Fme%2Ffoo');
    });

    it('returns null for unknown or missing editor keys', () => {
        expect(EditorUrl.build(undefined, '/x')).toBeNull();
        expect(EditorUrl.build('', '/x')).toBeNull();
        expect(EditorUrl.build('emacs', '/x')).toBeNull();
    });

    it('label() maps known keys to a friendly name', () => {
        expect(EditorUrl.label('vscode')).toBe('VS Code');
        expect(EditorUrl.label('phpstorm')).toBe('PhpStorm');
        expect(EditorUrl.label('subl')).toBe('Sublime Text');
    });

    it('label() falls back to the raw key for unknown editors', () => {
        expect(EditorUrl.label('emacs')).toBe('emacs');
        expect(EditorUrl.label(undefined)).toBe('');
    });
});