import fs from 'fs';
import path from 'path';
import {DependencyType, PackageManifest} from '../Project/PackageManifest.js';
import {
    ComplianceFinding,
    ComplianceReport,
    ComplianceSeverity,
    ResolvedTemplate,
    ResolvedTemplateFile,
    ResolvedTemplateWorkspace,
    TemplatePackageRequirement,
    TemplateRoot
} from './Template.js';

/**
 * Diff engine: compares a project's manifests against a fully-resolved
 * template chain and produces a flat `ComplianceFinding[]`. Phase-1
 * scope covers packages (runtime/dev/peer/optional missing /
 * divergent / forbidden / extra) and root-`package.json` metadata
 * (engines, scripts, private, type, packageManager). Per-workspace
 * checks + file checks are phase 2.
 *
 * Severity rules:
 *  - `forbidden`: always `risk`
 *  - `missing` + `required: true`: `risk`
 *  - `missing` + `required` unset/false: `warn`
 *  - `divergent` (version range differs): `warn`
 *  - `bucket-wrong` (right package, wrong dependency kind): `warn`
 *  - `extra` (project has package the template doesn't pin,
 *    `strict` mode only): `info`
 *  - root-`missing` / root-`divergent`: `warn`
 */
export class TemplateComplianceChecker {

    /**
     * Run the checker against one project. `manifests` is the
     * project's full manifest list (root + workspaces); root-metadata
     * is consulted against the workspace=undefined entry. The
     * aggregated dependency list across all manifests feeds the
     * top-level package check — workspace-level overrides can satisfy
     * a template requirement the root doesn't, which matches how npm
     * hoists.
     *
     * `opts.projectRoot` enables file-compliance checks (template
     * declares `files[]`). Omit for tests or remote projects where
     * the on-disk content isn't reachable; file-findings then degrade
     * to silent skips rather than spurious "missing" reports.
     */
    public check(
        manifests: PackageManifest[],
        template: ResolvedTemplate,
        opts: {projectRoot?: string;} = {}
    ): ComplianceReport {
        const findings: ComplianceFinding[] = [];
        if (template.sourceIds.length === 0) {
            return {templateIds: [], findings: [], worst: null};
        }
        const root = manifests.find((m) => m.workspace === undefined) ?? manifests[0];

        // Index project deps by name → list of {bucket, range, workspace?}
        type Seen = {bucket: DependencyType; range: string; workspace?: string;};
        const projectDeps = new Map<string, Seen[]>();
        for (const m of manifests) {
            for (const d of m.dependencies) {
                const list = projectDeps.get(d.name) ?? [];
                list.push({bucket: d.type, range: d.version, workspace: d.workspace});
                projectDeps.set(d.name, list);
            }
        }

        const bucketKeys: (keyof ResolvedTemplate['packages'])[] = ['runtime', 'dev', 'peer', 'optional'];
        const bucketToType: Record<keyof ResolvedTemplate['packages'], DependencyType> = {
            runtime: DependencyType.dependency,
            dev: DependencyType.dev,
            peer: DependencyType.peer,
            optional: DependencyType.optional
        };

        /*
         * Walk every templated bucket → check missing / divergent /
         * bucket-wrong.
         */
        for (const bucket of bucketKeys) {
            const expectedType = bucketToType[bucket];
            const reqs = template.packages[bucket];
            for (const [name, req] of Object.entries(reqs)) {
                const sourceId = TemplateComplianceChecker._ownerOf(template, bucket, name);
                const seen = projectDeps.get(name);
                if (!seen || seen.length === 0) {
                    findings.push({
                        kind: 'missing',
                        severity: req.required ? 'risk' : 'warn',
                        target: `${bucket}:${name}`,
                        expected: req.version,
                        sourceId: sourceId
                    });
                    continue;
                }
                // Find the entry that matches the expected bucket, if any.
                const matchedBucket = seen.find((s) => s.bucket === expectedType);
                if (matchedBucket) {
                    if (req.version
                        && !TemplateComplianceChecker._rangesEqual(req.version, matchedBucket.range)
                    ) {
                        findings.push({
                            kind: 'divergent',
                            severity: 'warn',
                            target: `${bucket}:${name}`,
                            expected: req.version,
                            actual: matchedBucket.range,
                            sourceId: sourceId
                        });
                    }
                } else {
                    // Package present but only in the wrong bucket.
                    const wrong = seen[0];
                    findings.push({
                        kind: 'bucket-wrong',
                        severity: 'warn',
                        target: `${bucket}:${name}`,
                        expected: req.version
                            ? `${bucket} (${req.version})`
                            : bucket,
                        actual: `${TemplateComplianceChecker._typeToBucket(wrong.bucket)} (${wrong.range})`,
                        sourceId: sourceId
                    });
                }
            }
        }

        // Forbidden — flag any project dep whose name matches.
        for (const name of template.forbidden) {
            const seen = projectDeps.get(name);
            if (!seen || seen.length === 0) {
                continue;
            }
            const sourceId = TemplateComplianceChecker._forbiddenOwner(template, name);
            const where = seen[0];
            findings.push({
                kind: 'forbidden',
                severity: 'risk',
                target: `forbidden:${name}`,
                actual: `${TemplateComplianceChecker._typeToBucket(where.bucket)} (${where.range})`,
                sourceId: sourceId
            });
        }

        /*
         * Strict mode — flag any project dep not declared in the template
         * and not on the forbidden list.
         */
        if (template.mode === 'strict') {
            const pinned = new Set<string>();
            for (const bucket of bucketKeys) {
                for (const name of Object.keys(template.packages[bucket])) {
                    pinned.add(name);
                }
            }
            const forbiddenSet = new Set(template.forbidden);
            for (const name of projectDeps.keys()) {
                if (pinned.has(name) || forbiddenSet.has(name)) {
                    continue;
                }
                const where = projectDeps.get(name)![0];
                findings.push({
                    kind: 'extra',
                    severity: 'info',
                    target: `extra:${name}`,
                    actual: `${TemplateComplianceChecker._typeToBucket(where.bucket)} (${where.range})`,
                    sourceId: template.id
                });
            }
        }

        /*
         * Root-package.json metadata. Each key in the template's
         * `root` section is checked independently. Engines + scripts
         * are deep-key maps; private/type/packageManager are scalars.
         */
        const r = template.root;
        if (r.engines) {
            for (const [k, expected] of Object.entries(r.engines)) {
                const actual = root.engines?.[k];
                if (actual === undefined) {
                    findings.push({
                        kind: 'root-missing',
                        severity: 'warn',
                        target: `engines.${k}`,
                        expected: expected,
                        sourceId: template.id
                    });
                } else if (actual !== expected) {
                    findings.push({
                        kind: 'root-divergent',
                        severity: 'warn',
                        target: `engines.${k}`,
                        expected: expected,
                        actual: actual,
                        sourceId: template.id
                    });
                }
            }
        }
        if (r.scripts) {
            for (const [k, expected] of Object.entries(r.scripts)) {
                const actual = root.scripts[k];
                if (actual === undefined) {
                    findings.push({
                        kind: 'root-missing',
                        severity: 'warn',
                        target: `scripts.${k}`,
                        expected: expected,
                        sourceId: template.id
                    });
                } else if (actual !== expected) {
                    findings.push({
                        kind: 'root-divergent',
                        severity: 'warn',
                        target: `scripts.${k}`,
                        expected: expected,
                        actual: actual,
                        sourceId: template.id
                    });
                }
            }
        }
        if (r.private !== undefined) {
            if (root.isPrivate === undefined) {
                findings.push({
                    kind: 'root-missing',
                    severity: 'warn',
                    target: 'private',
                    expected: String(r.private),
                    sourceId: template.id
                });
            } else if (root.isPrivate !== r.private) {
                findings.push({
                    kind: 'root-divergent',
                    severity: 'warn',
                    target: 'private',
                    expected: String(r.private),
                    actual: String(root.isPrivate),
                    sourceId: template.id
                });
            }
        }
        if (r.type !== undefined) {
            if (root.moduleType === undefined) {
                findings.push({
                    kind: 'root-missing',
                    severity: 'warn',
                    target: 'type',
                    expected: r.type,
                    sourceId: template.id
                });
            } else if (root.moduleType !== r.type) {
                findings.push({
                    kind: 'root-divergent',
                    severity: 'warn',
                    target: 'type',
                    expected: r.type,
                    actual: root.moduleType,
                    sourceId: template.id
                });
            }
        }
        if (r.packageManager !== undefined) {
            if (root.packageManager === undefined) {
                findings.push({
                    kind: 'root-missing',
                    severity: 'warn',
                    target: 'packageManager',
                    expected: r.packageManager,
                    sourceId: template.id
                });
            } else if (root.packageManager !== r.packageManager) {
                findings.push({
                    kind: 'root-divergent',
                    severity: 'warn',
                    target: 'packageManager',
                    expected: r.packageManager,
                    actual: root.packageManager,
                    sourceId: template.id
                });
            }
        }

        /*
         * File-compliance against the template's top-level `files[]`.
         * Skipped when no projectRoot is provided (tests / remote
         * projects).
         */
        if (opts.projectRoot) {
            for (const f of template.files) {
                const finding = TemplateComplianceChecker._checkFile(f, opts.projectRoot, '');
                if (finding) {
                    findings.push(finding);
                }
            }
        }

        /*
         * Per-workspace checks. The template declares the workspace
         * contract; we match by `workspace` path on the project's
         * manifests. Missing workspaces surface as one finding; the
         * recursive packages / root / files check then runs against
         * the workspace's own manifest.
         */
        for (const ws of template.workspaces) {
            const wsManifest = manifests.find((m) => m.workspace === ws.path);
            if (!wsManifest) {
                findings.push({
                    kind: 'workspace-missing',
                    severity: 'warn',
                    target: `workspace:${ws.path}`,
                    sourceId: ws.sourceId
                });
                continue;
            }
            TemplateComplianceChecker._checkWorkspace(
                ws,
                wsManifest,
                opts.projectRoot,
                findings
            );
        }

        return {
            templateIds: template.sourceIds,
            findings: findings,
            worst: TemplateComplianceChecker._worst(findings)
        };
    }

