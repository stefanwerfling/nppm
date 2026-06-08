import nodeFs from 'fs';
import path from 'path';
import {JsonCache} from '../Cache/JsonCache.js';
import {FileFingerprint} from '../Fingerprint/Fingerprint.js';
import {Project} from '../Project/Project.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {PatternFinding, PatternScanner, PatternSeverity} from '../Security/PatternScanner.js';
import {SelfCodeData, SelfCodeFileScore} from './SelfCode.js';

/**
 * Filesystem facade for testability. Matches the shape of
 * `SourceGraphFs` so the two scanners can share the same in-memory
 * test fakes if needed.
 */
export type SelfCodeFs = {
    existsSync: (p: string) => boolean;
    readdirSync: (p: string) => string[];
    readFileSync: (p: string, enc: 'utf-8') => string;
    statSync: (p: string) => {
        isDirectory: () => boolean;
        isFile: () => boolean;
        mtimeMs?: number;
        size?: number;
    };
};

/** Same source-file extensions as `SourceGraphBuilder` so the two views agree on the file set. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Directories never walked into. Identical to the SourceGraph + Unused list. */
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
    'coverage', '.nppm', '.nppm-cache', '.nppm-history', '.next', '.nuxt',
    '.cache', '.parcel-cache', '.turbo', '.vite'
]);

/**
 * Files above this byte size are skipped — bundled / generated
 * fixtures and minified vendor drops are the usual offenders. The
 * pattern scanner would still finish but the value/noise ratio of
 * findings tanks once you're hitting compiled blobs.
 */
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Severity weights used by the per-file score. Same ratio the dashboard
 * uses for its unified score formula (info=1, warn=10, risk=30) so the
 * Self-Code column slots into the existing ring tier — green/amber/red
 * thresholds line up across the matrix.
 */
const SEVERITY_WEIGHT: Record<PatternSeverity, number> = {
    info: 1,
    warn: 10,
    risk: 30
};

/** Cache key prefix — bump when the result shape changes. */
const CACHE_KEY_PREFIX = 'sc_v1_';

/**
 * Walks a local project's source files and runs `PatternScanner`
 * against each one. Returns a per-file score (0–100) plus the raw
 * `PatternFinding[]` so the UI can drill down into specific lines.
 *
 * Pure FS + regex, no network. Cached per project + (file-count,
 * max-mtime) fingerprint so an edit to one source file invalidates
 * the cache without forcing a full re-scan on every page load.
 */
export class SelfCodeScanner {

    private readonly _cache: JsonCache|null;
    private readonly _fs: SelfCodeFs;

    public constructor(cache: JsonCache|null, fs?: SelfCodeFs) {
        this._cache = cache;
        this._fs = fs ?? {
            existsSync: nodeFs.existsSync,
            readdirSync: (p: string): string[] => nodeFs.readdirSync(p),
            readFileSync: (p: string, enc: 'utf-8'): string => nodeFs.readFileSync(p, enc),
            statSync: (p: string): nodeFs.Stats => nodeFs.statSync(p)
        };
    }

