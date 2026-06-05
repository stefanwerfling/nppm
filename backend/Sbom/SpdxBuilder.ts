import {SbomComponent, SbomData} from './SbomCollector.js';

/**
 * Minimal SPDX 2.3 JSON shape. We emit the fields downstream
 * compliance tooling (Fossology, FOSSA, SPDX-tools) actually
 * inspects: packages with name/version/SPDXID/downloadLocation/
 * licenseConcluded/checksums, plus DEPENDS_ON relationships.
 */
type SpdxChecksum = {algorithm: 'SHA512'; checksumValue: string};

type SpdxExternalRef = {
    referenceCategory: 'PACKAGE-MANAGER';
    referenceType: 'purl';
    referenceLocator: string;
};

type SpdxPackage = {
    SPDXID: string;
    name: string;
    versionInfo: string;
    downloadLocation: string;
    filesAnalyzed: false;
    licenseConcluded: string;
    licenseDeclared: string;
    copyrightText: string;
    checksums?: SpdxChecksum[];
    externalRefs: SpdxExternalRef[];
};

type SpdxRelationship = {
    spdxElementId: string;
    relationshipType: 'DEPENDS_ON'|'DESCRIBES';
    relatedSpdxElement: string;
};

type SpdxDocument = {
    spdxVersion: 'SPDX-2.3';
    dataLicense: 'CC0-1.0';
    SPDXID: 'SPDXRef-DOCUMENT';
    name: string;
    documentNamespace: string;
    creationInfo: {
        created: string;
        creators: string[];
    };
    packages: SpdxPackage[];
    relationships: SpdxRelationship[];
};

/**
 * Emits an SPDX 2.3 JSON document from the format-agnostic
 * `SbomData`. The tool version is injected for deterministic tests.
 *
 * Key SPDX rules we honour:
 *  - `SPDXID` must match `SPDXRef-[A-Za-z0-9.-]+` — we sanitise
 *    `${name}-${version}` accordingly.
 *  - `licenseConcluded`/`licenseDeclared` must be a valid SPDX
 *    expression or `NOASSERTION` — anything we can't validate cheaply
 *    falls back to `NOASSERTION`.
 *  - Checksums use uppercase hex per spec (lockfile gives base64; the
 *    collector already transcoded to lowercase hex — we uppercase
 *    here for spec compliance).
 *  - One `DESCRIBES` relationship from the document to a root package
 *    that represents the project itself; one `DEPENDS_ON` per direct
 *    dependency edge.
 */
export class SpdxBuilder {

    private static readonly _SPDX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

    public static build(data: SbomData, toolVersion: string): SpdxDocument {
        const rootId = 'SPDXRef-Project';
        const refByPurl = new Map<string, string>();
        for (const c of data.components) {
            refByPurl.set(c.purl, SpdxBuilder._spdxId(c.name, c.version));
        }

        const packages: SpdxPackage[] = data.components.map((c) => {
            const spdxId = refByPurl.get(c.purl)!;
            const pkg: SpdxPackage = {
                SPDXID: spdxId,
                name: c.name,
                versionInfo: c.version,
                downloadLocation: c.resolved ?? 'NOASSERTION',
                filesAnalyzed: false,
                licenseConcluded: SpdxBuilder._licenseField(c.license),
                licenseDeclared: SpdxBuilder._licenseField(c.license),
                copyrightText: 'NOASSERTION',
                externalRefs: [{
                    referenceCategory: 'PACKAGE-MANAGER',
                    referenceType: 'purl',
                    referenceLocator: c.purl
                }]
            };
            if (c.hashSha512Hex) {
                pkg.checksums = [{algorithm: 'SHA512', checksumValue: c.hashSha512Hex.toUpperCase()}];
            }
            return pkg;
        });

        // Root project package — minimal, used as the `DESCRIBES`
        // target so consumers know which element is the BOM subject.
        packages.unshift({
            SPDXID: rootId,
            name: data.project.name,
            versionInfo: 'NOASSERTION',
            downloadLocation: 'NOASSERTION',
            filesAnalyzed: false,
            licenseConcluded: 'NOASSERTION',
            licenseDeclared: 'NOASSERTION',
            copyrightText: 'NOASSERTION',
            externalRefs: []
        });

        const relationships: SpdxRelationship[] = [];
        relationships.push({
            spdxElementId: 'SPDXRef-DOCUMENT',
            relationshipType: 'DESCRIBES',
            relatedSpdxElement: rootId
        });

        // Build per-name index so dependency-edge resolution mirrors
        // CycloneDX semantics: declared name → first matching version.
        const byName = new Map<string, SbomComponent>();
        for (const c of data.components) {
            if (!byName.has(c.name)) {
                byName.set(c.name, c);
            }
        }
        for (const c of data.components) {
            const fromId = refByPurl.get(c.purl)!;
            for (const depName of Object.keys(c.directDeps)) {
                const match = byName.get(depName);
                if (!match) {
                    continue;
                }
                const toId = refByPurl.get(match.purl);
                if (toId) {
                    relationships.push({
                        spdxElementId: fromId,
                        relationshipType: 'DEPENDS_ON',
                        relatedSpdxElement: toId
                    });
                }
            }
        }

        return {
            spdxVersion: 'SPDX-2.3',
            dataLicense: 'CC0-1.0',
            SPDXID: 'SPDXRef-DOCUMENT',
            name: `${data.project.name}-sbom`,
            documentNamespace: `https://github.com/stefanwerfling/nppm/sbom/${data.project.urn}`,
            creationInfo: {
                created: data.project.generatedAt,
                creators: [`Tool: nppm-${toolVersion}`]
            },
            packages,
            relationships
        };
    }

    /**
     * Build a SPDX-conformant SPDXID. Spec restricts to letters,
     * digits, `.`, `+`, `-`. Sanitised inputs that strip to nothing
     * fall back to `pkg` so the result is still well-formed.
     */
    private static _spdxId(name: string, version: string): string {
        const sanitised = `${name}-${version}`
            .replace(/[^A-Za-z0-9.+-]/g, '-')
            .replace(/^-+|-+$/g, '');
        const safe = sanitised.length > 0 ? sanitised : 'pkg';
        return `SPDXRef-${safe}`;
    }

    /**
     * SPDX is strict: `licenseConcluded` must be a valid SPDX
     * expression or `NOASSERTION`. A bare SPDX ID validates; a
     * compound expression with `OR`/`AND`/`WITH` validates; anything
     * else gets `NOASSERTION` so downstream validators don't reject
     * the whole document.
     */
    private static _licenseField(spdx: string|null): string {
        if (!spdx) {
            return 'NOASSERTION';
        }
        const trimmed = spdx.trim();
        if (trimmed.length === 0) {
            return 'NOASSERTION';
        }
        if (SpdxBuilder._SPDX_ID_RE.test(trimmed)) {
            return trimmed;
        }
        // Compound expression — let through if it's parens + uppercase
        // operators + valid SPDX-ish tokens. We don't fully validate;
        // a downstream tool will catch the malformed cases.
        if (/^[A-Za-z0-9.+\-() ]+$/.test(trimmed) && /\b(AND|OR|WITH)\b/.test(trimmed)) {
            return trimmed;
        }
        return 'NOASSERTION';
    }
}