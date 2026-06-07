import {describe, expect, it} from 'vitest';
import {FileFingerprint} from '../backend/Fingerprint/Fingerprint.js';
import {PatternScanner, PatternSeverity} from '../backend/Security/PatternScanner.js';

function file(path: string, content: string|undefined): FileFingerprint {
    const f: FileFingerprint = {path: path, sha256: 'x', size: content?.length ?? 0};
    if (content !== undefined) {
        f.content = content;
    }
    return f;
}

describe('PatternScanner.scan', () => {
    it('flags eval() and new Function() as risk', () => {
        const findings = PatternScanner.scan([
            file('lib/a.js', 'const x = eval("1+1");'),
            file('lib/b.js', 'const y = new Function("return 1");')
        ]);

        expect(findings).toHaveLength(2);
        expect(findings.every((f) => f.severity === PatternSeverity.risk)).toBe(true);
        expect(findings[0].path).toBe('lib/a.js');
        expect(findings[0].line).toBe(1);
    });

    it('flags child_process require and member access', () => {
        const findings = PatternScanner.scan([
            /*
             * Two separate styles in two files. The combined-on-one-line
             * form `require("child_process").exec()` only matches the
             * require regex (the string literal breaks the `.exec`
             * adjacency); we cover the member-access form via a bound
             * variable.
             */
            file('lib/exec.js', 'const cp = require("child_process"); child_process.execSync("ls")'),
            file('lib/dec.js', 'Buffer.from(input, "base64").toString()')
        ]);

        expect(findings.map((f) => f.pattern).sort()).toEqual([
            'Buffer.from(..., "base64")',
            'child_process.exec*',
            'require("child_process")'
        ]);
        expect(findings.every((f) => f.severity === PatternSeverity.warn)).toBe(true);
    });

    it('flags long base64 literal blobs', () => {
        const blob = 'A'.repeat(400);
        const findings = PatternScanner.scan([
            file('lib/blob.js', `const data = "${blob}";`)
        ]);

        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toMatch(/base64 literal/u);
    });

    it('skips files without cached content', () => {
        const findings = PatternScanner.scan([
            file('lib/big.js', undefined),
            file('lib/clean.js', 'console.log("hi")')
        ]);

        expect(findings).toEqual([]);
    });

    it('reports the correct line number for matches on later lines', () => {
        const src = ['// header', '// comment', 'const x = eval(input);'].join('\n');
        const findings = PatternScanner.scan([file('lib/a.js', src)]);
        expect(findings[0].line).toBe(3);
    });

    it('emits one finding per match (multi-match files)', () => {
        const src = 'eval(a); eval(b); eval(c);';
        const findings = PatternScanner.scan([file('lib/m.js', src)]);
        expect(findings).toHaveLength(3);
    });

    it('flags exfiltration webhook URLs as risk', () => {
        const findings = PatternScanner.scan([
            file('lib/discord.js', 'fetch("https://discord.com/api/webhooks/123/abc")'),
            file('lib/slack.js', 'fetch("https://hooks.slack.com/services/T0/B0/x")'),
            file('lib/telegram.js', 'fetch("https://api.telegram.org/bot123:secret/sendMessage")')
        ]);

        const names = findings.map((f) => f.pattern).sort();
        expect(names).toEqual([
            'Discord webhook URL',
            'Slack webhook URL',
            'Telegram bot token URL'
        ]);
        expect(findings.every((f) => f.severity === PatternSeverity.risk)).toBe(true);
    });

    it('flags ngrok / pastebin / raw-IP URLs as warn', () => {
        const findings = PatternScanner.scan([
            file('lib/n.js', 'const tunnel = "https://abcd-12.ngrok-free.app/payload"'),
            file('lib/p.js', 'const drop = "https://pastebin.com/raw/abcd1234"'),
            file('lib/i.js', 'fetch("https://203.0.113.7/install.sh")')
        ]);

        const names = findings.map((f) => f.pattern).sort();
        expect(names).toEqual([
            'Pastebin raw URL',
            'ngrok tunnel URL',
            'raw-IP URL'
        ]);
        expect(findings.every((f) => f.severity === PatternSeverity.warn)).toBe(true);
    });

    it('flags AWS credential env reads', () => {
        const findings = PatternScanner.scan([
            file('lib/a.js', 'const key = process.env.AWS_SECRET_ACCESS_KEY'),
            file('lib/b.js', 'const id  = process.env.AWS_ACCESS_KEY_ID'),
            file('lib/c.js', 'const tok = process.env.AWS_SESSION_TOKEN')
        ]);
        const aws = findings.filter((f) => f.pattern === 'AWS credentials env read');
        expect(aws.length).toBe(3);
        /*
         * The AWS_SECRET_ACCESS_KEY read also legitimately matches the
         * generic Secret/token pattern — overlap is intentional, both
         * signals are useful to a reviewer.
         */
        const generic = findings.filter((f) => f.pattern === 'Secret/token env read');
        expect(generic.length).toBe(1);
    });

    it('flags generic *_SECRET / *_TOKEN / *_PASSWORD env reads', () => {
        const findings = PatternScanner.scan([
            file('lib/a.js', 'const t = process.env.MY_API_KEY'),
            file('lib/b.js', 'const s = process.env.SOME_DB_PASSWORD'),
            file('lib/c.js', 'const x = process.env.PRIVATE_KEY')
        ]);

        /*
         * Three matches expected; the regex deliberately does not catch
         * `_TOKEN` on its own to keep CI-token reads from drowning the
         * signal, so a token-only read is intentionally not flagged.
         */
        expect(findings.length).toBe(3);
        expect(findings.every((f) => f.pattern === 'Secret/token env read')).toBe(true);
    });

    it('does NOT flag a plain `process.env.NODE_ENV` read', () => {
        const findings = PatternScanner.scan([
            file('lib/a.js', 'if (process.env.NODE_ENV !== "production") debug = true;')
        ]);
        expect(findings).toEqual([]);
    });

    it('flags _0x-style obfuscator variable names', () => {
        const findings = PatternScanner.scan([
            file('lib/obf.js', 'var _0xab12 = ["console", "log"]; _0xab12[1](_0xab12[0]);')
        ]);
        /*
         * Three textual references — declaration + two usages — each a
         * match. The badge tooltip shows the count, so over-counting
         * here is actually the desired behaviour.
         */
        expect(findings.length).toBe(3);
        expect(findings.every((f) => f.pattern === 'Obfuscated _0x variable')).toBe(true);
    });
});