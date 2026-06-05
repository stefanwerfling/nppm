import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {SchemaConfig} from '../backend/Config/Config.js';
import {ConfigLoader, LoadedConfig} from '../backend/Config/ConfigLoader.js';
import {Project} from '../backend/Project/Project.js';
import {CycloneDxBuilder} from '../backend/Sbom/CycloneDxBuilder.js';
import {SbomCollector} from '../backend/Sbom/SbomCollector.js';
import {SpdxBuilder} from '../backend/Sbom/SpdxBuilder.js';

/**
 * Output format the SBOM CLI emits. Mirrored on `--format` and the
 * REST endpoint's query parameter so the same vocabulary applies
 * everywhere.
 */
export enum SbomFormat {
    cyclonedx = 'cyclonedx',
    spdx = 'spdx'
}

/**
 * Parsed flags for `nppm sbom`. Kept narrow — the SBOM surface is
 * about identity + provenance, not behavior, so there's nothing like
 * `--fail-on` here.
 */
export type SbomCliArgs = {
    configPath: string;
    project: string|null;
    format: SbomFormat;
    output: string|null;
    help: boolean;
};

export class SbomCliArgsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SbomCliArgsError';
    }
}

/**
 * argv → SbomCliArgs parser. Mirrors `CliArgsParser` semantics so the
 * two CLIs feel identical to the user.
 */
export class SbomCliArgsParser {

    private static readonly _DEFAULTS: SbomCliArgs = {
        configPath: 'nppm.json',
        project: null,
        format: SbomFormat.cyclonedx,
        output: null,
        help: false
    };

    public static parse(argv: readonly string[]): SbomCliArgs {
        const out: SbomCliArgs = {...SbomCliArgsParser._DEFAULTS};

        for (let i = 0; i < argv.length; i++) {
            const raw = argv[i];
            if (raw === '-h' || raw === '--help') {
                out.help = true;
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
                throw new SbomCliArgsError(`Unexpected positional argument "${raw}"`);
            }

            if (value === undefined) {
                throw new SbomCliArgsError(`Missing value for ${key}`);
            }

            switch (key) {
                case '--config':
                    out.configPath = value;
                    break;
                case '--project':
                    out.project = value;
                    break;
                case '--format':
                    if (!Object.values(SbomFormat).includes(value as SbomFormat)) {
                        throw new SbomCliArgsError(
                            `Invalid --format value "${value}" — expected one of ${Object.values(SbomFormat).join(', ')}`
                        );
                    }
                    out.format = value as SbomFormat;
                    break;
                case '--output':
                    out.output = value;
                    break;
                default:
                    throw new SbomCliArgsError(`Unknown flag ${key}`);
            }
        }

        return out;
    }
}

export const SBOM_HELP_TEXT = `nppm sbom — Software Bill of Materials (CycloneDX / SPDX)

Usage:
  nppm sbom [options]

Options:
  --config=<path>       Path to nppm.json (default: ./nppm.json)
  --project=<name>      Project to emit. Required when more than one
                        project is configured.
  --format=<fmt>        cyclonedx (default) | spdx
  --output=<file>       Write the SBOM to <file>. If omitted, the
                        payload is written to stdout.
  -h, --help            Show this help and exit.

Exit codes:
  0  SBOM emitted
  2  CLI usage error (bad flag, missing config, no project resolved)
`;

export type SbomIO = {
    argv: readonly string[];
    cwd: string;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    /** Optional in-memory override of the parsed nppm.json — test seam. */
    configOverride?: unknown;
    /** Optional environment override — test seam (skips disk + .env). */
    environmentOverride?: LoadedConfig;
};

/**
 * Headless SBOM emitter. Returns the intended process exit code so
 * the JS shim can `process.exit(code)`.
 *
 * Exit codes:
 *  - 0: SBOM emitted (to stdout or `--output`)
 *  - 2: usage / config error (bad flag, missing config, ambiguous
 *       project selection)
 */
export class SbomRunner {

    public static async run(io: SbomIO): Promise<number> {
        let args: SbomCliArgs;
        try {
            args = SbomCliArgsParser.parse(io.argv);
        } catch (e) {
            if (e instanceof SbomCliArgsError) {
                io.stderr(`nppm sbom: ${e.message}\n\n`);
                io.stderr(SBOM_HELP_TEXT);
                return 2;
            }
            throw e;
        }

        if (args.help) {
            io.stdout(SBOM_HELP_TEXT);
            return 0;
        }

        const loaded = SbomRunner._loadEnvironment(io, args);
        if (typeof loaded === 'number') {
            return loaded;
        }

        const target = SbomRunner._pickProject(io, loaded, args);
        if (!target) {
            return 2;
        }

        try {
            const collector = new SbomCollector(loaded.registry);
            const data = await collector.collect(target);
            const payload = args.format === SbomFormat.cyclonedx
                ? CycloneDxBuilder.build(data, '1')
                : SpdxBuilder.build(data, '1');
            const text = JSON.stringify(payload, null, 2) + '\n';

            if (args.output) {
                fs.writeFileSync(path.resolve(io.cwd, args.output), text);
                io.stderr(`nppm sbom: wrote ${args.output}\n`);
            } else {
                io.stdout(text);
            }
            return 0;
        } catch (e) {
            io.stderr(`nppm sbom: ${(e as Error).message}\n`);
            return 2;
        }
    }

    private static _loadEnvironment(io: SbomIO, args: SbomCliArgs): LoadedConfig|number {
        if (io.environmentOverride) {
            return io.environmentOverride;
        }
        const configPath = path.resolve(io.cwd, args.configPath);
        let rawConfig: unknown;
        if (io.configOverride !== undefined) {
            rawConfig = io.configOverride;
        } else {
            if (!fs.existsSync(configPath)) {
                io.stderr(`nppm sbom: config file not found at ${configPath}\n`);
                return 2;
            }
            rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }

        const errors: SchemaErrors = [];
        if (!SchemaConfig.validate(rawConfig, errors)) {
            io.stderr(`nppm sbom: ${configPath} has an invalid structure\n`);
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

        return ConfigLoader.build(rawConfig, projectRoot, {
            onSkip: (msg) => io.stderr(`nppm sbom: ${msg}\n`)
        });
    }

    private static _pickProject(io: SbomIO, loaded: LoadedConfig, args: SbomCliArgs): Project|null {
        if (args.project) {
            const match = loaded.projects.find((p) => p.getName() === args.project);
            if (!match) {
                io.stderr(
                    `nppm sbom: --project=${args.project} not found\n`
                    + `  configured: ${loaded.projects.map((p) => p.getName()).join(', ') || '(none)'}\n`
                );
                return null;
            }
            return match;
        }
        if (loaded.projects.length === 0) {
            io.stderr('nppm sbom: no projects configured\n');
            return null;
        }
        if (loaded.projects.length > 1) {
            io.stderr(
                'nppm sbom: more than one project configured — pass --project=<name>\n'
                + `  configured: ${loaded.projects.map((p) => p.getName()).join(', ')}\n`
            );
            return null;
        }
        return loaded.projects[0];
    }
}