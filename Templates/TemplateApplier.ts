import fs from 'fs';
import path from 'path';
import {PackageManifest} from '../Project/PackageManifest.js';
import {BackupStore} from '../Upgrade/BackupStore.js';
import {ResolvedTemplate, ResolvedTemplateFile, ResolvedTemplateWorkspace, TemplateRoot} from './Template.js';

/**
 * Per-target outcome of an apply step. `status: 'applied'` writes a
 * line to the SSE log; `'skipped'` carries a `msg` explaining why
 * (`mode=create + drift` → manual reconcile needed, etc).
 */
export type TemplateApplyOutcome = {
    target: string;
    status: 'applied'|'skipped'|'error';
    msg?: string;
};

export type TemplateApplyResult = {
    backup: {dir: string; files: string[]}|null;
    outcomes: TemplateApplyOutcome[];
};

/**
 * Effective action plan derived from a target string. The applier
 * routes by `kind` and then mutates the right file. `workspace`
 * disambiguates between root-level and per-workspace targets.
 */
type ParsedTarget =
    | {kind: 'package'; bucket: 'runtime'|'dev'|'peer'|'optional'; name: string; workspace?: string}
    | {kind: 'forbidden'; name: string; workspace?: string}
    | {kind: 'extra'; name: string; workspace?: string}
    | {kind: 'root'; key: string; workspace?: string}
    | {kind: 'file'; path: string; workspace?: string}
    | {kind: 'workspace-missing'; workspace: string}
    | {kind: 'unknown'};

const BUCKET_FIELD: Record<'runtime'|'dev'|'peer'|'optional', string> = {
    runtime: 'dependencies',
    dev: 'devDependencies',
    peer: 'peerDependencies',
    optional: 'optionalDependencies'
};

/**
 * Apply selected compliance findings against the on-disk project.
 * One pass per affected file (so multiple finding targets touching
 * the same `package.json` round-trip once), then a separate pass
 * for file ships. Snapshots every file we touch via `BackupStore`
 * before writing.
 *
 * Phase-2 scope:
 *  - packages: add, update, remove, move-bucket
 *  - root metadata: set engines/scripts/private/type/packageManager
 *  - files: `create` mode copies template → project; `merge-json`
 *    deep-merges JSON; `report-only` is never applied even when
 *    selected (defensive — should already be unselected in the UI).
 *  - workspace-missing is never auto-applied (creating empty
 *    workspace dirs is out of scope; user creates the workspace
 *    manually first, then runs apply again).
 */
export class TemplateApplier {

