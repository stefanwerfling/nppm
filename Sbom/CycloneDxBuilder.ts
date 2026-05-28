import {SbomComponent, SbomData} from './SbomCollector.js';

/**
 * Minimal shape of a CycloneDX 1.6 BOM. Full schema is huge; we emit
 * only the fields downstream tools (Trivy, Dependency-Track, OSV-
 * Scanner) actually inspect. The schema URL in `$schema` lets
 * validators pin the spec version even if we stay short of it.
 */
type CdxLicenseChoice = {license: {id: string}}|{license: {name: string}}|{expression: string};

type CdxComponent = {
    'bom-ref': string;
    type: 'library';
    name: string;
    version: string;
    purl: string;
    hashes?: {alg: 'SHA-512'; content: string}[];
    licenses?: CdxLicenseChoice[];
    externalReferences?: {type: 'distribution'|'vcs'; url: string}[];
};

type CdxDependency = {
    ref: string;
    dependsOn?: string[];
};

type CycloneDxBom = {
    $schema: string;
    bomFormat: 'CycloneDX';
    specVersion: '1.6';
    serialNumber: string;
    version: 1;
    metadata: {
        timestamp: string;
        tools: {components: {type: 'application'; name: 'nppm'; version: string}[]};
        component: {
            'bom-ref': string;
            type: 'application';
            name: string;
        };
    };
    components: CdxComponent[];
    dependencies: CdxDependency[];
};

/**
 * Emits a CycloneDX 1.6 BOM from the format-agnostic `SbomData`. The
 * tool version is injected so the test suite can pin the value
 * deterministically; runtime callers pass the package's own version.
 *
 * Identity choices:
 *  - `serialNumber` = the project's URN (CycloneDX expects an
 *    `urn:uuid:` here; the collector already generates one)
 *  - `bom-ref` = the PURL of each component, mirroring CycloneDX
 *    examples and making the dependency graph trivially correlated
 *    with the component list
 */
export class CycloneDxBuilder {

    public static build(data: SbomData, toolVersion: string): CycloneDxBom {
        const components: CdxComponent[] = data.components.map((c) => {
            const cdx: CdxComponent = {
                'bom-ref': c.purl,
                type: 'library',
                name: c.name,
                version: c.version,
                purl: c.purl
            };
            if (c.hashSha512Hex) {
                cdx.hashes = [{alg: 'SHA-512', content: c.hashSha512Hex}];
            }
            const lic = CycloneDxBuilder._licenseChoice(c.license);
            if (lic) {
                cdx.licenses = [lic];
            }
            const refs = CycloneDxBuilder._externalRefs(c);
            if (refs.length > 0) {
                cdx.externalReferences = refs;
            }
            return cdx;
        });

        const dependencies = data.components.map((c) => CycloneDxBuilder._dependencyEdge(c, data.components));

        return {
            $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
            bomFormat: 'CycloneDX',
            specVersion: '1.6',
            serialNumber: data.project.urn,
            version: 1,
            metadata: {
                timestamp: data.project.generatedAt,
                tools: {components: [{type: 'application', name: 'nppm', version: toolVersion}]},
                component: {
                    'bom-ref': `nppm-project:${data.project.name}`,
                    type: 'application',
                    name: data.project.name
                }
            },
            components,
            dependencies
        };
    }

    /**
     * Pick the CycloneDX `licenses[]` shape:
     *  - bare SPDX ID (`MIT`, `Apache-2.0`) → `license.id`
     *  - SPDX expression — has parens or a whole-word `AND`/`OR`/
     *    `WITH` operator → `expression`
     *  - free-form text (`see proprietary contract`) → `license.name`
     *
     * The expression check is tight on purpose: a space alone is not
     * enough (otherwise "see proprietary contract" would round-trip as
     * an SPDX expression and downstream tools would reject it).
     */
    private static _licenseChoice(spdx: string|null): CdxLicenseChoice|null {
        if (!spdx) {
            return null;
        }
        const trimmed = spdx.trim();
        if (trimmed.length === 0) {
            return null;
        }
        if (/[()]/.test(trimmed) || /\b(AND|OR|WITH)\b/.test(trimmed)) {
            return {expression: trimmed};
        }
        // Heuristic: SPDX IDs are short single tokens without spaces.
        if (/^[A-Za-z0-9.+-]+$/.test(trimmed) && trimmed.length <= 64) {
            return {license: {id: trimmed}};
        }
        return {license: {name: trimmed}};
    }

    private static _externalRefs(c: SbomComponent): NonNullable<CdxComponent['externalReferences']> {
        const refs: NonNullable<CdxComponent['externalReferences']> = [];
        if (c.resolved) {
            refs.push({type: 'distribution', url: c.resolved});
        }
        if (c.repository) {
            refs.push({type: 'vcs', url: c.repository});
        }
        return refs;
    }

    /**
     * Build the dependency-graph edge for one component. Each
     * declared name is matched to *some* version present in
     * `components` (we don't have a resolver here — first match wins).
     * Unmatched names are dropped so the graph stays internally
     * consistent (Dependency-Track rejects dangling refs).
     */
    private static _dependencyEdge(c: SbomComponent, all: SbomComponent[]): CdxDependency {
        const byName = new Map<string, SbomComponent>();
        for (const x of all) {
            if (!byName.has(x.name)) {
                byName.set(x.name, x);
            }
        }
        const dependsOn: string[] = [];
        for (const depName of Object.keys(c.directDeps)) {
            const match = byName.get(depName);
            if (match) {
                dependsOn.push(match.purl);
            }
        }
        const edge: CdxDependency = {ref: c.purl};
        if (dependsOn.length > 0) {
            edge.dependsOn = dependsOn;
        }
        return edge;
    }
}