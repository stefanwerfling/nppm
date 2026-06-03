import fs from 'fs';
import path from 'path';
import {SchemaErrors} from 'vts';
import {SchemaConfig} from '../Config/Config.js';
import {ConfigLoader, LoadedConfig} from '../Config/ConfigLoader.js';
import {ProjectLocal} from '../Project/ProjectLocal.js';
import {PrReviewBuilder} from '../PrReview/PrReviewBuilder.js';
import {PrReviewReport} from '../PrReview/PrReview.js';
import {ActionFormatter} from './ActionFormat.js';
import {GithubClient} from './GithubClient.js';
import {runScan} from './Scan.js';

/**
 * Inputs the action runner expects from the surrounding shell. Same
 * shape as `RunScanIO` so a test can drive the whole pipeline without
 * touching `process.env`. Defaults match the GitHub Actions
 * `INPUT_*` env-var convention.
 */
export type RunActionIO = {
    /** Read-only copy of `process.env`, indexed by `INPUT_*` and `GITHUB_*`. */
    env: NodeJS.ProcessEnv;
    /** Working directory for the scan — usually the consumer's repo root. */
    cwd: string;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    /** Test seam — `globalThis.fetch` by default. */
    fetch?: typeof fetch;
    /** Test seam — replaces `runScan` so the runner can be tested without spawning a real OSV client. */
    runScanOverride?: typeof runScan;
};

/**
 * Headless GitHub-Actions entry point. The composite action in
 * `.github/actions/scan/action.yml` does `node cli/nppm.js action`
 * and we read every option from `INPUT_<NAME>` env vars (GitHub
 * Actions' canonical convention — saves us pulling in `@actions/core`
 * for what is otherwise a 5-line decoder).
 *
 * Two phases:
 *   1. Run `nppm scan --sarif` so Code-Scanning can ingest findings.
 *   2. When the run is triggered by `pull_request`, build a
 *      `PrReviewReport` for every configured project and upsert a
 *      sticky markdown comment via the GitHub Issues API.
 *
 * Returns an exit code; the caller is expected to forward it.
 */
export async function runAction(io: RunActionIO): Promise<number> {
    const inputs = readInputs(io.env);
    const runScanFn = io.runScanOverride ?? runScan;

    const scanArgv: string[] = ['--sarif', `--fail-on=${inputs.failOn}`];
    if (inputs.configPath) {
        scanArgv.push(`--config=${inputs.configPath}`);
    }

    // Capture the SARIF output so we can both write it to disk AND
    // bubble it back to the workflow via `$GITHUB_OUTPUT`. The scan's
    // own stdout would only deliver one of the two paths.
    const sarifChunks: string[] = [];
    const scanExit = await runScanFn({
        argv: scanArgv,
        cwd: io.cwd,
        stdout: (s) => sarifChunks.push(s),
        stderr: (s) => io.stderr(s)
    });

    const sarifBody = sarifChunks.join('');
    const sarifPath = path.resolve(io.cwd, inputs.sarifOutput);
    try {
        fs.mkdirSync(path.dirname(sarifPath), {recursive: true});
        fs.writeFileSync(sarifPath, sarifBody, 'utf-8');
        io.stderr(`nppm action: SARIF written to ${sarifPath}\n`);
    } catch (e) {
        io.stderr(`nppm action: could not write SARIF to ${sarifPath} — ${(e as Error).message}\n`);
    }

    // PR-comment phase. Only fires when the workflow was triggered
    // by a pull_request event AND the user hasn't opted out AND we
    // have a token. Any other failure mode degrades gracefully —
    // a missing token is a *common* setup mistake, not a hard error.
    if (inputs.prComment) {
        const prContext = readPrContext(io.env);
        if (prContext && inputs.githubToken) {
            try {
                await postPrComment(io, prContext, inputs);
            } catch (e) {
                io.stderr(`nppm action: PR comment failed — ${(e as Error).message}\n`);
            }
        } else if (prContext && !inputs.githubToken) {
            io.stderr('nppm action: PR comment skipped — INPUT_GITHUB_TOKEN missing.\n');
        }
    }

    writeOutputs(io.env, {
        'sarif-path': sarifPath,
        'scan-exit-code': String(scanExit)
    });

    return scanExit;
}

type ActionInputs = {
    configPath: string|undefined;
    failOn: string;
    sarifOutput: string;
    prComment: boolean;
    prBase: string|undefined;
    prHead: string|undefined;
    githubToken: string|undefined;
};

/**
 * GitHub Actions exposes inputs as `INPUT_<KEY>` env vars (kebab-
 * case keys are upper-snake-case here). Defaults match the action.yml
 * declaration. Public for unit tests.
 */
export function readInputs(env: NodeJS.ProcessEnv): ActionInputs {
    const get = (k: string): string|undefined => {
        const v = env[`INPUT_${k}`];
        return v && v.length > 0 ? v : undefined;
    };
    return {
        configPath: get('CONFIG_PATH'),
        failOn: get('FAIL_ON') ?? 'risk',
        sarifOutput: get('SARIF_OUTPUT') ?? 'nppm.sarif',
        prComment: (get('PR_COMMENT') ?? 'true') !== 'false',
        prBase: get('PR_BASE'),
        prHead: get('PR_HEAD'),
        githubToken: get('GITHUB_TOKEN')
    };
}

type PrContext = {
    repo: string;       // owner/repo
    number: number;
    baseRef: string;
    headSha: string;
};

/**
 * Pull the PR coordinates from the GitHub Actions runtime — the
 * canonical place is `$GITHUB_EVENT_PATH` (a JSON file). Returns
 * `null` when the event isn't a pull request (push / schedule / …).
 */
