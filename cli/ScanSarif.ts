import {ProjectScanReport, ScanFinding, ScanReport, UnifiedSeverity} from './ScanReport.js';

/**
 * Minimal subset of SARIF 2.1.0 we emit. Full spec at
 * https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
 * — GitHub Code Scanning ingests the same fields but tolerates the
 * full schema, so we keep the payload tight on purpose.
 *
 * Conventions:
 *  - one `run` per scan, one `tool.driver` (`nppm`)
 *  - one `rule` per finding category (vuln/script/pattern/…),
 *    so the GitHub UI groups consistently
 *  - one `result` per finding, with `level` mapped from
 *    `UnifiedSeverity` and `partialFingerprints` keyed by package
 *    coordinate so re-runs deduplicate cleanly
 */
type SarifLevel = 'note'|'warning'|'error';

type SarifRule = {
    id: string;
    name: string;
    shortDescription: {text: string;};
    fullDescription: {text: string;};
    defaultConfiguration: {level: SarifLevel;};
};

type SarifResult = {
    ruleId: string;
    level: SarifLevel;
    message: {text: string;};
    locations: {
        physicalLocation: {
            artifactLocation: {uri: string;};
        };
    }[];
    partialFingerprints: Record<string, string>;
    properties?: {
        category: string;
        severity: UnifiedSeverity;
        name: string;
        version?: string;
    };
};

type SarifRun = {
    tool: {
        driver: {
            name: string;
            informationUri: string;
            version: string;
            rules: SarifRule[];
        };
    };
    results: SarifResult[];
    invocations?: {
        executionSuccessful: boolean;
    }[];
};

type SarifLog = {
    $schema: string;
    version: '2.1.0';
    runs: SarifRun[];
};

/**
 * Static converter from the runner's aggregated report to a SARIF
 * 2.1.0 log. Deterministic — no I/O, no time-of-day reads — so the
 * tests can snapshot it cleanly. Methods stay static because no
 * instance state is involved.
 */
export class SarifBuilder {

    private static readonly _CATEGORY_DEFS: Record<string, {name: string; description: string; defaultLevel: SarifLevel;}> = {
        vuln: {
            name: 'Known vulnerability',
            description: 'OSV.dev recorded one or more CVEs against this package version.',
            defaultLevel: 'error'
        },
        script: {
            name: 'Lifecycle script',
            description: 'Install/build hook with a body matching a known risk pattern.',
            defaultLevel: 'warning'
        },
        pattern: {
            name: 'Suspicious code pattern',
            description: 'eval / new Function / child_process / base64 use detected in the tarball.',
            defaultLevel: 'warning'
        },
        binary: {
            name: 'Binary file in tarball',
            description: 'Native binary (.exe/.dll/.so/…) shipped inside the package.',
            defaultLevel: 'warning'
        },
        maintainer: {
            name: 'Maintainer handover',
            description: 'Publisher of the inspected version differs from the trust set.',
            defaultLevel: 'warning'
        },
        license: {
            name: 'License policy',
            description: 'License classification breaches policy (proprietary / strong-copyleft).',
            defaultLevel: 'warning'
        },
        unused: {
            name: 'Unused dependency',
            description: 'Declared in package.json but not imported anywhere.',
            defaultLevel: 'note'
        },
        misplaced: {
            name: 'Misplaced dependency',
            description: 'Imported only from dev paths but listed as a runtime dependency.',
            defaultLevel: 'warning'
        },
        missing: {
            name: 'Missing dependency',
            description: 'Imported from source but not declared in any bucket.',
            defaultLevel: 'error'
        },
        external: {
            name: 'External-sources verdict',
            description: 'Aggregated reputation signal from socket.dev / OpenSSF Scorecard / deps.dev — worst-of-three per package.',
            defaultLevel: 'warning'
        },
        deprecation: {
            name: 'Deprecated package version',
            description: 'The installed version or the registry latest carries an `npm deprecate` marker.',
            defaultLevel: 'warning'
        },
        obfuscation: {
            name: 'Obfuscated JS source',
            description: 'JS file(s) inside the tarball look intentionally obfuscated (obfuscator.io identifiers, eval(atob(...)) chains, hex-string arrays, or pathologically long lines outside of dist/min paths).',
            defaultLevel: 'warning'
        },
        manifestRedFlags: {
            name: 'Manifest red-flags',
            description: 'Soft signals on package.json (missing README/description/files allowlist, many bin entries, native+postinstall combo, dated engines.node range).',
            defaultLevel: 'warning'
        },
        capability: {
            name: 'Capability inventory',
            description: 'Aggregated set of platform APIs touched (fs read/write, network, raw sockets, child_process, credential-shaped env reads, native bindings, eval). Severity is the worst-of-combinations.',
            defaultLevel: 'warning'
        }
    };

    public static build(report: ScanReport, toolVersion: string): SarifLog {
        const seenRules = new Set<string>();
        const rules: SarifRule[] = [];
        const results: SarifResult[] = [];

        for (const project of report.projects) {
            for (const f of project.findings) {
                const ruleId = SarifBuilder._ruleIdFor(f.category);
                if (!seenRules.has(ruleId)) {
                    const def = SarifBuilder._CATEGORY_DEFS[f.category];
                    if (def) {
                        rules.push({
                            id: ruleId,
                            name: def.name,
                            shortDescription: {text: def.name},
                            fullDescription: {text: def.description},
                            defaultConfiguration: {level: def.defaultLevel}
                        });
                        seenRules.add(ruleId);
                    }
                }

                results.push({
                    ruleId: ruleId,
                    level: SarifBuilder._severityToLevel(f.severity),
                    message: {text: `${f.name}${f.version ? `@${  f.version}` : ''}: ${f.message}`},
                    locations: [SarifBuilder._locationFor(project, f)],
                    partialFingerprints: SarifBuilder._fingerprintFor(project, f),
                    properties: {
                        category: f.category,
                        severity: f.severity,
                        name: f.name,
                        version: f.version
                    }
                });
            }
        }

        return {
            $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
            version: '2.1.0',
            runs: [{
                tool: {
                    driver: {
                        name: 'nppm',
                        informationUri: 'https://github.com/stefanwerfling/nppm',
                        version: toolVersion,
                        rules: rules
                    }
                },
                results: results,
                invocations: [{
                    executionSuccessful: report.projects.every((p) => p.error === null)
                }]
            }]
        };
    }

    private static _severityToLevel(s: UnifiedSeverity): SarifLevel {
        switch (s) {
            case UnifiedSeverity.info: return 'note';
            case UnifiedSeverity.warn: return 'warning';
            case UnifiedSeverity.risk: return 'error';
        }
    }

    private static _ruleIdFor(category: string): string {
        return `nppm/${category}`;
    }

    private static _locationFor(project: ProjectScanReport, f: ScanFinding): SarifResult['locations'][number] {
        /*
         * SARIF requires *some* location. We don't have a per-finding
         * source file in most cases (the finding is about a published
         * package, not a checked-in source file), so we synthesise a
         * URI that names the project + package — GitHub displays this
         * verbatim and it's stable for fingerprinting.
         */
        const ver = f.version ? `@${f.version}` : '';
        const uri = `nppm-project/${project.project.name}/${f.name}${ver}`;
        return {physicalLocation: {artifactLocation: {uri: uri}}};
    }

    private static _fingerprintFor(project: ProjectScanReport, f: ScanFinding): Record<string, string> {
        return {
            nppmCoord: `${project.project.name}|${f.category}|${f.name}${f.version ? `@${  f.version}` : ''}`
        };
    }

}