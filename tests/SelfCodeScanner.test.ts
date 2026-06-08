import {describe, expect, it} from 'vitest';
import {Lockfile} from '../backend/Project/Lockfile.js';
import {PackageManifest} from '../backend/Project/PackageManifest.js';
import {ProjectLocal} from '../backend/Project/ProjectLocal.js';
import {SelfCodeFs, SelfCodeScanner} from '../backend/SelfCode/SelfCodeScanner.js';

class TestLocalProject extends ProjectLocal {

    constructor(root: string) {
        super(root, 'fixture');
    }

    public async loadManifests(): Promise<PackageManifest[]> {
        return [];
    }

    public async loadLockfile(): Promise<Lockfile|null> {
        return null;
    }

}

function makeFs(files: Record<string, string>): SelfCodeFs {
    return {
        existsSync: (p) => Object.hasOwn(files, p),
        readdirSync: (p) => {
            const prefix = `${p}/`;
            const out = new Set<string>();
            for (const key of Object.keys(files)) {
                if (key.startsWith(prefix)) {
                    out.add(key.slice(prefix.length).split('/')[0]);
                }
            }
            return Array.from(out);
        },
        readFileSync: (p) => {
            const v = files[p];
            if (v === undefined || v === '<dir>') {
                throw new Error(`ENOENT: ${p}`);
            }
            return v;
        },
        statSync: (p) => ({
            isDirectory: () => files[p] === '<dir>',
            isFile: () => files[p] !== undefined && files[p] !== '<dir>',
            mtimeMs: 0,
            size: files[p]?.length ?? 0
        })
    };
}

describe('SelfCodeScanner.scan', () => {
    const ROOT = '/p';

    it('flags an eval() call as risk and tanks the file score', async() => {
        const scanner = new SelfCodeScanner(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/a.ts`]: 'eval(userInput);\n'
        }));

        const data = await scanner.scan(new TestLocalProject(ROOT));

        expect(data.supported).toBe(true);
        expect(data.files).toHaveLength(1);
        const a = data.files[0];
        expect(a.id).toBe('src/a.ts');
        expect(a.findings.length).toBeGreaterThan(0);
        expect(a.findings[0].pattern).toBe('eval(...)');
        expect(a.severity).toBe('risk');
        expect(a.score).toBe(70); // 100 - 30 risk weight
        expect(data.worst).toBe('risk');
        expect(data.totals.risk).toBe(1);
    });

    it('returns a perfect score for a clean file', async() => {
        const scanner = new SelfCodeScanner(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/src`]: '<dir>',
            [`${ROOT}/src/clean.ts`]: 'export const x = 1;\n'
        }));

        const data = await scanner.scan(new TestLocalProject(ROOT));

        expect(data.files[0].score).toBe(100);
        expect(data.files[0].severity).toBeNull();
        expect(data.worst).toBeNull();
    });

    it('aggregates totals across multiple files and severities', async() => {
        const scanner = new SelfCodeScanner(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/a.ts`]: 'eval(x);\n', // risk
            [`${ROOT}/b.ts`]: 'const k = process.env.MY_SECRET;\n', // warn
            [`${ROOT}/c.ts`]: 'export const z = 1;\n' // clean
        }));

        const data = await scanner.scan(new TestLocalProject(ROOT));

        expect(data.totals.risk).toBeGreaterThanOrEqual(1);
        expect(data.totals.warn).toBeGreaterThanOrEqual(1);
        expect(data.worst).toBe('risk');
        const clean = data.files.find((f) => f.id === 'c.ts')!;
        expect(clean.score).toBe(100);
    });

    it('skips files over the size cap (256 KB)', async() => {
        const big = 'x'.repeat(300 * 1024);
        const scanner = new SelfCodeScanner(null, makeFs({
            [ROOT]: '<dir>',
            [`${ROOT}/big.ts`]: big,
            [`${ROOT}/small.ts`]: 'export const x = 1;'
        }));

        const data = await scanner.scan(new TestLocalProject(ROOT));

        const ids = data.files.map((f) => f.id);
        expect(ids).toContain('small.ts');
        expect(ids).not.toContain('big.ts');
    });

});