    /**
     * Compare one file ship: read both sides, byte-exact. `report-only`
     * never produces a `file-missing` finding (it's purely
     * informational); other modes surface missing files as warn drift.
     */
    private static _checkFile(
        f: ResolvedTemplateFile,
        projectRoot: string,
        workspacePath: string
    ): ComplianceFinding|null {
        const projectAbs = path.join(projectRoot, workspacePath, f.path);
        /*
         * For workspace files the resolver records sourcePath under
         * <files>/<workspace>/<path> — read it as-is.
         */
        const wsTarget = workspacePath.length > 0
            ? `workspace:${workspacePath}:file:${f.path}`
            : `file:${f.path}`;
        const projectExists = fs.existsSync(projectAbs);
        const templateExists = fs.existsSync(f.sourcePath);
        if (!templateExists) {
            /*
             * Template promises a file that's not actually on disk —
             * misconfigured template; surface as warn so the user
             * notices.
             */
            return {
                kind: 'file-missing',
                severity: 'warn',
                target: wsTarget,
                expected: f.path,
                actual: '(template source missing)',
                sourceId: '(template)'
            };
        }
        if (!projectExists) {
            if (f.mode === 'report-only') {
                return null;
            }
            return {
                kind: 'file-missing',
                severity: 'warn',
                target: wsTarget,
                expected: f.path,
                sourceId: '(file ship)'
            };
        }
        const projectBytes = fs.readFileSync(projectAbs);
        const templateBytes = fs.readFileSync(f.sourcePath);
        if (projectBytes.equals(templateBytes)) {
            return null;
        }
        /*
         * merge-json mode: drift only when applying the merge would
         * actually change something. The byte-difference between a
         * valid merged project file and the template source isn't
         * drift — the user opted into "project may have its own
         * additional keys", and the template only enforces presence
         * of its own keys + values.
         */
        if (f.mode === 'merge-json') {
            const drift = TemplateComplianceChecker._mergeJsonDrift(projectBytes, templateBytes);
            if (!drift) {
                return null;
            }
            return {
                kind: 'file-drift',
                severity: 'warn',
                target: wsTarget,
                expected: `${f.path} (merge-json)`,
                actual: drift,
                sourceId: '(file ship)'
            };
        }
        return {
            kind: 'file-drift',
            severity: f.mode === 'report-only' ? 'info' : 'warn',
            target: wsTarget,
            expected: `${f.path} (${f.mode})`,
            actual: `${projectBytes.length} bytes vs ${templateBytes.length} bytes`,
            sourceId: '(file ship)'
        };
    }

