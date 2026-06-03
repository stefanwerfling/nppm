import {FileFingerprint} from '../Fingerprint/Fingerprint.js';

/**
 * Three-level severity for one file's obfuscation verdict. Mirrors
 * the other heuristic scanners' info/warn/risk ladder so the unified
 * pipeline can aggregate without re-mapping.
 */
export enum ObfuscationSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

/**
 * Named signals that contributed to the verdict. Surfaced in the
 * PackageDetailPanel as a comma-separated list per file — lets the
 * user see *why* a file was flagged rather than just *that* it was.
 *
 *  - `obfuscator-io-identifier`: the `_0x[a-f0-9]{4,}` variable-name
 *    fingerprint of the popular obfuscator.io toolchain.
 *  - `eval-decoded`: the classic `eval(atob(…))` / `new Function(atob(…))`
 *    pattern — a tarball that decodes a base64 blob and runs it has
 *    almost no legitimate use case in a published package.
 *  - `hex-string-array`: a long `["\x48", "\x65", …]` array, the
 *    typical packed-payload format.
 *  - `long-line`: a single line over `LONG_LINE_THRESHOLD` characters
 *    in a path that doesn't look like a `dist/`/`*.min.js` artifact.
 *  - `dense-hex-literals`: a high density of `"\x48\x65…"` string
 *    literals (more than one every few KB of source).
 */
export type ObfuscationSignal =
    | 'obfuscator-io-identifier'
    | 'eval-decoded'
    | 'hex-string-array'
    | 'long-line'
    | 'dense-hex-literals';

export type ObfuscationFinding = {
    path: string;
    severity: ObfuscationSeverity;
    signals: ObfuscationSignal[];
    /** Human-readable summary used as the panel's secondary line. */
    detail: string;
    /** True when the file lives under a typical build-artifact path. */
    isBuildArtifact: boolean;
};

export type ObfuscationSummary = {
    name: string;
    version: string;
    maxSeverity: ObfuscationSeverity|null;
    count: number;
};

/**
 * Lines longer than this in a non-build path are highly unusual —
 * production source rarely goes past ~120, generated code maybe a few
 * hundred. 5 000+ on a single line is either heavy minification (then
 * the path classifier catches it as a build artifact) or intentional
 * obfuscation.
 */
const LONG_LINE_THRESHOLD = 5000;

/**
 * `_0x` matches per kB of source. The threshold is conservative: a
 * library that legitimately uses a few `_0x` symbols (e.g. as
 * documented identifiers) sits well below. Real obfuscator output
 * peppers them every few tokens.
 */
const OBFUSCATOR_DENSITY_RISK = 5;
const OBFUSCATOR_DENSITY_WARN = 1;

/**
 * Hex-escape literal density (`\x[0-9a-f]{2}` count per kB). Same idea:
 * a one-off `"\x00"` constant is fine; a payload packs hundreds.
 */
const HEX_DENSITY_WARN = 8;

/**
 * Path classifier for "is this a build artifact?". Matches the
 * conventional places where minified bundles live so legitimate
 * minification doesn't get flagged as malicious obfuscation. The
 * suffixes / segments here cover the npm-ecosystem standards
 * (`dist/`, `build/`, `lib/`, `umd/`, `esm/`, `min/`) plus the
 * filename markers (`.min.js`, `.bundle.js`, `.umd.js`).
 */
const BUILD_PATH_HINTS = [
    '/dist/', '/build/', '/lib/', '/umd/', '/esm/', '/min/',
    '/vendor/', '/bundle/', '/bundled/'
];
const BUILD_FILE_SUFFIXES = ['.min.js', '.min.cjs', '.min.mjs', '.bundle.js', '.umd.js'];

/**
 * Pure static scanner: walks `FileFingerprint[]`, decides per file
 * whether the content looks obfuscated, and aggregates to the matrix
 * summary. Reads only `file.content` (already cached by the
 * FingerprintBuilder for JS files); files without content are
 * skipped — same shape as `PatternScanner.scan`.
 */
export class ObfuscationScanner {

    public static scan(files: FileFingerprint[]): ObfuscationFinding[] {
        const out: ObfuscationFinding[] = [];
        for (const f of files) {
            if (typeof f.content !== 'string' || f.content.length === 0) {
                continue;
            }
            const finding = ObfuscationScanner._classifyFile(f.path, f.content);
            if (finding) {
                out.push(finding);
            }
        }
        return out;
    }

    /**
     * Roll a per-file finding list into the matrix-badge shape. `null`
     * severity means nothing flagged at all for this `pkg@version`.
     */
    public static summarise(
        name: string,
        version: string,
        findings: ObfuscationFinding[]
    ): ObfuscationSummary {
        const rank: Record<ObfuscationSeverity, number> = {
            [ObfuscationSeverity.info]: 1,
            [ObfuscationSeverity.warn]: 2,
            [ObfuscationSeverity.risk]: 3
        };
        let best: ObfuscationSeverity|null = null;
        let bestRank = 0;
        for (const f of findings) {
            const r = rank[f.severity];
            if (r > bestRank) {
                best = f.severity;
                bestRank = r;
            }
        }
        return {name, version, maxSeverity: best, count: findings.length};
    }