    public apply(opts: {
        projectRoot: string;
        manifests: PackageManifest[];
        template: ResolvedTemplate;
        selectedTargets: string[];
        backupStore: BackupStore;
        onProgress?: (i: number, total: number, outcome: TemplateApplyOutcome) => void;
    }): TemplateApplyResult {
        const parsedTargets = opts.selectedTargets.map(TemplateApplier._parseTarget);

        // Bucket the targets per affected file so we can read + mutate
        // + write each file exactly once.
        const fileGroups = new Map<string, ParsedTarget[]>();
        const fileShipTargets: ParsedTarget[] = [];
        const skips: TemplateApplyOutcome[] = [];

        for (let i = 0; i < parsedTargets.length; i++) {
            const t = parsedTargets[i];
            const original = opts.selectedTargets[i];
            if (t.kind === 'unknown') {
                skips.push({target: original, status: 'skipped', msg: 'unknown target shape'});
                continue;
            }
            if (t.kind === 'workspace-missing') {
                skips.push({target: original, status: 'skipped', msg: 'create the workspace directory manually first'});
                continue;
            }
            if (t.kind === 'file') {
                fileShipTargets.push({...t});
                continue;
            }
            const pkgJson = TemplateApplier._packageJsonFor(t.workspace, opts.projectRoot);
            const arr = fileGroups.get(pkgJson) ?? [];
            arr.push({...t});
            fileGroups.set(pkgJson, arr);
        }

        // Collect every file we'll write to so the backup is complete
        // before the first mutation.
        const filesToBackup = new Set<string>();
        for (const f of fileGroups.keys()) {
            if (fs.existsSync(f)) {
                filesToBackup.add(f);
            }
        }
        for (const t of fileShipTargets) {
            if (t.kind !== 'file') {
                continue;
            }
            const abs = TemplateApplier._fileAbs(opts.projectRoot, t.workspace, t.path);
            if (fs.existsSync(abs)) {
                filesToBackup.add(abs);
            }
        }
        const backupStamp = filesToBackup.size > 0
            ? opts.backupStore.save(opts.projectRoot, [...filesToBackup])
            : null;

        const outcomes: TemplateApplyOutcome[] = [];
        let counter = 0;
        const total = opts.selectedTargets.length;

        // Pass 1: package.json mutations grouped per file.
        for (const [absFile, targets] of fileGroups.entries()) {
            const ws = targets[0].kind === 'unknown' ? undefined : targets[0].workspace;
            const source = fs.existsSync(absFile) ? fs.readFileSync(absFile, 'utf-8') : '{}\n';
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(source) as Record<string, unknown>;
            } catch (e) {
                for (const t of targets) {
                    const tgt = TemplateApplier._reencodeTarget(t);
                    const o: TemplateApplyOutcome = {target: tgt, status: 'error', msg: `invalid JSON in ${absFile}: ${(e as Error).message}`};
                    outcomes.push(o);
                    counter++;
                    opts.onProgress?.(counter, total, o);
                }
                continue;
            }
            const wsContract = ws !== undefined
                ? opts.template.workspaces.find((w) => w.path === ws)
                : null;

            for (const t of targets) {
                const tgt = TemplateApplier._reencodeTarget(t);
                let outcome: TemplateApplyOutcome;
                try {
                    outcome = TemplateApplier._applyOneToParsed(t, parsed, opts.template, wsContract);
                    outcome.target = tgt;
                } catch (e) {
                    outcome = {target: tgt, status: 'error', msg: (e as Error).message};
                }
                outcomes.push(outcome);
                counter++;
                opts.onProgress?.(counter, total, outcome);
            }

            // Write back the mutated JSON, preserving indent + trailing
            // newline like PackageJsonEditor does.
            const indent = TemplateApplier._detectIndent(source);
            const trailing = source.endsWith('\n') ? '\n' : '';
            const after = JSON.stringify(parsed, null, indent) + trailing;
            fs.mkdirSync(path.dirname(absFile), {recursive: true});
            fs.writeFileSync(absFile, after);
        }

        // Pass 2: file ships (create / merge-json).
        for (const t of fileShipTargets) {
            if (t.kind !== 'file') {
                continue;
            }
            const tgt = TemplateApplier._reencodeTarget(t);
            let outcome: TemplateApplyOutcome;
            try {
                outcome = TemplateApplier._applyFileShip(t, opts.projectRoot, opts.template);
                outcome.target = tgt;
            } catch (e) {
                outcome = {target: tgt, status: 'error', msg: (e as Error).message};
            }
            outcomes.push(outcome);
            counter++;
            opts.onProgress?.(counter, total, outcome);
        }

        for (const s of skips) {
            outcomes.push(s);
            counter++;
            opts.onProgress?.(counter, total, s);
        }