    /**
     * Decide whether a merge-json file ship would actually change the
     * project file. Returns `null` when the project already satisfies
     * every key the template declares (deep-equal at leaves); returns
     * a short human description of the first mismatch otherwise. Bad
     * JSON on either side degrades to a byte-difference report.
     */
    private static _mergeJsonDrift(projectBytes: Buffer, templateBytes: Buffer): string|null {
        let projectJson: unknown;
        let templateJson: unknown;
        try {
            projectJson = JSON.parse(projectBytes.toString('utf-8'));
            templateJson = JSON.parse(templateBytes.toString('utf-8'));
        } catch {
            return `${projectBytes.length} bytes vs ${templateBytes.length} bytes`;
        }
        const diff = TemplateComplianceChecker._deepDrift(projectJson, templateJson, '');
        return diff;
    }

    /**
     * Walk `template` and return the first path where `project`
     * doesn't contain a matching value. Used to surface a one-line
     * "engines.node = >=20" style diff for the merge-json check.
     */
    private static _deepDrift(project: unknown, template: unknown, prefix: string): string|null {
        if (template === null || typeof template !== 'object' || Array.isArray(template)) {
            if (project !== template) {
                if (Array.isArray(template) && Array.isArray(project)
                    && JSON.stringify(project) === JSON.stringify(template)) {
                    return null;
                }
                const expected = JSON.stringify(template);
                const actual = JSON.stringify(project);
                return `${prefix || '<root>'} = ${expected} (project: ${actual})`;
            }
            return null;
        }
        if (project === null || typeof project !== 'object' || Array.isArray(project)) {
            return `${prefix || '<root>'} is missing`;
        }
        const t = template as Record<string, unknown>;
        const p = project as Record<string, unknown>;
        for (const [key, val] of Object.entries(t)) {
            const subPrefix = prefix ? `${prefix}.${key}` : key;
            if (!Object.hasOwn(p, key)) {
                return `${subPrefix} missing`;
            }
            const sub = TemplateComplianceChecker._deepDrift(p[key], val, subPrefix);
            if (sub) {
                return sub;
            }
        }
        return null;
    }

