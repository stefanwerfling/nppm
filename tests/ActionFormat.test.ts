import {describe, expect, it} from 'vitest';
import {ConfigProjectType} from '../Config/Config.js';
import {PrReviewReport} from '../PrReview/PrReview.js';
import {ActionFormatter, STICKY_MARKER} from '../Cli/ActionFormat.js';

function emptyReport(name: string): PrReviewReport {
    return {
        project: {unid: name, name, type: ConfigProjectType.local},
        base: 'main',
        head: 'HEAD',
        baseExists: true,
        headExists: true,
        changes: [],
        summary: {added: 0, removed: 0, updated: 0, bucketChanged: 0,
            totalVulnsAdded: 0, totalVulnsRemoved: 0},
        notes: []
    };
}

describe('ActionFormatter.commentBody', () => {
    it('embeds the sticky marker so the upserter can find the previous comment', () => {
        const body = ActionFormatter.commentBody([emptyReport('demo')], 'owner/repo', 'abc1234567');
        expect(body).toContain(STICKY_MARKER);
    });

    it('renders the no-changes branch when every report is empty', () => {
        const body = ActionFormatter.commentBody([emptyReport('demo')], 'owner/repo', 'abc1234567');
        expect(body).toContain('No dependency changes in this PR.');
    });

    it('truncates the head SHA in the footer to 7 chars', () => {
        const body = ActionFormatter.commentBody([emptyReport('demo')], 'owner/repo', 'abcdef0123456789');
        expect(body).toContain('abcdef0');
        expect(body).not.toContain('abcdef0123456789');
    });

    it('summarises change counts across multiple projects', () => {
        const r1 = emptyReport('alpha');
        r1.changes = [{
            name: 'axios', kind: 'updated',
            declaredRangeBefore: '^0.21.0', declaredRangeAfter: '^1.6.0',
            resolvedBefore: '0.21.4', resolvedAfter: '1.6.7',
            vulnsBefore: ['GHSA-wf5p-g6vw-rhxx'], vulnsAfter: [],
            vulnsAdded: [], vulnsRemoved: ['GHSA-wf5p-g6vw-rhxx']
        }];
        r1.summary = {added: 0, removed: 0, updated: 1, bucketChanged: 0,
            totalVulnsAdded: 0, totalVulnsRemoved: 1};

        const r2 = emptyReport('beta');
        r2.changes = [{
            name: 'lodash', kind: 'added',
            declaredRangeAfter: '^4.17.21', resolvedAfter: '4.17.21',
            vulnsBefore: null, vulnsAfter: [],
            vulnsAdded: [], vulnsRemoved: []
        }];
        r2.summary = {added: 1, removed: 0, updated: 0, bucketChanged: 0,
            totalVulnsAdded: 0, totalVulnsRemoved: 0};

        const body = ActionFormatter.commentBody([r1, r2], 'owner/repo', 'a'.repeat(40));
        expect(body).toContain('**2** dep changes');
        expect(body).toContain('1 added');
        expect(body).toContain('1 updated');
        expect(body).toContain('🟢 **−1 CVE**');
        expect(body).toContain('### alpha');
        expect(body).toContain('### beta');
        expect(body).toContain('| axios |');
        expect(body).toContain('| lodash |');
    });

    it('caps the CVE id list at 3 with a "+N more" tail', () => {
        const r = emptyReport('demo');
        const added = ['GHSA-1', 'GHSA-2', 'GHSA-3', 'GHSA-4', 'GHSA-5'];
        r.changes = [{
            name: 'ws', kind: 'updated',
            declaredRangeBefore: '^8', declaredRangeAfter: '^8.16',
            vulnsBefore: [], vulnsAfter: added,
            vulnsAdded: added, vulnsRemoved: []
        }];
        r.summary = {added: 0, removed: 0, updated: 1, bucketChanged: 0,
            totalVulnsAdded: 5, totalVulnsRemoved: 0};
        const body = ActionFormatter.commentBody([r], 'owner/repo', 'abcdefg');
        expect(body).toContain('`GHSA-1`, `GHSA-2`, `GHSA-3` +2 more');
    });

    it('escapes pipe characters in package names', () => {
        const r = emptyReport('demo');
        r.changes = [{
            name: 'weird|name', kind: 'added',
            declaredRangeAfter: '^1.0.0',
            vulnsBefore: null, vulnsAfter: [],
            vulnsAdded: [], vulnsRemoved: []
        }];
        r.summary = {added: 1, removed: 0, updated: 0, bucketChanged: 0,
            totalVulnsAdded: 0, totalVulnsRemoved: 0};
        const body = ActionFormatter.commentBody([r], 'owner/repo', 'abcdefg');
        expect(body).toContain('weird\\|name');
    });
});