    public async scan(project: Project): Promise<SelfCodeData> {
        const projectMeta = {
            unid: '',
            name: project.getName(),
            type: project.getType()
        };

        if (!(project instanceof ProjectLocal)) {
            return {
                project: projectMeta,
                supported: false,
                unsupportedReason: 'Remote projects (GitHub/Gitea) are not scanned in v1 — please check out locally.',
                files: [],
                worst: null,
                totals: {info: 0, warn: 0, risk: 0},
                filesScanned: 0
            };
        }

        const root = project.getRoot();
        const collected: {abs: string; rel: string; mtime: number;}[] = [];
        this._collect(root, collected);

        let maxMtime = 0;
        for (const f of collected) {
            if (f.mtime > maxMtime) {
                maxMtime = f.mtime;
            }
        }
        const cacheKey = `${CACHE_KEY_PREFIX}${project.getKey()}__${collected.length}__${maxMtime}`;
        const cached = this._cache?.get<SelfCodeData>(cacheKey);
        if (cached) {
            return {...cached, project: projectMeta};
        }

        /*
         * Convert source files into the `FileFingerprint` shape
         * `PatternScanner` expects. sha256 stays empty: it's not
         * load-bearing for the scanner — it only uses `path` (for
         * the finding) and `content` (for the regex sweep).
         */
        const ffs: FileFingerprint[] = [];
        for (const {abs, rel} of collected) {
            let content: string;
            try {
                content = this._fs.readFileSync(abs, 'utf-8');
            } catch {
                continue;
            }
            ffs.push({
                path: rel.split(path.sep).join('/'),
                sha256: '',
                size: content.length,
                content: content
            });
        }

        const findings = PatternScanner.scan(ffs);
        const fileScores = SelfCodeScanner._aggregate(ffs, findings);

        const totals = {info: 0, warn: 0, risk: 0};
        let worst: PatternSeverity|null = null;
        for (const f of fileScores) {
            for (const finding of f.findings) {
                totals[finding.severity]++;
                if (worst === null
                    || SEVERITY_WEIGHT[finding.severity] > SEVERITY_WEIGHT[worst]) {
                    worst = finding.severity;
                }
            }
        }

        const result: SelfCodeData = {
            project: projectMeta,
            supported: true,
            files: fileScores,
            worst: worst,
            totals: totals,
            filesScanned: ffs.length
        };

        if (this._cache) {
            this._cache.set(cacheKey, result);
        }

        return result;
    }

    /**
     * Walk the project tree, collecting source files within the size
     * cap. Same skip-set as the other scanners so the three views
     * (Unused, SourceGraph, SelfCode) agree on what counts as
     * "project source".
     */
    private _collect(root: string, out: {abs: string; rel: string; mtime: number;}[]): void {
        const walk = (dir: string): void => {
            let entries: string[];
            try {
                entries = this._fs.readdirSync(dir);
            } catch {
                return;
            }
            for (const entry of entries) {
                if (SKIP_DIRS.has(entry) || entry.startsWith('.')) {
                    continue;
                }
                const full = path.join(dir, entry);
                let stat;
                try {
                    stat = this._fs.statSync(full);
                } catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    walk(full);
                    continue;
                }
                if (!stat.isFile()) {
                    continue;
                }
                const ext = SelfCodeScanner._fileExtension(entry);
                if (!SOURCE_EXTENSIONS.has(ext)) {
                    continue;
                }
                if ((stat.size ?? 0) > MAX_FILE_BYTES) {
                    continue;
                }
                out.push({
                    abs: full,
                    rel: path.relative(root, full),
                    mtime: stat.mtimeMs ?? 0
                });
            }
        };
        walk(root);
    }

    /**
     * Roll the flat finding list into per-file buckets and compute
     * the per-file score. A file with no findings scores 100; each
     * finding deducts its severity weight, floored at 0. The
     * worst-severity tag drives the UI ring colour.
     */
    private static _aggregate(
        files: FileFingerprint[],
        findings: PatternFinding[]
    ): SelfCodeFileScore[] {
        const byPath = new Map<string, PatternFinding[]>();
        for (const f of findings) {
            let arr = byPath.get(f.path);
            if (!arr) {
                arr = [];
                byPath.set(f.path, arr);
            }
            arr.push(f);
        }

        const out: SelfCodeFileScore[] = [];
        for (const file of files) {
            const fileFindings = byPath.get(file.path) ?? [];
            let penalty = 0;
            let worst: PatternSeverity|null = null;
            for (const f of fileFindings) {
                penalty += SEVERITY_WEIGHT[f.severity];
                if (worst === null
                    || SEVERITY_WEIGHT[f.severity] > SEVERITY_WEIGHT[worst]) {
                    worst = f.severity;
                }
            }
            const score = Math.max(0, 100 - penalty);
            out.push({
                id: file.path,
                score: score,
                findings: fileFindings,
                severity: worst
            });
        }
        out.sort((a, b) => a.id.localeCompare(b.id));
        return out;
    }

    private static _fileExtension(p: string): string {
        const dot = p.lastIndexOf('.');
        const sep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        if (dot < 0 || dot < sep) {
            return '';
        }
        return p.slice(dot).toLowerCase();
    }

}