    /**
     * Per-workspace check: packages + forbidden + root + files,
     * restricted to the one matching manifest. Pushes findings into
     * the shared list; targets get a `workspace:<path>:` prefix so
     * the UI can group + apply per-workspace.
     */
    private static _checkWorkspace(
        ws: ResolvedTemplateWorkspace,
        manifest: PackageManifest,
        projectRoot: string|undefined,
        findings: ComplianceFinding[]
    ): void {
        const bucketKeys: (keyof ResolvedTemplateWorkspace['packages'])[] = ['runtime', 'dev', 'peer', 'optional'];
        const bucketToType: Record<keyof ResolvedTemplateWorkspace['packages'], DependencyType> = {
            runtime: DependencyType.dependency,
            dev: DependencyType.dev,
            peer: DependencyType.peer,
            optional: DependencyType.optional
        };
        const targetPrefix = `workspace:${ws.path}:`;

        // Workspace-deps index — only this workspace's deps count.
        type Seen = {bucket: DependencyType; range: string;};
        const wsDeps = new Map<string, Seen[]>();
        for (const d of manifest.dependencies) {
            const list = wsDeps.get(d.name) ?? [];
            list.push({bucket: d.type, range: d.version});
            wsDeps.set(d.name, list);
        }

        for (const bucket of bucketKeys) {
            const expectedType = bucketToType[bucket];
            for (const [name, req] of Object.entries(ws.packages[bucket])) {
                const seen = wsDeps.get(name);
                if (!seen || seen.length === 0) {
                    findings.push({
                        kind: 'missing',
                        severity: req.required ? 'risk' : 'warn',
                        target: `${targetPrefix}${bucket}:${name}`,
                        expected: req.version,
                        sourceId: ws.sourceId
                    });
                    continue;
                }
                const matched = seen.find((s) => s.bucket === expectedType);
                if (matched) {
                    if (req.version
                        && !TemplateComplianceChecker._rangesEqual(req.version, matched.range)
                    ) {
                        findings.push({
                            kind: 'divergent',
                            severity: 'warn',
                            target: `${targetPrefix}${bucket}:${name}`,
                            expected: req.version,
                            actual: matched.range,
                            sourceId: ws.sourceId
                        });
                    }
                } else {
                    const wrong = seen[0];
                    findings.push({
                        kind: 'bucket-wrong',
                        severity: 'warn',
                        target: `${targetPrefix}${bucket}:${name}`,
                        expected: req.version ? `${bucket} (${req.version})` : bucket,
                        actual: `${TemplateComplianceChecker._typeToBucket(wrong.bucket)} (${wrong.range})`,
                        sourceId: ws.sourceId
                    });
                }
            }
        }
        for (const name of ws.forbidden) {
            const seen = wsDeps.get(name);
            if (!seen) {
                continue;
            }
            const where = seen[0];
            findings.push({
                kind: 'forbidden',
                severity: 'risk',
                target: `${targetPrefix}forbidden:${name}`,
                actual: `${TemplateComplianceChecker._typeToBucket(where.bucket)} (${where.range})`,
                sourceId: ws.sourceId
            });
        }

        /*
         * Workspace root metadata — checks against this workspace's
         * package.json (e.g. its own scripts.test).
         */
        TemplateComplianceChecker._checkRootInto(ws.root, manifest, ws.sourceId, targetPrefix, findings);

        // Workspace files (paths are relative to the workspace dir).
        if (projectRoot) {
            for (const f of ws.files) {
                const finding = TemplateComplianceChecker._checkFile(f, projectRoot, ws.path);
                if (finding) {
                    findings.push(finding);
                }
            }
        }
    }

