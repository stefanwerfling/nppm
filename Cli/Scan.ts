import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {SchemaConfig} from '../Config/Config.js';
import {ConfigLoader, LoadedConfig} from '../Config/ConfigLoader.js';
import {Lockfile} from '../Project/Lockfile.js';
import {Project} from '../Project/Project.js';
import {OsvBatchPackage, OsvClient} from '../Security/OsvClient.js';
import {SecurityScanner} from '../Security/SecurityScanner.js';
import {UnusedDetector} from '../Unused/UnusedDetector.js';
import {CliArgs, CliArgsError, CliArgsParser, HELP_TEXT} from './CliArgs.js';
import {ScanFormatter} from './ScanFormat.js';
import {ProjectScanReport, ScanReportBuilder} from './ScanReport.js';

/**
 * Inputs the runner expects from the surrounding shell. Kept as a
 * parameter (not pulled from `process` directly) so the unit tests can
 * call `runScan()` deterministically without leaking env state.
 *
 * `configOverride` is the test seam: when present, the runner uses it
 * verbatim instead of reading from disk — lets tests run the entire
 * `runScan()` pipeline without writing fixture files.
 */
export type RunScanIO = {
    argv: readonly string[];
    cwd: string;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    /** Optional in-memory override of the parsed nppm.json. */
    configOverride?: unknown;
    /** Optional environment override (e.g. for an OSV/Registry stub). */
    environmentOverride?: LoadedConfig;
};

/**
 * Headless scan entry point. Returns the intended process exit code so
 * the JS shim can `process.exit(code)` without sprinkling exits
 * through the runner itself (makes tests bearable).
 *
 * Exit codes:
 *  - 0: clean, or findings below `--fail-on`
 *  - 1: findings at or above `--fail-on`
 *  - 2: usage / config error
 */
export async function runScan(io: RunScanIO): Promise<number> {
    let args: CliArgs;
    try {
        args = CliArgsParser.parse(io.argv);
    } catch (e) {
        if (e instanceof CliArgsError) {
            io.stderr(`nppm scan: ${e.message}\n\n`);
            io.stderr(HELP_TEXT);
            return 2;
        }
        throw e;
    }

    if (args.help) {
        io.stdout(HELP_TEXT);
        return 0;
    }

    let loaded: LoadedConfig;
    if (io.environmentOverride) {
        loaded = io.environmentOverride;
    } else {
        const configPath = path.resolve(io.cwd, args.configPath);
        let rawConfig: unknown;
        if (io.configOverride !== undefined) {
            rawConfig = io.configOverride;
        } else {
            if (!fs.existsSync(configPath)) {
                io.stderr(`nppm scan: config file not found at ${configPath}\n`);
                return 2;
            }
            rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }

        const errors: SchemaErrors = [];
        if (!SchemaConfig.validate(rawConfig, errors)) {
            io.stderr(`nppm scan: ${configPath} has an invalid structure\n`);
            for (const err of errors) {
                io.stderr(`  ${JSON.stringify(err)}\n`);
            }
            return 2;
        }

        // Pick up a sibling .env so token references in `nppm.json`
        // resolve the same way the dev server resolves them. Only fire
        // this on the disk-backed path — the test seam stays env-clean.
        const projectRoot = path.dirname(configPath);
        const envPath = path.resolve(projectRoot, '.env');
        if (fs.existsSync(envPath)) {
            dotenv.config({quiet: true, path: envPath});
        }

        loaded = ConfigLoader.build(rawConfig, projectRoot, {
            onSkip: (msg) => io.stderr(`nppm scan: ${msg}\n`)
        });
    }

    // CLI override for the external-sources master switch. The
    // scanner's own per-source flags stay in the loaded config; only
    // the master gate flips so `--no-external` is a one-line opt-out
    // without rebuilding the scanner tree.
    if (!args.runExternal) {
        loaded.externalScanner.setEnabled(false);
    }

    let projects = loaded.projects;
    if (args.projects.length > 0) {
        const want = new Set(args.projects);
        projects = projects.filter((p) => want.has(p.getName()));
        if (projects.length === 0) {
            io.stderr(
                `nppm scan: no projects matched --project filter (${args.projects.join(', ')})\n`
                + `  configured: ${loaded.projects.map((p) => p.getName()).join(', ')}\n`
            );
            return 2;
        }
    }

    // `--sarif` and `--json` are machine outputs — keep stderr clean
    // so the consuming tool (GitHub Code Scanning ingest, jq pipeline)
    // gets a single deterministic stdout payload.
    const machine = args.json || args.sarif;
    if (!machine) {
        io.stderr(`nppm scan: ${projects.length} project(s)\n`);
    }

    const projectReports: ProjectScanReport[] = [];
    for (const project of projects) {
        if (!machine) {
            io.stderr(`  → ${project.getName()}\n`);
        }
        const report = await scanProject(
            project,
            args,
            loaded.osvClient,
            loaded.securityScanner,
            loaded.unusedDetector
        );
        projectReports.push(report);
    }

    const report = ScanReportBuilder.summarise(projectReports);

    if (args.sarif) {
        io.stdout(ScanFormatter.sarif(report));
    } else if (args.json) {
        io.stdout(ScanFormatter.json(report));
    } else {
        io.stdout(ScanFormatter.text(report, args.failOn));
    }

    return ScanFormatter.shouldFail(report, args.failOn) ? 1 : 0;
}

/**
 * Inner per-project pipeline. Pulled out of `runScan` so each project
 * sits in its own try/catch — one broken project shouldn't abort the
 * whole CI run.
 */
async function scanProject(
    project: Project,
    args: CliArgs,
    osvClient: OsvClient,
    securityScanner: SecurityScanner,
    unusedDetector: UnusedDetector
): Promise<ProjectScanReport> {
    const baseInput = {
        name: project.getName(),
        type: project.getType()
    };

    let lockfile: Lockfile|null = null;
    let lockfileError: string|null = null;
    try {
        lockfile = await project.loadLockfile();
    } catch (e) {
        lockfileError = `lockfile: ${(e as Error).message}`;
    }

    const lockPackages = lockfile?.packages ?? [];
    const dedup = new Map<string, OsvBatchPackage>();
    for (const p of lockPackages) {
        const key = `${p.name}@${p.version}`;
        if (!dedup.has(key)) {
            dedup.set(key, {name: p.name, version: p.version});
        }
    }
    const uniquePackages = Array.from(dedup.values());

    let vulnsByKey;
    if (args.runOsv && uniquePackages.length > 0) {
        try {
            vulnsByKey = await osvClient.queryBatch(uniquePackages);
        } catch (e) {
            lockfileError = (lockfileError ? lockfileError + '; ' : '') + `osv: ${(e as Error).message}`;
        }
    }

    let heuristics;
    if (args.runHeuristics && uniquePackages.length > 0) {
        try {
            heuristics = await securityScanner.scanHeuristicsBatch(uniquePackages, args.concurrency);
        } catch (e) {
            lockfileError = (lockfileError ? lockfileError + '; ' : '') + `heuristics: ${(e as Error).message}`;
        }
    }

    let unused;
    if (args.runUnused) {
        try {
            unused = await unusedDetector.scan(project);
        } catch (e) {
            lockfileError = (lockfileError ? lockfileError + '; ' : '') + `unused: ${(e as Error).message}`;
        }
    }

    return ScanReportBuilder.buildProject({
        ...baseInput,
        packagesScanned: uniquePackages.length,
        vulnsByKey,
        heuristics,
        unused,
        error: lockfileError
    });
}