    /**
     * Whether `path` looks like a conventional build-output location.
     * Public for unit tests; the build-vs-source distinction is the
     * single most important signal in distinguishing legit
     * minification from supply-chain obfuscation.
     */
    public static isBuildArtifact(path: string): boolean {
        const lower = path.toLowerCase();
        for (const hint of BUILD_PATH_HINTS) {
            if (lower.includes(hint)) {
                return true;
            }
        }
        for (const suffix of BUILD_FILE_SUFFIXES) {
            if (lower.endsWith(suffix)) {
                return true;
            }
        }
        return false;
    }

    private static _classifyFile(path: string, content: string): ObfuscationFinding|null {
        const isBuild = ObfuscationScanner.isBuildArtifact(path);
        const sizeKb = Math.max(1, content.length / 1024);
        const signals: ObfuscationSignal[] = [];
        const details: string[] = [];

        // -- eval-decoded chain (strongest single signal) --
        // `eval(atob(…))`, `Function(atob(…))()`, `new Function(atob(…))`.
        // The whitespace/argument tolerance is intentional: obfuscator
        // output often inserts dead variables between the call sites.
        const evalDecoded = /\b(?:eval|new\s+Function|Function)\s*\(\s*(?:atob|Buffer\.from|String\.fromCharCode)\b/g;
        const evalMatches = content.match(evalDecoded);
        if (evalMatches && evalMatches.length > 0) {
            signals.push('eval-decoded');
            details.push(`${evalMatches.length} eval(decoded) chain(s)`);
        }

        // -- obfuscator.io _0x identifier density --
        const obfuscatorMatches = content.match(/\b_0x[a-f0-9]{4,}\b/g);
        const obfuscatorCount = obfuscatorMatches?.length ?? 0;
        const obfuscatorDensity = obfuscatorCount / sizeKb;
        if (obfuscatorCount >= 3 && obfuscatorDensity >= OBFUSCATOR_DENSITY_WARN) {
            signals.push('obfuscator-io-identifier');
            details.push(`${obfuscatorCount} _0x identifiers (${obfuscatorDensity.toFixed(1)}/kB)`);
        }

        // -- hex-string array (packed payload) --
        // Matches `["\x..", "\x..", …]` arrays with at least 8 hex
        // entries — short ones can be lookup tables.
        const hexArrayMatch = content.match(
            /\[\s*(?:"\\x[0-9a-f]{2}(?:[^"]*?)"\s*,\s*){7,}"\\x[0-9a-f]{2}(?:[^"]*?)"\s*\]/gi
        );
        if (hexArrayMatch && hexArrayMatch.length > 0) {
            signals.push('hex-string-array');
            details.push(`${hexArrayMatch.length} hex-string array(s)`);
        }

        // -- hex-literal density --
        const hexLiteralMatches = content.match(/\\x[0-9a-f]{2}/gi);
        const hexCount = hexLiteralMatches?.length ?? 0;
        const hexDensity = hexCount / sizeKb;
        if (hexCount >= 50 && hexDensity >= HEX_DENSITY_WARN) {
            signals.push('dense-hex-literals');
            details.push(`${hexCount} \\xHH literals (${hexDensity.toFixed(1)}/kB)`);
        }

        // -- long line (only meaningful in source paths) --
        if (!isBuild) {
            let maxLineLength = 0;
            for (const line of content.split('\n')) {
                if (line.length > maxLineLength) {
                    maxLineLength = line.length;
                    if (maxLineLength > LONG_LINE_THRESHOLD * 10) {
                        // Early-out for pathological cases.
                        break;
                    }
                }
            }
            if (maxLineLength > LONG_LINE_THRESHOLD) {
                signals.push('long-line');
                details.push(`max line ${maxLineLength.toLocaleString('en-US')} chars`);
            }
        }

        if (signals.length === 0) {
            return null;
        }

        // -- severity rollup --
        // Build-artifact paths cap at info even when signals fire: a
        // minified `dist/index.min.js` IS supposed to look that way.
        // Source paths escalate based on which signals fired.
        let severity: ObfuscationSeverity;
        if (isBuild) {
            severity = ObfuscationSeverity.info;
        } else if (signals.includes('eval-decoded')
                || (signals.includes('obfuscator-io-identifier') && obfuscatorDensity >= OBFUSCATOR_DENSITY_RISK)) {
            severity = ObfuscationSeverity.risk;
        } else if (signals.includes('obfuscator-io-identifier')
                || signals.includes('hex-string-array')
                || signals.includes('long-line')
                || signals.includes('dense-hex-literals')) {
            severity = ObfuscationSeverity.warn;
        } else {
            severity = ObfuscationSeverity.info;
        }

        return {
            path,
            severity,
            signals,
            detail: details.join(', '),
            isBuildArtifact: isBuild
        };
    }
}