    /**
     * Lift the root-metadata block into a shared helper so the
     * per-workspace check can reuse it. `targetPrefix` lets the
     * workspace caller produce `workspace:<path>:engines.node` etc.
     */
    private static _checkRootInto(
        root: TemplateRoot,
        manifest: PackageManifest,
        sourceId: string,
        targetPrefix: string,
        findings: ComplianceFinding[]
    ): void {
        if (root.engines) {
            for (const [k, expected] of Object.entries(root.engines)) {
                const actual = manifest.engines?.[k];
                if (actual === undefined) {
                    findings.push({
                        kind: 'root-missing',
                        severity: 'warn',
                        target: `${targetPrefix}engines.${k}`,
                        expected: expected,
                        sourceId: sourceId
                    });
                } else if (actual !== expected) {
                    findings.push({
                        kind: 'root-divergent',
                        severity: 'warn',
                        target: `${targetPrefix}engines.${k}`,
                        expected: expected,
                        actual: actual,
                        sourceId: sourceId
                    });
                }
            }
        }
        if (root.scripts) {
            for (const [k, expected] of Object.entries(root.scripts)) {
                const actual = manifest.scripts[k];
                if (actual === undefined) {
                    findings.push({
                        kind: 'root-missing',
                        severity: 'warn',
                        target: `${targetPrefix}scripts.${k}`,
                        expected: expected,
                        sourceId: sourceId
                    });
                } else if (actual !== expected) {
                    findings.push({
                        kind: 'root-divergent',
                        severity: 'warn',
                        target: `${targetPrefix}scripts.${k}`,
                        expected: expected,
                        actual: actual,
                        sourceId: sourceId
                    });
                }
            }
        }
        if (root.private !== undefined) {
            if (manifest.isPrivate === undefined) {
                findings.push({
                    kind: 'root-missing',
                    severity: 'warn',
                    target: `${targetPrefix}private`,
                    expected: String(root.private),
                    sourceId: sourceId
                });
            } else if (manifest.isPrivate !== root.private) {
                findings.push({
                    kind: 'root-divergent',
                    severity: 'warn',
                    target: `${targetPrefix}private`,
                    expected: String(root.private),
                    actual: String(manifest.isPrivate),
                    sourceId: sourceId
                });
            }
        }
        if (root.type !== undefined) {
            if (manifest.moduleType === undefined) {
                findings.push({
                    kind: 'root-missing',
                    severity: 'warn',
                    target: `${targetPrefix}type`,
                    expected: root.type,
                    sourceId: sourceId
                });
            } else if (manifest.moduleType !== root.type) {
                findings.push({
                    kind: 'root-divergent',
                    severity: 'warn',
                    target: `${targetPrefix}type`,
                    expected: root.type,
                    actual: manifest.moduleType,
                    sourceId: sourceId
                });
            }
        }
        if (root.packageManager !== undefined) {
            if (manifest.packageManager === undefined) {
                findings.push({
                    kind: 'root-missing',
                    severity: 'warn',
                    target: `${targetPrefix}packageManager`,
                    expected: root.packageManager,
                    sourceId: sourceId
                });
            } else if (manifest.packageManager !== root.packageManager) {
                findings.push({
                    kind: 'root-divergent',
                    severity: 'warn',
                    target: `${targetPrefix}packageManager`,
                    expected: root.packageManager,
                    actual: manifest.packageManager,
                    sourceId: sourceId
                });
            }
        }
    }

