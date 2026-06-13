import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {SchemaConfig} from '../backend/Config/Config.js';
import {ConfigLoader, LoadedConfig} from '../backend/Config/ConfigLoader.js';
import {ProjectScanReport, ScanReportBuilder} from './ScanReport.js';
import {ScanRunner} from './Scan.js';
import {CliArgs, CliArgsError, FailOnLevel} from './CliArgs.js';
import {SvgCardBuilder} from './CardSvg.js';

/**
 * Inputs the card runner expects from the surrounding shell. Same
 * shape as `RunScanIO` so a test can drive the whole pipeline
 * without touching the filesystem. `configOverride` /
 * `environmentOverride` mirror the scan runner's test seams.
 */
export type RunCardIO = {
    argv: readonly string[];
    cwd: string;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    configOverride?: unknown;
    environmentOverride?: LoadedConfig;
};

/**
 * Parsed flags for the card subcommand. Mostly a subset of
 * `CliArgs` plus `--output` / `--stdout` / `--title`. Keeping it as
 * its own shape avoids polluting `CliArgs` with concerns that don't
 * apply to the scan subcommand.
 */
export type CardArgs = {
    configPath: string;
    projects: string[];
    output: string;
    /** When true, emit the SVG to stdout instead of writing to disk. */
    toStdout: boolean;
    /** Repo/project label baked into the card header. */
    title: string|null;
    runOsv: boolean;
    runHeuristics: boolean;
    runUnused: boolean;
    runExternal: boolean;
    concurrency: number;
    help: boolean;
};

export const CARD_HELP_TEXT = `nppm card — render an SVG health badge from a scan

Usage:
  nppm card [options]

Options:
  --config=<path>       Path to nppm.json (default: ./nppm.json)
  --project=<name>      Only scan the named project. Repeatable.
  --output=<path>, -o   Write SVG here (default: ./nppm-card.svg)
  --stdout              Emit SVG to stdout instead of writing a file.
  --title=<label>       Header label baked into the card. Defaults to
                        the basename of the working directory.
  --no-osv              Skip OSV.dev CVE lookups.
  --no-heuristics       Skip scripts/patterns/binaries/etc heuristics.
  --no-unused           Skip the unused-deps detector.
  --no-external         Skip the external-sources scanner.
  --concurrency=<n>     Parallelism for tarball downloads (default: 10).
  -h, --help            Show this help and exit.

Exit codes:
  0  card written
  2  CLI usage error (bad flag, missing config, …)
`;

/**
 * Headless card-render entry point. Wraps `ScanRunner.scanProject`
 * per project so it reuses the exact same severity bookkeeping as
 * `nppm scan`, then collapses the report into an SVG via
 * `SvgCardBuilder`.
 */
export class CardRunner {