export function readPrContext(env: NodeJS.ProcessEnv): PrContext|null {
    if (env.GITHUB_EVENT_NAME !== 'pull_request' && env.GITHUB_EVENT_NAME !== 'pull_request_target') {
        return null;
    }
    const evtPath = env.GITHUB_EVENT_PATH;
    if (!evtPath || !fs.existsSync(evtPath)) {
        return null;
    }
    let evt: unknown;
    try {
        evt = JSON.parse(fs.readFileSync(evtPath, 'utf-8'));
    } catch {
        return null;
    }
    if (!evt || typeof evt !== 'object') {
        return null;
    }
    const e = evt as Record<string, unknown>;
    const pr = e.pull_request as Record<string, unknown>|undefined;
    const repository = e.repository as Record<string, unknown>|undefined;
    if (!pr || typeof pr.number !== 'number') {
        return null;
    }
    const base = pr.base as Record<string, unknown>|undefined;
    const head = pr.head as Record<string, unknown>|undefined;
    const fullName = repository && typeof repository.full_name === 'string'
        ? repository.full_name as string
        : env.GITHUB_REPOSITORY ?? '';
    if (!fullName) {
        return null;
    }
    return {
        repo: fullName,
        number: pr.number,
        baseRef: typeof base?.ref === 'string' ? base.ref as string : 'main',
        headSha: typeof head?.sha === 'string' ? head.sha as string : env.GITHUB_SHA ?? 'HEAD'
    };
}

/**
 * Build a PR review for every configured local project and post / patch
 * the sticky comment. Remote (GitHub/Gitea) projects are skipped — the
 * existing `PrReviewBuilder` only supports local git refs in v1.
 */
async function postPrComment(
    io: RunActionIO,
    pr: PrContext,
    inputs: ActionInputs
): Promise<void> {
    const loaded = loadConfig(io, inputs.configPath);
    if (!loaded) {
        return;
    }

    const builder = new PrReviewBuilder(loaded.osvClient);
    const reports: PrReviewReport[] = [];
    const base = inputs.prBase ?? pr.baseRef;
    const head = inputs.prHead ?? pr.headSha;

    for (const project of loaded.projects) {
        if (!(project instanceof ProjectLocal)) {
            continue;
        }
        const root = project.getRoot();
        if (!builder.isAvailable(root)) {
            continue;
        }
        try {
            const report = await builder.build(root, base, head, {
                // The unid lives on the dev server's project map; the
                // CLI doesn't carry one. The PrReviewReport surfaces
                // it informationally only — the comment formatter
                // never reads it — so a stable synthetic id is fine.
                unid: project.getName(),
                name: project.getName(),
                type: project.getType()
            });
            reports.push(report);
        } catch (e) {
            io.stderr(`nppm action: PR review for ${project.getName()} failed — ${(e as Error).message}\n`);
        }
    }

    if (reports.length === 0) {
        io.stderr('nppm action: no local projects with a git repo — skipping comment.\n');
        return;
    }

    const body = ActionFormatter.commentBody(reports, pr.repo, pr.headSha);
    const client = new GithubClient({
        token: inputs.githubToken as string,
        repo: pr.repo,
        fetch: io.fetch
    });
    const id = await client.upsertStickyComment(pr.number, body);
    if (id !== null) {
        io.stderr(`nppm action: PR comment upserted (id=${id}).\n`);
    } else {
        io.stderr('nppm action: PR comment upsert failed (token / permissions?).\n');
    }
}

/**
 * Mirror of `runScan`'s config loader — we re-read because the
 * scanner exits at the end and we need a fresh `OsvClient` instance
 * keyed against the same `.nppm-cache/`. Returns `null` and logs
 * when the config is missing or malformed.
 */
function loadConfig(io: RunActionIO, configPath: string|undefined): LoadedConfig|null {
    const resolved = path.resolve(io.cwd, configPath ?? 'nppm.json');
    if (!fs.existsSync(resolved)) {
        io.stderr(`nppm action: config not found at ${resolved} — PR comment skipped.\n`);
        return null;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    } catch (e) {
        io.stderr(`nppm action: config parse failed — ${(e as Error).message}\n`);
        return null;
    }
    const errors: SchemaErrors = [];
    if (!SchemaConfig.validate(raw, errors)) {
        io.stderr(`nppm action: invalid config — ${JSON.stringify(errors)}\n`);
        return null;
    }
    try {
        return ConfigLoader.build(raw, path.dirname(resolved));
    } catch (e) {
        io.stderr(`nppm action: config loader failed — ${(e as Error).message}\n`);
        return null;
    }
}

/**
 * Append `key=value` lines to `$GITHUB_OUTPUT` (the file-based
 * outputs protocol GitHub Actions uses since 2022). Silently skipped
 * when the env var is absent — useful so running this locally
 * doesn't fail because there's nothing to write to.
 */
function writeOutputs(env: NodeJS.ProcessEnv, kv: Record<string, string>): void {
    const target = env.GITHUB_OUTPUT;
    if (!target) {
        return;
    }
    const lines: string[] = [];
    for (const [k, v] of Object.entries(kv)) {
        // GitHub's heredoc protocol covers multi-line values cleanly.
        // We use a unique delimiter per value so the runner parser
        // can't confuse a value-tail for a new key.
        const delim = `__nppm_${k}_${Math.random().toString(36).slice(2, 10)}`;
        lines.push(`${k}<<${delim}`);
        lines.push(v);
        lines.push(delim);
    }
    try {
        fs.appendFileSync(target, lines.join('\n') + '\n', 'utf-8');
    } catch {
        // Best-effort — outputs are advisory.
    }
}