    private static _ownerOf(
        template: ResolvedTemplate,
        bucket: keyof ResolvedTemplate['packages'],
        name: string
    ): string {
        /*
         * The merger doesn't track per-key ownership, so attribute to
         * the final template in the chain — sufficient for the UI
         * tooltip until phase 2 introduces an ownership map.
         */
        return template.sourceIds[template.sourceIds.length - 1] ?? template.id;
    }

    private static _forbiddenOwner(template: ResolvedTemplate, _name: string): string {
        return template.sourceIds[template.sourceIds.length - 1] ?? template.id;
    }

    /**
     * Bytes-equal range comparison after trimming. Phase-1 keeps it
     * literal — `^5.1.0` ≠ `5.1.0` even though they overlap. A
     * semver-aware equivalence would mask drift the user wanted to
     * see (was `~5` intentional? Did someone widen the range?).
     */
    private static _rangesEqual(a: string, b: string): boolean {
        return a.trim() === b.trim();
    }

    private static _typeToBucket(t: DependencyType): keyof ResolvedTemplate['packages'] {
        switch (t) {
            case DependencyType.dependency: return 'runtime';
            case DependencyType.dev: return 'dev';
            case DependencyType.peer: return 'peer';
            case DependencyType.optional: return 'optional';
        }
    }

    private static _worst(findings: ComplianceFinding[]): ComplianceSeverity|null {
        let r: ComplianceSeverity|null = null;
        for (const f of findings) {
            if (f.severity === 'risk') {
                return 'risk';
            }
            if (f.severity === 'warn') {
                r = 'warn';
            } else if (r === null) {
                r = 'info';
            }
        }
        return r;
    }

}