    public static async run(io: RunCardIO): Promise<number> {
        let args: CardArgs;
        try {
            args = CardRunner._parse(io.argv);
        } catch (e) {
            if (e instanceof CliArgsError) {
                io.stderr(`nppm card: ${e.message}\n\n`);
                io.stderr(CARD_HELP_TEXT);
                return 2;
            }
            throw e;
        }

        if (args.help) {
            io.stdout(CARD_HELP_TEXT);
            return 0;
        }

        let loaded: LoadedConfig;
        if (io.environmentOverride) {
            loaded = io.environmentOverride;
        } else {
            const configPath = path.resolve(io.cwd, args.configPath);
            let rawConfig: unknown;
            if (io.configOverride === undefined) {
                if (!fs.existsSync(configPath)) {
                    io.stderr(`nppm card: config file not found at ${configPath}\n`);
                    return 2;
                }
                rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } else {
                rawConfig = io.configOverride;
            }

            const errors: SchemaErrors = [];
            if (!SchemaConfig.validate(rawConfig, errors)) {
                io.stderr(`nppm card: ${configPath} has an invalid structure\n`);
                for (const err of errors) {
                    io.stderr(`  ${JSON.stringify(err)}\n`);
                }
                return 2;
            }

            const projectRoot = path.dirname(configPath);
            const envPath = path.resolve(projectRoot, '.env');
            if (fs.existsSync(envPath)) {
                dotenv.config({quiet: true, path: envPath});
            }

            loaded = ConfigLoader.build(rawConfig, projectRoot, {
                onSkip: (msg): void => io.stderr(`nppm card: ${msg}\n`)
            });
        }

        if (!args.runExternal) {
            loaded.externalScanner.setEnabled(false);
        }

        let projects = loaded.projects;
        if (args.projects.length > 0) {
            const want = new Set(args.projects);
            projects = projects.filter((p): boolean => want.has(p.getName()));
            if (projects.length === 0) {
                io.stderr(
                    `nppm card: no projects matched --project filter (${args.projects.join(', ')})\n`
                    + `  configured: ${loaded.projects.map((p): string => p.getName()).join(', ')}\n`
                );
                return 2;
            }
        }

        if (!args.toStdout) {
            io.stderr(`nppm card: ${projects.length} project(s)\n`);
        }

        /*
         * The scan-side runner's per-project pipeline is exposed as
         * `ScanRunner.scanProject` — same severity rollup as
         * `nppm scan`, no formatter coupling.
         */
        const scanArgsView: CliArgs = {
            configPath: args.configPath,
            projects: args.projects,
            json: false,
            sarif: false,
            failOn: FailOnLevel.none,
            runOsv: args.runOsv,
            runHeuristics: args.runHeuristics,
            runUnused: args.runUnused,
            runExternal: args.runExternal,
            concurrency: args.concurrency,
            help: false
        };

        const projectReports: ProjectScanReport[] = [];
        for (const project of projects) {
            if (!args.toStdout) {
                io.stderr(`  → ${project.getName()}\n`);
            }
            // eslint-disable-next-line no-await-in-loop
            const report = await ScanRunner.scanProject(
                project,
                scanArgsView,
                loaded.osvClient,
                loaded.securityScanner,
                loaded.unusedDetector
            );
            projectReports.push(report);
        }

        const report = ScanReportBuilder.summarise(projectReports);
        const title = args.title ?? CardRunner._defaultTitle(io.cwd);
        const svg = SvgCardBuilder.build(report, {title: title});

        if (args.toStdout) {
            io.stdout(svg);
        } else {
            const outPath = path.resolve(io.cwd, args.output);
            fs.writeFileSync(outPath, svg, 'utf-8');
            io.stderr(`nppm card: wrote ${outPath} (grade ${SvgCardBuilder.gradeOf(report)})\n`);
        }

        return 0;
    }

    /**
     * Strip the cwd to a readable repo label. The user can override
     * with `--title`; this only fires when they don't.
     */
    private static _defaultTitle(cwd: string): string {
        const base = path.basename(path.resolve(cwd));
        return base.length > 0 ? base : 'nppm';
    }

    private static readonly _DEFAULTS: CardArgs = {
        configPath: 'nppm.json',
        projects: [],
        output: 'nppm-card.svg',
        toStdout: false,
        title: null,
        runOsv: true,
        runHeuristics: true,
        runUnused: true,
        runExternal: true,
        concurrency: 10,
        help: false
    };

    /**
     * Pure argv → CardArgs parser. Same `--key=value` / `--key value`
     * style as `CliArgsParser` for consistency, with an extra `-o`
     * short alias because that's the convention every other CLI tool
     * uses for "output file".
     */
    public static _parse(argv: readonly string[]): CardArgs {
        const out: CardArgs = {...CardRunner._DEFAULTS, projects: []};

        for (let i = 0; i < argv.length; i++) {
            const raw = argv[i];

            if (raw === '-h' || raw === '--help') {
                out.help = true;
                continue;
            }
            if (raw === '--stdout') {
                out.toStdout = true;
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

            // Short alias for --output. Always takes the next argv slot.
            if (raw === '-o') {
                const value = argv[i + 1];
                if (value === undefined) {
                    throw new CliArgsError('Missing value for -o');
                }
                out.output = value;
                i++;
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
                case '--output':
                    out.output = value;
                    break;
                case '--title':
                    out.title = value;
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

        return out;
    }

}