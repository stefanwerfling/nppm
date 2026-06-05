import {FileFingerprint} from '../Fingerprint/Fingerprint.js';

/**
 * Severity ladder mirrors the other scanners (info/warn/risk). The
 * mapping reflects "how much of a surprise is this in a npm package":
 *
 *  - `risk`: native code that runs *outside* any sandbox if the user
 *    ever invokes the tool that wraps it — `.exe`, `.dll`, `.so`,
 *    `.dylib`, `.o`, `.a`. None of these are normal in a published
 *    JS package; if they're here, the author shipped a binary for a
 *    specific reason and a reviewer should know.
 *  - `warn`: legitimate native bindings (`.node`) — common in
 *    `sharp`, `better-sqlite3`, `bcrypt`, ... but still executable
 *    code, so we flag it.
 *  - `info`: `.wasm` — runs in the JS sandbox so the blast radius is
 *    bounded, but worth surfacing because it's still pre-built code
 *    the user didn't compile from source.
 */
export enum BinarySeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type BinaryFinding = {
    path: string;
    size: number;
    extension: string;
    kind: string;
    severity: BinarySeverity;
};

type ExtRule = {
    extensions: string[];
    kind: string;
    severity: BinarySeverity;
};

/**
 * Extension → severity classification table. Pattern: keep this list
 * tight; broad rules (e.g. flagging *every* file with a NUL byte)
 * would catch images, fonts, source maps. Reviewers stop trusting
 * the badge then.
 */
const RULES: ExtRule[] = [
    {extensions: ['.exe'], kind: 'Windows-Executable', severity: BinarySeverity.risk},
    {extensions: ['.dll'], kind: 'Windows-DLL', severity: BinarySeverity.risk},
    {extensions: ['.so'], kind: 'Linux-Shared-Library', severity: BinarySeverity.risk},
    {extensions: ['.dylib'], kind: 'macOS-Library', severity: BinarySeverity.risk},
    {extensions: ['.o', '.a'], kind: 'Object/Archive', severity: BinarySeverity.risk},
    {extensions: ['.node'], kind: 'Native-Node-Modul', severity: BinarySeverity.warn},
    {extensions: ['.wasm'], kind: 'WebAssembly', severity: BinarySeverity.info}
];

const RULE_BY_EXT = (() => {
    const m = new Map<string, ExtRule>();
    for (const rule of RULES) {
        for (const ext of rule.extensions) {
            m.set(ext, rule);
        }
    }
    return m;
})();

/**
 * Compact summary for the matrix badge. `maxSeverity: null` = no
 * binary files at all (the boring common case for pure-JS packages).
 */
export type BinarySummary = {
    name: string;
    version: string;
    maxSeverity: BinarySeverity|null;
    riskCount: number;
    totalCount: number;
};

/**
 * Text extensions that pop up in `bin/` directories (shell wrappers,
 * shebang-JS, …) — these are *not* pre-built native executables and
 * mustn't trigger the path-based heuristic below.
 */
const KNOWN_TEXT_EXTS = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.sh', '.bash', '.zsh', '.fish',
    '.py', '.rb', '.pl', '.json', '.md', '.txt', '.html', '.css',
    '.yml', '.yaml', '.toml', '.lock', '.map'
]);

const SORT_RANK: Record<BinarySeverity, number> = {
    [BinarySeverity.risk]: 0,
    [BinarySeverity.warn]: 1,
    [BinarySeverity.info]: 2
};

const SEVERITY_RANK: Record<BinarySeverity, number> = {
    [BinarySeverity.info]: 1,
    [BinarySeverity.warn]: 2,
    [BinarySeverity.risk]: 3
};

/**
 * Stateless binary-file classifier. Public surface is two static
 * methods (`scan` + `summarise`); the extension table and path
 * heuristic live as private statics so callers don't have to think
 * about them.
 */
export class BinaryScanner {

    /**
     * Scan a fingerprint's file list for binaries with known-suspect
     * extensions. Returns findings sorted by severity (worst first),
     * then by path — the security panel renders them in this order.
     */
    public static scan(files: FileFingerprint[]): BinaryFinding[] {
        const findings: BinaryFinding[] = [];

        for (const f of files) {
            const ext = BinaryScanner._fileExtension(f.path);
            const rule = RULE_BY_EXT.get(ext);
            if (rule) {
                findings.push({
                    path: f.path,
                    size: f.size,
                    extension: ext,
                    kind: rule.kind,
                    severity: rule.severity
                });
                continue;
            }
            // No known extension — fall through to the path heuristic.
            if (BinaryScanner._pathLooksExecutable(f.path, ext, f.size)) {
                findings.push({
                    path: f.path,
                    size: f.size,
                    extension: ext,
                    kind: 'Pre-built Executable (bin/)',
                    severity: BinarySeverity.risk
                });
            }
        }

        findings.sort((a, b) => {
            const r = SORT_RANK[a.severity] - SORT_RANK[b.severity];
            return r !== 0 ? r : a.path.localeCompare(b.path);
        });

        return findings;
    }

    /**
     * Roll a finding list up to one summary record — what the matrix
     * badge consumes. `maxSeverity: null` = nothing to flag.
     */
    public static summarise(findings: BinaryFinding[]): {
        maxSeverity: BinarySeverity|null;
        riskCount: number;
        totalCount: number;
    } {
        let best: BinarySeverity|null = null;
        let bestRank = 0;
        let riskCount = 0;
        for (const f of findings) {
            const r = SEVERITY_RANK[f.severity];
            if (r > bestRank) {
                best = f.severity;
                bestRank = r;
            }
            if (f.severity === BinarySeverity.risk) {
                riskCount++;
            }
        }
        return {maxSeverity: best, riskCount: riskCount, totalCount: findings.length};
    }

    /**
     * Take the segment after the last `/`, then everything from the
     * last `.` in that segment. Composite extensions like `.tar.gz`
     * collapse to `.gz` here, which is fine — none of our rules need
     * to look further.
     */
    private static _fileExtension(path: string): string {
        const slash = path.lastIndexOf('/');
        const base = slash >= 0 ? path.slice(slash + 1) : path;
        const dot = base.lastIndexOf('.');
        return dot >= 0 ? base.slice(dot).toLowerCase() : '';
    }

    /**
     * Extension-less files under a `bin/` directory are conventionally
     * pre-built executables (`@esbuild/linux-x64/bin/esbuild`, biome,
     * lightningcss native binaries). They have no `.exe`/`.so` extension
     * because Unix doesn't need one — but they're absolutely binaries.
     *
     * Size floor of 10 KiB filters out shell-wrapper shims (those are
     * usually 1-2 KiB).
     */
    private static _pathLooksExecutable(path: string, ext: string, size: number): boolean {
        if (size < 10 * 1024) {
            return false;
        }
        if (ext !== '' && KNOWN_TEXT_EXTS.has(ext)) {
            return false;
        }
        const segments = path.split('/');
        return segments.includes('bin');
    }

}