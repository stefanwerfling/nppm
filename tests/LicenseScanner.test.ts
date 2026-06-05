import {describe, expect, it} from 'vitest';
import {LicenseScanner, LicenseSeverity} from '../backend/Security/LicenseScanner.js';

describe('LicenseScanner.classify — single SPDX atoms', () => {
    const s = new LicenseScanner();

    it('classifies MIT/BSD/Apache/ISC as permissive', () => {
        expect(s.classify('MIT').severity).toBe(LicenseSeverity.permissive);
        expect(s.classify('Apache-2.0').severity).toBe(LicenseSeverity.permissive);
        expect(s.classify('BSD-3-Clause').severity).toBe(LicenseSeverity.permissive);
        expect(s.classify('ISC').severity).toBe(LicenseSeverity.permissive);
        expect(s.classify('0BSD').severity).toBe(LicenseSeverity.permissive);
    });

    it('classifies LGPL/MPL/EPL as weak-copyleft', () => {
        expect(s.classify('LGPL-3.0-or-later').severity).toBe(LicenseSeverity.weakCopyleft);
        expect(s.classify('MPL-2.0').severity).toBe(LicenseSeverity.weakCopyleft);
        expect(s.classify('EPL-2.0').severity).toBe(LicenseSeverity.weakCopyleft);
    });

    it('classifies GPL/AGPL as strong-copyleft', () => {
        expect(s.classify('GPL-3.0-only').severity).toBe(LicenseSeverity.strongCopyleft);
        expect(s.classify('GPL-2.0+').severity).toBe(LicenseSeverity.strongCopyleft);
        expect(s.classify('AGPL-3.0').severity).toBe(LicenseSeverity.strongCopyleft);
    });

    it('classifies UNLICENSED and SEE LICENSE IN as proprietary', () => {
        expect(s.classify('UNLICENSED').severity).toBe(LicenseSeverity.proprietary);
        expect(s.classify('SEE LICENSE IN LICENSE.txt').severity).toBe(LicenseSeverity.proprietary);
        expect(s.classify('LicenseRef-Internal-Acme').severity).toBe(LicenseSeverity.proprietary);
    });

    it('classifies unknown strings as unknown', () => {
        expect(s.classify('Acme-Custom-1.0').severity).toBe(LicenseSeverity.unknown);
        expect(s.classify(null).severity).toBe(LicenseSeverity.unknown);
        expect(s.classify(undefined).severity).toBe(LicenseSeverity.unknown);
        expect(s.classify('').severity).toBe(LicenseSeverity.unknown);
    });
});

describe('LicenseScanner.classify — SPDX expressions', () => {
    const s = new LicenseScanner();

    it('picks the most permissive for OR expressions', () => {
        // user can pick MIT → permissive wins
        expect(s.classify('(MIT OR GPL-3.0-only)').severity).toBe(LicenseSeverity.permissive);
        // unknown beats strong-copyleft in the rank ladder
        // (unknown might be permissive on inspection — we can't tell,
        // but it's not certainly worse than GPL); user picks unknown.
        expect(s.classify('(GPL-3.0-only OR Acme-Custom)').severity).toBe(LicenseSeverity.unknown);
        // both copyleft: strong-copyleft is worse, so user picks weak.
        expect(s.classify('(GPL-3.0-only OR LGPL-3.0-only)').severity).toBe(LicenseSeverity.weakCopyleft);
    });

    it('picks the worst for AND expressions', () => {
        expect(s.classify('MIT AND GPL-3.0-only').severity).toBe(LicenseSeverity.strongCopyleft);
        expect(s.classify('Apache-2.0 AND MIT').severity).toBe(LicenseSeverity.permissive);
    });

    it('treats WITH-exception as the parent license', () => {
        expect(s.classify('Apache-2.0 WITH Classpath-exception-2.0').severity).toBe(LicenseSeverity.permissive);
        expect(s.classify('GPL-2.0-only WITH Classpath-exception-2.0').severity).toBe(LicenseSeverity.strongCopyleft);
    });

    it('collects all identifiers from a compound expression', () => {
        const f = s.classify('(MIT OR Apache-2.0)');
        expect(f.identifiers.sort()).toEqual(['Apache-2.0', 'MIT']);
    });

    it('falls back to atom classification for unparseable expressions', () => {
        const f = s.classify('UNLICENSED');
        expect(f.severity).toBe(LicenseSeverity.proprietary);
        expect(f.spdx).toBe('UNLICENSED');
    });
});

describe('LicenseScanner.classify — allow / deny policy', () => {

    it('allowlist forces permissive even on copyleft', () => {
        const s = new LicenseScanner({allowlist: ['LGPL-*']});
        const f = s.classify('LGPL-3.0-only');
        expect(f.severity).toBe(LicenseSeverity.permissive);
        expect(f.policyMatched).toBe(true);
    });

    it('denylist forces proprietary even on permissive', () => {
        const s = new LicenseScanner({denylist: ['CC-BY-4.0']});
        const f = s.classify('CC-BY-4.0');
        expect(f.severity).toBe(LicenseSeverity.proprietary);
        expect(f.policyMatched).toBe(true);
    });

    it('denylist wins over allowlist when both match', () => {
        const s = new LicenseScanner({
            allowlist: ['MIT'],
            denylist: ['MIT']
        });
        const f = s.classify('MIT');
        expect(f.severity).toBe(LicenseSeverity.proprietary);
    });

    it('denylist matches identifiers inside OR-expression', () => {
        const s = new LicenseScanner({denylist: ['AGPL-*']});
        const f = s.classify('(MIT OR AGPL-3.0)');
        expect(f.severity).toBe(LicenseSeverity.proprietary);
    });

    it('treatUnknownAs can promote missing license to proprietary', () => {
        const s = new LicenseScanner({treatUnknownAs: LicenseSeverity.proprietary});
        const f = s.classify(null);
        expect(f.severity).toBe(LicenseSeverity.proprietary);
        expect(f.policyMatched).toBe(false);
    });

    it('wildcard `*` suffix matches the prefix family', () => {
        const s = new LicenseScanner({denylist: ['GPL-*']});
        expect(s.classify('GPL-2.0-only').severity).toBe(LicenseSeverity.proprietary);
        expect(s.classify('GPL-3.0-or-later').severity).toBe(LicenseSeverity.proprietary);
        // not a GPL-anything → falls back to default classification
        expect(s.classify('MIT').severity).toBe(LicenseSeverity.permissive);
    });
});