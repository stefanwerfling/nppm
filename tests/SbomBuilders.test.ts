import {describe, expect, it} from 'vitest';
import {CycloneDxBuilder} from '../backend/Sbom/CycloneDxBuilder.js';
import {SbomData} from '../backend/Sbom/SbomCollector.js';
import {SpdxBuilder} from '../backend/Sbom/SpdxBuilder.js';

function fixture(): SbomData {
    return {
        project: {
            name: 'demo',
            urn: 'urn:uuid:11111111-2222-3333-4444-555555555555',
            generatedAt: '2026-05-28T12:00:00.000Z'
        },
        components: [
            {
                name: '@scope/api',
                version: '1.0.0',
                purl: 'pkg:npm/scope/api@1.0.0',
                resolved: 'https://registry.npmjs.org/@scope/api/-/api-1.0.0.tgz',
                hashSha512Hex: 'abc123',
                license: 'MIT',
                repository: 'git+https://github.com/scope/api.git',
                directDeps: {lodash: '^4.17.0'}
            },
            {
                name: 'lodash',
                version: '4.17.21',
                purl: 'pkg:npm/lodash@4.17.21',
                resolved: null,
                hashSha512Hex: null,
                license: null,
                repository: null,
                directDeps: {}
            },
            {
                name: 'awkward',
                version: '0.0.1',
                purl: 'pkg:npm/awkward@0.0.1',
                resolved: null,
                hashSha512Hex: null,
                license: '(MIT OR Apache-2.0)',
                repository: null,
                directDeps: {}
            },
            {
                name: 'commercial',
                version: '0.0.1',
                purl: 'pkg:npm/commercial@0.0.1',
                resolved: null,
                hashSha512Hex: null,
                license: 'see proprietary contract',
                repository: null,
                directDeps: {}
            }
        ]
    };
}

describe('CycloneDxBuilder.build', () => {
    const data = fixture();
    const bom = CycloneDxBuilder.build(data, '9.9.9');

    it('emits the CycloneDX 1.6 envelope with the URN serialNumber', () => {
        expect(bom.specVersion).toBe('1.6');
        expect(bom.bomFormat).toBe('CycloneDX');
        expect(bom.serialNumber).toBe(data.project.urn);
        expect(bom.metadata.timestamp).toBe(data.project.generatedAt);
        expect(bom.metadata.tools.components[0].version).toBe('9.9.9');
    });

    it('emits one component per input package with stable bom-ref', () => {
        expect(bom.components).toHaveLength(4);
        expect(bom.components[0]['bom-ref']).toBe('pkg:npm/scope/api@1.0.0');
        expect(bom.components[0].purl).toBe('pkg:npm/scope/api@1.0.0');
    });

    it('classifies license forms (id / expression / name)', () => {
        const byName = new Map(bom.components.map((c) => [c.name, c]));
        expect(byName.get('@scope/api')!.licenses).toEqual([{license: {id: 'MIT'}}]);
        expect(byName.get('awkward')!.licenses).toEqual([{expression: '(MIT OR Apache-2.0)'}]);
        expect(byName.get('commercial')!.licenses).toEqual([{license: {name: 'see proprietary contract'}}]);
        expect(byName.get('lodash')!.licenses).toBeUndefined();
    });

    it('attaches sha512 hash + externalReferences only when present', () => {
        const api = bom.components.find((c) => c.name === '@scope/api')!;
        expect(api.hashes).toEqual([{alg: 'SHA-512', content: 'abc123'}]);
        expect(api.externalReferences).toEqual([
            {type: 'distribution', url: 'https://registry.npmjs.org/@scope/api/-/api-1.0.0.tgz'},
            {type: 'vcs', url: 'git+https://github.com/scope/api.git'}
        ]);
        const lodash = bom.components.find((c) => c.name === 'lodash')!;
        expect(lodash.hashes).toBeUndefined();
        expect(lodash.externalReferences).toBeUndefined();
    });

    it('emits a dependency edge per component, resolving by name', () => {
        const edge = bom.dependencies.find((d) => d.ref === 'pkg:npm/scope/api@1.0.0')!;
        expect(edge.dependsOn).toEqual(['pkg:npm/lodash@4.17.21']);
        const leaf = bom.dependencies.find((d) => d.ref === 'pkg:npm/lodash@4.17.21')!;
        expect(leaf.dependsOn).toBeUndefined();
    });
});

describe('SpdxBuilder.build', () => {
    const data = fixture();
    const doc = SpdxBuilder.build(data, '9.9.9');

    it('emits the SPDX 2.3 envelope with the right header', () => {
        expect(doc.spdxVersion).toBe('SPDX-2.3');
        expect(doc.dataLicense).toBe('CC0-1.0');
        expect(doc.SPDXID).toBe('SPDXRef-DOCUMENT');
        expect(doc.documentNamespace).toContain(data.project.urn);
        expect(doc.creationInfo.creators[0]).toBe('Tool: nppm-9.9.9');
    });

    it('prepends a root project package + DESCRIBES relationship', () => {
        expect(doc.packages[0].SPDXID).toBe('SPDXRef-Project');
        expect(doc.relationships[0]).toEqual({
            spdxElementId: 'SPDXRef-DOCUMENT',
            relationshipType: 'DESCRIBES',
            relatedSpdxElement: 'SPDXRef-Project'
        });
    });

    it('sanitises SPDXIDs so scoped names + dots survive the spec regex', () => {
        const ids = doc.packages.map((p) => p.SPDXID);
        for (const id of ids) {
            expect(id).toMatch(/^SPDXRef-[A-Za-z0-9.+-]+$/u);
        }
        const scoped = doc.packages.find((p) => p.name === '@scope/api')!;
        expect(scoped.SPDXID).toBe('SPDXRef-scope-api-1.0.0');
    });

    it('keeps bare SPDX IDs and compound expressions; collapses garbage to NOASSERTION', () => {
        const byName = new Map(doc.packages.map((p) => [p.name, p]));
        expect(byName.get('@scope/api')!.licenseConcluded).toBe('MIT');
        expect(byName.get('awkward')!.licenseConcluded).toBe('(MIT OR Apache-2.0)');
        expect(byName.get('commercial')!.licenseConcluded).toBe('NOASSERTION');
        expect(byName.get('lodash')!.licenseConcluded).toBe('NOASSERTION');
    });

    it('uppercases sha512 checksums per spec', () => {
        const api = doc.packages.find((p) => p.name === '@scope/api')!;
        expect(api.checksums).toEqual([{algorithm: 'SHA512', checksumValue: 'ABC123'}]);
    });

    it('emits DEPENDS_ON relationships across the resolved graph', () => {
        const apiId = doc.packages.find((p) => p.name === '@scope/api')!.SPDXID;
        const lodashId = doc.packages.find((p) => p.name === 'lodash')!.SPDXID;
        const edge = doc.relationships.find((r) =>
            r.relationshipType === 'DEPENDS_ON'
            && r.spdxElementId === apiId
            && r.relatedSpdxElement === lodashId);
        expect(edge).toBeDefined();
    });

    it('emits a PURL externalRef on every non-root package', () => {
        const nonRoot = doc.packages.filter((p) => p.SPDXID !== 'SPDXRef-Project');
        for (const p of nonRoot) {
            expect(p.externalRefs).toEqual([{
                referenceCategory: 'PACKAGE-MANAGER',
                referenceType: 'purl',
                referenceLocator: expect.stringMatching(/^pkg:npm\//u) as unknown as string
            }]);
        }
    });
});