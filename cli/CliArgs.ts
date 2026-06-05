/**
 * Severity threshold the `--fail-on` flag accepts. Mirrors the
 * three-level info/warn/risk ladder every scanner uses. `none` short-
 * circuits the exit-code logic (always 0) so the CLI doubles as a
 * pure-reporting tool in pipelines where the developer only wants the
 * findings logged.
 */
export enum FailOnLevel {
    none = 'none',
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

/**
 * Rank ladder for severity comparison. Higher = worse. `none` keeps
 * its sentinel of `0` so `findingRank ≥ FAIL_RANK[failOn]` only fires
 * for the explicitly-named thresholds.
 */
export const FAIL_RANK: Record<FailOnLevel, number> = {
    [FailOnLevel.none]: 0,
    [FailOnLevel.info]: 1,
    [FailOnLevel.warn]: 2,
    [FailOnLevel.risk]: 3
};

/**
 * Parsed CLI flags. `projects` is empty = scan every configured
 * project; otherwise filter to matching names. Boolean toggles are
 * opt-out (default true) so `nppm scan` does the most thorough
 * possible run out of the box.
 */
export type CliArgs = {
    configPath: string;
    projects: string[];
    json: boolean;
    sarif: boolean;
    failOn: FailOnLevel;
    runOsv: boolean;
    runHeuristics: boolean;
    runUnused: boolean;
    runExternal: boolean;
    concurrency: number;
    help: boolean;
};

/**
 * Thrown by `CliArgsParser.parse` when an argument doesn't conform —
 * e.g. `--fail-on=foo` or `--concurrency=abc`. The CLI shim catches
 * these and prints the message + usage to stderr.
 */
export class CliArgsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliArgsError';
    }
}

/**
 * Pure argv → CliArgs parser. Accepts both `--key=value` and `--key
 * value` forms. Keeps a strict whitelist of known flags so a typo
 * fails loudly instead of being silently ignored.
 */
export class CliArgsParser {

    private static readonly _DEFAULTS: CliArgs = {
        configPath: 'nppm.json',
        projects: [],
        json: false,
        sarif: false,
        failOn: FailOnLevel.risk,
        runOsv: true,
        runHeuristics: true,
        runUnused: true,
        runExternal: true,
        concurrency: 10,
        help: false
    };

    public static parse(argv: readonly string[]): CliArgs {
        const out: CliArgs = {...CliArgsParser._DEFAULTS, projects: []};

        for (let i = 0; i < argv.length; i++) {
            const raw = argv[i];

            if (raw === '-h' || raw === '--help') {
                out.help = true;
                continue;
            }
            if (raw === '--json') {
                out.json = true;
                continue;
            }
            if (raw === '--sarif') {
                out.sarif = true;
                continue;
            }
            if (raw === '--no-osv') {
                out.runOsv = false;
                continue;
            }
            if (raw === '--no-heuristics') {
                out.runHeuristics = false;
                continue;
            }
            if (raw === '--no-unused') {
                out.runUnused = false;
                continue;
            }
            if (raw === '--no-external') {
                out.runExternal = false;
                continue;
            }

            const eq = raw.indexOf('=');
            let key = raw;
            let value: string|undefined;
            if (raw.startsWith('--') && eq > 0) {
                key = raw.slice(0, eq);
                value = raw.slice(eq + 1);
            } else if (raw.startsWith('--')) {
                value = argv[i + 1];
                i++;
            } else {
                throw new CliArgsError(`Unexpected positional argument "${raw}"`);
            }

            if (value === undefined) {
                throw new CliArgsError(`Missing value for ${key}`);
            }

            switch (key) {
                case '--config':
                    out.configPath = value;
                    break;
                case '--project':
                    out.projects.push(value);
                    break;
                case '--fail-on':
                    if (!Object.values(FailOnLevel).includes(value as FailOnLevel)) {
                        throw new CliArgsError(
                            `Invalid --fail-on value "${value}" — expected one of ${Object.values(FailOnLevel).join(', ')}`
                        );
                    }
                    out.failOn = value as FailOnLevel;
                    break;
                case '--concurrency': {
                    const n = Number(value);
                    if (!Number.isInteger(n) || n < 1) {
                        throw new CliArgsError(`--concurrency must be a positive integer, got "${value}"`);
                    }
                    out.concurrency = n;
                    break;
                }
                default:
                    throw new CliArgsError(`Unknown flag ${key}`);
            }
        }

        if (out.json && out.sarif) {
            throw new CliArgsError('--json and --sarif are mutually exclusive');
        }

        return out;
    }
}

/**
 * Usage line shown for `--help` and on `CliArgsError`. Kept as a
 * plain template so future flags need one edit, not three.
 */
export const HELP_TEXT = `nppm scan — depcheck-style + CVE + supply-chain hygiene check for CI

Usage:
  nppm scan [options]

Options:
  --config=<path>       Path to nppm.json (default: ./nppm.json)
  --project=<name>      Only scan the named project. Repeatable.
                        Without this flag, every configured project is scanned.
  --json                Emit machine-readable JSON to stdout instead of
                        the human report. Stderr stays human-readable.
  --sarif               Emit SARIF 2.1.0 to stdout (GitHub Code Scanning
                        compatible). Mutually exclusive with --json;
                        --sarif wins if both are passed.
  --fail-on=<level>     Exit non-zero if any finding has severity ≥ level.
                        Levels: info, warn, risk, none. Default: risk.
  --no-osv              Skip OSV.dev CVE lookups (lockfile only).
  --no-heuristics       Skip scripts/patterns/binaries/maintainer/license
                        heuristics — those require fingerprint downloads.
  --no-unused           Skip the unused-deps detector.
  --no-external         Skip the external-sources scanner (socket.dev,
                        OpenSSF Scorecard, deps.dev).
  --concurrency=<n>     Parallelism for tarball fingerprint downloads
                        (default: 10).
  -h, --help            Show this help and exit.

Exit codes:
  0  no findings ≥ --fail-on (or --fail-on=none)
  1  one or more findings reached the threshold
  2  CLI usage error (bad flag, missing config, …)
`;