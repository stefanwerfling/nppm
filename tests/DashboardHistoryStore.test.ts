import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DashboardHistoryStore} from '../Dashboard/DashboardHistoryStore.js';
import {DashboardResponse, SCANNER_IDS} from '../Dashboard/DashboardBuilder.js';
import {ConfigProjectType} from '../Config/Config.js';

const mkDashboard = (rows: {
    unid: string;
    name: string;
    cells: Record<string, number|null>;
    sizeBytes?: number;
}[]): DashboardResponse => ({
    scanners: [...SCANNER_IDS],
    columns: rows.map((r) => ({
        project: {unid: r.unid, name: r.name, type: ConfigProjectType.local},
        cells: Object.fromEntries(
            Object.entries(r.cells).map(([scanner, score]) => [
                scanner,
                {score, counts: {info: 0, warn: 0, risk: 0}, total: 0, findings: []}
            ])
        ),
        ...(r.sizeBytes !== undefined ? {sizeBytes: r.sizeBytes} : {})
    }))
});

describe('DashboardHistoryStore', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-dh-'));
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('summarises per-project + per-scanner + overall averages', () => {
        const dashboard = mkDashboard([
            {unid: 'a', name: 'projA', cells: {cve: 80, license: 100}},
            {unid: 'b', name: 'projB', cells: {cve: 50, license: 50}}
        ]);
        const entry = DashboardHistoryStore.summarize(dashboard, '2026-06-04T10:00:00Z');
        expect(entry.perProject).toEqual([
            {unid: 'a', name: 'projA', avg: 90, sizeBytes: null},
            {unid: 'b', name: 'projB', avg: 50, sizeBytes: null}
        ]);
        expect(entry.perScanner.find((s) => s.scanner === 'cve')?.avg).toBe(65);
        expect(entry.perScanner.find((s) => s.scanner === 'license')?.avg).toBe(75);
        expect(entry.overall).toBe(70);
        expect(entry.totalSizeBytes).toBeNull();
    });

    it('aggregates totalSizeBytes when column-level sizeBytes are present', () => {
        const dashboard = mkDashboard([
            {unid: 'a', name: 'projA', cells: {cve: 80}, sizeBytes: 12_000_000},
            {unid: 'b', name: 'projB', cells: {cve: 50}, sizeBytes: 8_000_000},
            {unid: 'c', name: 'projC', cells: {cve: 70}} // no size
        ]);
        const entry = DashboardHistoryStore.summarize(dashboard, '2026-06-04T10:00:00Z');
        expect(entry.totalSizeBytes).toBe(20_000_000);
        expect(entry.perProject[0].sizeBytes).toBe(12_000_000);
        expect(entry.perProject[1].sizeBytes).toBe(8_000_000);
        expect(entry.perProject[2].sizeBytes).toBeNull();
    });

    it('returns overall=null when every cell is N/A', () => {
        const dashboard = mkDashboard([
            {unid: 'a', name: 'projA', cells: {cve: null, license: null}}
        ]);
        const entry = DashboardHistoryStore.summarize(dashboard, '2026-06-04T10:00:00Z');
        expect(entry.overall).toBeNull();
        expect(entry.perProject[0].avg).toBeNull();
    });

    it('records under YYYY-MM-DD and overwrites same-day re-scans', () => {
        const store = new DashboardHistoryStore(dir);
        const d1 = mkDashboard([{unid: 'a', name: 'projA', cells: {cve: 80}}]);
        const d2 = mkDashboard([{unid: 'a', name: 'projA', cells: {cve: 50}}]);
        store.recordScan(d1, '2026-06-04T09:00:00Z');
        store.recordScan(d2, '2026-06-04T22:00:00Z');
        // Same UTC date → one file.
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        expect(files).toEqual(['2026-06-04.json']);
        const raw = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'));
        expect(raw.overall).toBe(50); // second scan wins
    });

    it('readRange filters by days cutoff and returns chronological order', () => {
        const store = new DashboardHistoryStore(dir);
        // 5 days old → outside a 3d window.
        store.recordScan(mkDashboard([{unid: 'a', name: 'a', cells: {cve: 60}}]),
            new Date(Date.now() - 5 * 86400_000).toISOString());
        // 2 days old + today → both inside a 3d window.
        store.recordScan(mkDashboard([{unid: 'a', name: 'a', cells: {cve: 70}}]),
            new Date(Date.now() - 2 * 86400_000).toISOString());
        store.recordScan(mkDashboard([{unid: 'a', name: 'a', cells: {cve: 80}}]),
            new Date().toISOString());
        const range = store.readRange(3);
        expect(range.length).toBe(2);
        expect(range[0].overall).toBe(70);
        expect(range[1].overall).toBe(80);
    });

    it('readPrevious returns the entry strictly before the given timestamp', () => {
        const store = new DashboardHistoryStore(dir);
        store.recordScan(mkDashboard([{unid: 'a', name: 'a', cells: {cve: 50}}]),
            '2026-05-01T10:00:00Z');
        store.recordScan(mkDashboard([{unid: 'a', name: 'a', cells: {cve: 70}}]),
            '2026-06-04T10:00:00Z');
        const prev = store.readPrevious('2026-06-04T10:00:00Z');
        expect(prev?.overall).toBe(50);
    });

    it('readRange returns [] when no history dir entries exist', () => {
        const store = new DashboardHistoryStore(dir);
        expect(store.readRange(30)).toEqual([]);
    });

    it('readRange skips corrupt files instead of crashing', () => {
        const store = new DashboardHistoryStore(dir);
        store.recordScan(mkDashboard([{unid: 'a', name: 'a', cells: {cve: 80}}]),
            new Date().toISOString());
        fs.writeFileSync(path.join(dir, '2026-99-99.json'), 'not-json');
        const range = store.readRange(7);
        expect(range.length).toBe(1);
        expect(range[0].overall).toBe(80);
    });
});