        return {
            backup: backupStamp ? {dir: backupStamp.dir, files: backupStamp.files} : null,
            outcomes
        };
    }

    /**
     * Apply a single package / root-meta target by mutating the
     * already-parsed package.json object in place. File-system writes
     * happen once per file group after every target in that group
     * has run.
     */
    private static _applyOneToParsed(
        t: ParsedTarget,
        parsed: Record<string, unknown>,
        template: ResolvedTemplate,
        wsContract: ResolvedTemplateWorkspace|null|undefined
    ): TemplateApplyOutcome {
        if (t.kind === 'package') {
            const req = wsContract
                ? wsContract.packages[t.bucket][t.name]
                : template.packages[t.bucket][t.name];
            if (!req) {
                return {target: '', status: 'skipped', msg: 'requirement no longer in template'};
            }
            const expectedVersion = req.version ?? '*';
            // Remove from any other bucket first (handles bucket-wrong).
            for (const otherBucket of ['runtime', 'dev', 'peer', 'optional'] as const) {
                if (otherBucket === t.bucket) {
                    continue;
                }
                TemplateApplier._removeFromBucket(parsed, BUCKET_FIELD[otherBucket], t.name);
            }
            TemplateApplier._setInBucket(parsed, BUCKET_FIELD[t.bucket], t.name, expectedVersion);
            return {target: '', status: 'applied'};
        }
        if (t.kind === 'forbidden' || t.kind === 'extra') {
            let removed = false;
            for (const bucket of ['runtime', 'dev', 'peer', 'optional'] as const) {
                if (TemplateApplier._removeFromBucket(parsed, BUCKET_FIELD[bucket], t.name)) {
                    removed = true;
                }
            }
            return {target: '', status: removed ? 'applied' : 'skipped', msg: removed ? undefined : 'not found'};
        }
        if (t.kind === 'root') {
            const root = wsContract ? wsContract.root : template.root;
            TemplateApplier._applyRootKey(parsed, t.key, root);
            return {target: '', status: 'applied'};
        }
        return {target: '', status: 'skipped', msg: 'unsupported kind'};
    }

    private static _applyRootKey(
        parsed: Record<string, unknown>,
        key: string,
        root: TemplateRoot
    ): void {
        // engines.<k> or scripts.<k>
        const dotIdx = key.indexOf('.');
        if (dotIdx > 0) {
            const head = key.slice(0, dotIdx);
            const tail = key.slice(dotIdx + 1);
            if (head === 'engines') {
                const expected = root.engines?.[tail];
                if (expected === undefined) {
                    return;
                }
                const obj = parsed.engines as Record<string, string>|undefined;
                if (!obj || typeof obj !== 'object') {
                    parsed.engines = {[tail]: expected};
                } else {
                    obj[tail] = expected;
                }
                return;
            }
            if (head === 'scripts') {
                const expected = root.scripts?.[tail];
                if (expected === undefined) {
                    return;
                }
                const obj = parsed.scripts as Record<string, string>|undefined;
                if (!obj || typeof obj !== 'object') {
                    parsed.scripts = {[tail]: expected};
                } else {
                    obj[tail] = expected;
                }
                return;
            }
        }
        if (key === 'private' && root.private !== undefined) {
            parsed.private = root.private;
            return;
        }
        if (key === 'type' && root.type !== undefined) {
            parsed.type = root.type;
            return;
        }
        if (key === 'packageManager' && root.packageManager !== undefined) {
            parsed.packageManager = root.packageManager;
            return;
        }
    }

    private static _setInBucket(
        parsed: Record<string, unknown>,
        bucket: string,
        name: string,
        version: string
    ): void {
        if (!parsed[bucket] || typeof parsed[bucket] !== 'object') {
            parsed[bucket] = {};
        }
        (parsed[bucket] as Record<string, string>)[name] = version;
    }

    private static _removeFromBucket(
        parsed: Record<string, unknown>,
        bucket: string,
        name: string
    ): boolean {
        const b = parsed[bucket];
        if (!b || typeof b !== 'object') {
            return false;
        }
        const obj = b as Record<string, string>;
        if (Object.prototype.hasOwnProperty.call(obj, name)) {
            delete obj[name];
            // If bucket is now empty, drop it from the package.json
            // to keep the file clean.
            if (Object.keys(obj).length === 0) {
                delete parsed[bucket];
            }
            return true;
        }
        return false;
    }

    /**
     * Copy or merge one template file ship into the project. `create`
     * mode writes only when absent (drift is the user's call); the
     * apply step still runs in this case because the user explicitly
     * selected the drift target — for `create` that means "create or
     * leave alone", never "overwrite".
     */
    private static _applyFileShip(
        t: Extract<ParsedTarget, {kind: 'file'}>,
        projectRoot: string,
        template: ResolvedTemplate
    ): TemplateApplyOutcome {
        const fileSpec = TemplateApplier._findFileSpec(template, t.workspace, t.path);
        if (!fileSpec) {
            return {target: '', status: 'skipped', msg: 'file ship no longer in template'};
        }
        if (!fs.existsSync(fileSpec.sourcePath)) {
            return {target: '', status: 'error', msg: `template source file missing: ${fileSpec.sourcePath}`};
        }
        const projectAbs = TemplateApplier._fileAbs(projectRoot, t.workspace, t.path);

        if (fileSpec.mode === 'report-only') {
            return {target: '', status: 'skipped', msg: 'report-only mode'};
        }

        if (fileSpec.mode === 'create') {
            if (fs.existsSync(projectAbs)) {
                return {target: '', status: 'skipped', msg: 'present + drifted; reconcile manually'};
            }
            const bytes = fs.readFileSync(fileSpec.sourcePath);
            fs.mkdirSync(path.dirname(projectAbs), {recursive: true});
            fs.writeFileSync(projectAbs, bytes);
            return {target: '', status: 'applied'};
        }

        // merge-json
        const templateText = fs.readFileSync(fileSpec.sourcePath, 'utf-8');
        let templateJson: Record<string, unknown>;
        try {
            templateJson = JSON.parse(templateText) as Record<string, unknown>;
        } catch (e) {
            // Non-JSON content with merge-json mode degrades to create.
            if (fs.existsSync(projectAbs)) {
                return {target: '', status: 'skipped', msg: `merge-json file isn't JSON; ${(e as Error).message}`};
            }
            fs.mkdirSync(path.dirname(projectAbs), {recursive: true});
            fs.writeFileSync(projectAbs, templateText);
            return {target: '', status: 'applied', msg: 'wrote template body (not JSON, degraded to create)'};
        }

        let projectJson: Record<string, unknown> = {};
        let indent: string|number = 2;
        let trailing = '\n';
        if (fs.existsSync(projectAbs)) {
            const txt = fs.readFileSync(projectAbs, 'utf-8');
            try {
                projectJson = JSON.parse(txt) as Record<string, unknown>;
            } catch {
                return {target: '', status: 'error', msg: 'project file is not valid JSON; manual fix required'};
            }
            indent = TemplateApplier._detectIndent(txt);
            trailing = txt.endsWith('\n') ? '\n' : '';
        }
        const merged = TemplateApplier._deepMerge(projectJson, templateJson);
        fs.mkdirSync(path.dirname(projectAbs), {recursive: true});
        fs.writeFileSync(projectAbs, JSON.stringify(merged, null, indent) + trailing);
        return {target: '', status: 'applied', msg: 'deep-merged template into project'};
    }

    private static _findFileSpec(
        template: ResolvedTemplate,
        workspace: string|undefined,
        relPath: string
    ): ResolvedTemplateFile|undefined {
        if (workspace === undefined) {
            return template.files.find((f) => f.path === relPath);
        }
        const ws = template.workspaces.find((w) => w.path === workspace);
        return ws?.files.find((f) => f.path === relPath);
    }

    /**
     * Deep-merge template values INTO project. Template values win on
     * scalar conflict (so the rule is "project must satisfy template").
     * Objects merge recursively; arrays do not merge — template array
     * replaces project array verbatim (no reliable semantic merge for
     * arrays).
     */
    private static _deepMerge(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {...into};
        for (const [k, v] of Object.entries(from)) {
            const cur = out[k];
            if (
                cur && typeof cur === 'object' && !Array.isArray(cur)
                && v && typeof v === 'object' && !Array.isArray(v)
            ) {
                out[k] = TemplateApplier._deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    private static _packageJsonFor(workspace: string|undefined, projectRoot: string): string {
        if (workspace === undefined || workspace.length === 0) {
            return path.join(projectRoot, 'package.json');
        }
        return path.join(projectRoot, workspace, 'package.json');
    }

    private static _fileAbs(projectRoot: string, workspace: string|undefined, relPath: string): string {
        if (workspace === undefined || workspace.length === 0) {
            return path.join(projectRoot, relPath);
        }
        return path.join(projectRoot, workspace, relPath);
    }

    private static _detectIndent(source: string): string|number {
        const m = /^(\s+)"[^"]+"\s*:/m.exec(source);
        if (!m) {
            return 2;
        }
        const lead = m[1];
        if (lead.startsWith('\t')) {
            return '\t';
        }
        return lead.length;
    }

    /**
     * Re-encode a parsed target back into the canonical target string
     * for echoing in the apply outcome. Mirrors the encoding the
     * compliance checker emits.
     */
    private static _reencodeTarget(t: ParsedTarget): string {
        switch (t.kind) {
            case 'package':
                return t.workspace
                    ? `workspace:${t.workspace}:${t.bucket}:${t.name}`
                    : `${t.bucket}:${t.name}`;
            case 'forbidden':
                return t.workspace
                    ? `workspace:${t.workspace}:forbidden:${t.name}`
                    : `forbidden:${t.name}`;
            case 'extra':
                return t.workspace
                    ? `workspace:${t.workspace}:extra:${t.name}`
                    : `extra:${t.name}`;
            case 'root':
                return t.workspace
                    ? `workspace:${t.workspace}:${t.key}`
                    : t.key;
            case 'file':
                return t.workspace
                    ? `workspace:${t.workspace}:file:${t.path}`
                    : `file:${t.path}`;
            case 'workspace-missing':
                return `workspace:${t.workspace}`;
            default:
                return '<unknown>';
        }
    }

    /**
     * Parse a finding target string back into a structured action.
     * Target encodings mirror the checker's emission rules.
     */
    private static _parseTarget(raw: string): ParsedTarget {
        let workspace: string|undefined;
        let rest = raw;
        if (rest.startsWith('workspace:')) {
            // `workspace:<path>` (bare) or `workspace:<path>:<rest>`.
            const after = rest.slice('workspace:'.length);
            // The workspace path itself can contain `/` but never `:`
            // in our emit; find the first colon.
            const colon = after.indexOf(':');
            if (colon < 0) {
                return {kind: 'workspace-missing', workspace: after};
            }
            workspace = after.slice(0, colon);
            rest = after.slice(colon + 1);
        }
        if (rest.startsWith('file:')) {
            return {kind: 'file', path: rest.slice('file:'.length), workspace};
        }
        if (rest.startsWith('forbidden:')) {
            return {kind: 'forbidden', name: rest.slice('forbidden:'.length), workspace};
        }
        if (rest.startsWith('extra:')) {
            return {kind: 'extra', name: rest.slice('extra:'.length), workspace};
        }
        for (const b of ['runtime', 'dev', 'peer', 'optional'] as const) {
            const prefix = `${b}:`;
            if (rest.startsWith(prefix)) {
                return {kind: 'package', bucket: b, name: rest.slice(prefix.length), workspace};
            }
        }
        // Root metadata: `engines.<k>`, `scripts.<k>`, `private`, `type`, `packageManager`.
        if (
            rest.startsWith('engines.')
            || rest.startsWith('scripts.')
            || rest === 'private'
            || rest === 'type'
            || rest === 'packageManager'
        ) {
            return {kind: 'root', key: rest, workspace};
        }
        return {kind: 'unknown'};
    }
}