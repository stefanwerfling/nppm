import {FileFingerprint} from '../Fingerprint/Fingerprint.js';

/**
 * Same three-level ladder as the other scanners. Kept as its own enum
 * so a future severity change for pattern findings doesn't ripple into
 * script/churn semantics.
 */
export enum PatternSeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

export type PatternFinding = {
    path: string;
    line: number;
    pattern: string;
    severity: PatternSeverity;
    snippet: string;
};

type PatternDef = {
    name: string;
    regex: RegExp;
    severity: PatternSeverity;
};

/**
 * Active pattern set. Designed for **signal**, not coverage — every
 * pattern here is one that should make a reviewer pause. False
 * positives train the user to ignore the badge, so keep the list
 * tight.
 *
 *  - `eval(`, `new Function(`: dynamic code execution
 *  - `Function(` standalone is intentionally not flagged (matches
 *     `[].constructor.constructor` tricks but also `Function.prototype`
 *     reads — too noisy)
 *  - `child_process.exec[Sync]`: spawning shells from a library
 *  - `Buffer.from(..., 'base64')` followed by `eval`/`Function` is the
 *    classic obfuscation; we flag the base64 decode on its own as warn,
 *    since paired-with-eval is hard to match across newlines reliably
 *
 * The second group ("suspicious strings") was added later — they
 * don't catch dynamic-execution per se, but each is a known
 * exfiltration / staging path used by real-world npm attacks:
 *
 *  - Discord / Slack / Telegram webhook URLs: classic data exfil
 *    targets (used by `eslint-scope`-style incidents)
 *  - ngrok / pastebin raw: staging hosts for malicious payloads
 *  - raw-IP URLs in `http(s)://`: never-OK in published libraries
 *  - `process.env.{AWS_*, *_SECRET, *_TOKEN, *_PASSWORD}` reads:
 *    library code shouldn't ingest secrets directly (apps should)
 *  - `_0x[a-f0-9]+` variable names: the unmistakable fingerprint of
 *    the popular `obfuscator.io` toolchain
 */
const PATTERNS: PatternDef[] = [
    // -- dynamic-execution / code-loading group --
    {name: 'eval(...)', regex: /\beval\s*\(/g, severity: PatternSeverity.risk},
    {name: 'new Function(...)', regex: /\bnew\s+Function\s*\(/g, severity: PatternSeverity.risk},
    {name: 'child_process.exec*', regex: /child_process\s*\.\s*exec\w*/g, severity: PatternSeverity.warn},
    {name: 'require("child_process")', regex: /require\s*\(\s*['"]child_process['"]\s*\)/g, severity: PatternSeverity.warn},
    {name: 'Buffer.from(..., "base64")', regex: /Buffer\.from\s*\([^)]*['"]base64['"]/g, severity: PatternSeverity.warn},
    {name: 'long base64 literal', regex: /['"`][A-Za-z0-9+/=]{300,}['"`]/g, severity: PatternSeverity.warn},

    // -- exfiltration / staging URL group --
    {name: 'Discord webhook URL', regex: /discord(?:app)?\.com\/api\/webhooks\//gi, severity: PatternSeverity.risk},
    {name: 'Slack webhook URL', regex: /hooks\.slack\.com\/services\//gi, severity: PatternSeverity.risk},
    {name: 'Telegram bot token URL', regex: /api\.telegram\.org\/bot\d+:/gi, severity: PatternSeverity.risk},
    {name: 'Pastebin raw URL', regex: /pastebin\.com\/raw\//gi, severity: PatternSeverity.warn},
    {name: 'ngrok tunnel URL', regex: /\b[a-z0-9-]+\.ngrok(?:-free)?\.(?:io|app)\b/gi, severity: PatternSeverity.warn},
    {name: 'raw-IP URL', regex: /\bhttps?:\/\/(?:\d{1,3}\.){3}\d{1,3}\b/g, severity: PatternSeverity.warn},

    // -- secret-env-read group --
    {name: 'AWS credentials env read', regex: /process\.env\.(?:AWS_ACCESS_KEY(?:_ID)?|AWS_SECRET_(?:ACCESS_)?KEY|AWS_SESSION_TOKEN)/g, severity: PatternSeverity.warn},
    {name: 'Secret/token env read', regex: /process\.env\.[A-Z_]*(?:SECRET|API_?KEY|PRIVATE_?KEY|PASSWORD|PASSWD)[A-Z_]*/g, severity: PatternSeverity.warn},

    // -- obfuscator fingerprint --
    {name: 'Obfuscated _0x variable', regex: /\b_0x[a-f0-9]{4,}\b/g, severity: PatternSeverity.warn}
];

/**
 * Stateless regex scanner over the per-file `content` that
 * `FingerprintBuilder` caches for JS sources. Pure: no instance state,
 * everything goes through static methods so callers don't carry a
 * scanner instance around for one-shot use.
 */
export class PatternScanner {

    /**
     * Walk every file's cached `content` and return one finding per
     * match. Files without `content` (TypeScript declarations,
     * binaries, files over the size cap) are silently skipped — they
     * were never cached, so we can't scan them.
     *
     * Line numbers are 1-based and computed once per file from the
     * leading substring; this is O(file_size) but `content` is capped
     * by the fingerprint builder so it stays fast.
     */
    public static scan(files: FileFingerprint[]): PatternFinding[] {
        const findings: PatternFinding[] = [];

        for (const file of files) {
            if (typeof file.content !== 'string') {
                continue;
            }

            for (const def of PATTERNS) {
                // Reset regex state — these patterns are declared with
                // the `g` flag, so `lastIndex` carries over across
                // files otherwise.
                def.regex.lastIndex = 0;

                let match: RegExpExecArray|null;
                while ((match = def.regex.exec(file.content)) !== null) {
                    const before = file.content.slice(0, match.index);
                    const line = before.split('\n').length;

                    findings.push({
                        path: file.path,
                        line,
                        pattern: def.name,
                        severity: def.severity,
                        snippet: PatternScanner._snippetAround(file.content, match.index, match[0].length)
                    });
                }
            }
        }

        return findings;
    }

    /**
     * Pull a one-line-ish window around the match for the UI. We
     * don't try to be precise — just enough context that the user can
     * decide whether to click through to the full source.
     */
    private static _snippetAround(source: string, start: number, length: number): string {
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = source.indexOf('\n', start + length);
        const slice = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
        return slice.length > 200 ? slice.slice(0, 200) + '…' : slice;
    }
}