import {FileFingerprint} from '../Fingerprint/Fingerprint.js';

/**
 * Three-level severity for the aggregated capability set. Each
 * individual capability on its own is morally neutral (most
 * libraries read files or make HTTP calls); the dangerous part is
 * the *combination* — "spawns processes AND reaches the network
 * AND writes to the filesystem" is the textbook exfiltration shape.
 */
export enum CapabilitySeverity {
    info = 'info',
    warn = 'warn',
    risk = 'risk'
}

/**
 * Named capabilities the scanner detects. Each maps to a regex over
 * the JS source — the set is intentionally narrow (a few high-signal
 * APIs) rather than an exhaustive AST walk.
 *
 *  - `fs-read`: `fs.readFile`, `readFileSync`, `createReadStream`, …
 *  - `fs-write`: `fs.writeFile`, `appendFile`, `createWriteStream`, …
 *  - `network`: `http`/`https`/`fetch`/`got`/`axios`/`request` —
 *    anything that outbound-talks to a URL.
 *  - `raw-socket`: lower-level `net`/`dgram`/`tls.connect` — exfil
 *    via plain TCP/UDP, not the typical-library HTTP path.
 *  - `child-process`: `child_process.spawn|exec|execFile|fork` plus
 *    the `spawn` helper from `cross-spawn`/`execa` when imported.
 *  - `env-read`: `process.env.<NAME>` reads of *credential-shaped*
 *    keys (`*_TOKEN`/`*_KEY`/`*_SECRET`/`*_PASSWORD`/`AWS_*`).
 *  - `native-bindings`: requires of `.node` files or
 *    `process.dlopen` — native code is loaded at runtime.
 *  - `dynamic-import`: `new Function(...)`, `eval(...)` — code
 *    constructed at runtime. The obfuscation scanner already flags
 *    obfuscated forms; this surfaces the unadorned cases that
 *    aren't obfuscated but are still capability-relevant.
 */
export type Capability =
    | 'fs-read'
    | 'fs-write'
    | 'network'
    | 'raw-socket'
    | 'child-process'
    | 'env-read'
    | 'native-bindings'
    | 'dynamic-import';

export type CapabilityFinding = {
    severity: CapabilitySeverity;
    capabilities: Capability[];
    /** Short human-readable summary for the matrix tooltip + panel. */
    detail: string;
};

export type CapabilitySummary = {
    name: string;
    version: string;
    severity: CapabilitySeverity|null;
    count: number;
};

/**
 * Per-capability regex catalogue. Each pattern is bounded (no nested
 * quantifiers) so a giant minified bundle stays linear-time.
 */
const PATTERNS: {capability: Capability; regex: RegExp;}[] = [
    {capability: 'fs-read', regex: /\bfs\.(?:readFile|readFileSync|createReadStream|read)\b/},
    {capability: 'fs-write', regex: /\bfs\.(?:writeFile|writeFileSync|appendFile|createWriteStream|unlink|rm|rmdir|rename|chmod)\b/},
    /*
     * Network: native node modules + the four most-popular HTTP
     * libraries. The plain word `fetch` is too noisy by itself
     * (`Array.prototype.fetch` lookalikes don't exist but `.fetch(`
     * on user code does), so we require a context that pins it as a
     * top-level call or method on a known global.
     */
    {capability: 'network', regex: /\brequire\s*\(\s*['"](?:node:)?https?['"]\s*\)/},
    {capability: 'network', regex: /\bfrom\s+['"](?:node:)?https?['"]/},
    {capability: 'network', regex: /\b(?:global\.)?fetch\s*\(\s*['"`]/},
    {capability: 'network', regex: /\brequire\s*\(\s*['"](?:axios|got|node-fetch|request|superagent|undici)['"]\s*\)/},
    {capability: 'network', regex: /\bfrom\s+['"](?:axios|got|node-fetch|request|superagent|undici)['"]/},
    {capability: 'raw-socket', regex: /\brequire\s*\(\s*['"](?:node:)?(?:net|dgram|tls)['"]\s*\)/},
    {capability: 'raw-socket', regex: /\bfrom\s+['"](?:node:)?(?:net|dgram|tls)['"]/},
    {capability: 'child-process', regex: /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)/},
    {capability: 'child-process', regex: /\bfrom\s+['"](?:node:)?child_process['"]/},
    {capability: 'child-process', regex: /\b(?:spawn|exec|execFile|fork|execSync|spawnSync)\s*\(/},
    {capability: 'env-read', regex: /\bprocess\.env\.[A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_API_KEY|_PRIVATE_KEY)\b/},
    {capability: 'env-read', regex: /\bprocess\.env\.AWS_[A-Z_]+\b/},
    {capability: 'env-read', regex: /\bprocess\.env\[['"][A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_API_KEY|_PRIVATE_KEY)['"]\]/},
    {capability: 'native-bindings', regex: /\.node['"]\s*\)/},
    {capability: 'native-bindings', regex: /\bprocess\.dlopen\s*\(/},
    {capability: 'dynamic-import', regex: /\b(?:eval|new\s+Function|Function)\s*\(/}
];

/** Per-file size cap so a single mega-bundle doesn't dominate runtime. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Pure static scanner: walks the same `FileFingerprint[]` array the
 * pattern/binary/obfuscation scanners read, ORs the per-file
 * capability matches into one set per package, and rolls them up to
 * a single severity. No I/O.
 */
export class CapabilityScanner {

    public static scan(files: FileFingerprint[]): CapabilityFinding|null {
        const seen = new Set<Capability>();

        for (const f of files) {
            if (typeof f.content !== 'string' || f.content.length === 0) {
                continue;
            }
            if (f.content.length > MAX_FILE_BYTES) {
                continue;
            }
            for (const {capability, regex} of PATTERNS) {
                if (seen.has(capability)) {
                    continue;
                }
                if (regex.test(f.content)) {
                    seen.add(capability);
                }
            }
        }

        if (seen.size === 0) {
            return null;
        }

        const capabilities = [...seen];
        const severity = CapabilityScanner._severity(seen);
        return {
            severity: severity,
            capabilities: capabilities,
            detail: CapabilityScanner._summarise(capabilities)
        };
    }

    public static summarise(
        name: string,
        version: string,
        finding: CapabilityFinding|null
    ): CapabilitySummary {
        return {
            name: name,
            version: version,
            severity: finding?.severity ?? null,
            count: finding?.capabilities.length ?? 0
        };
    }

    /**
     * Severity rollup based on which *combinations* are present.
     * Individual capabilities are morally neutral; combinations are
     * what make supply-chain telemetry / exfiltration possible.
     *
     *  - `risk`: child-process + (network OR raw-socket) — the
     *    "spawn something that talks to a server" pattern.
     *  - `risk`: env-read + network — credential exfiltration.
     *  - `risk`: native-bindings + (network OR child-process) —
     *    native code with capability to phone home.
     *  - `warn`: any two of (fs-write, network, raw-socket,
     *    child-process, env-read).
     *  - `warn`: dynamic-import alone — running code constructed at
     *    runtime is a meaningful capability on its own.
     *  - `info`: single capability that isn't dynamic-import.
     */
    private static _severity(set: Set<Capability>): CapabilitySeverity {
        const has = (c: Capability): boolean => set.has(c);

        // Riskiest combos first — short-circuit on match.
        if (has('child-process') && (has('network') || has('raw-socket'))) {
            return CapabilitySeverity.risk;
        }
        if (has('env-read') && (has('network') || has('raw-socket'))) {
            return CapabilitySeverity.risk;
        }
        if (has('native-bindings') && (has('network') || has('child-process'))) {
            return CapabilitySeverity.risk;
        }

        const heavyHitters: Capability[] = [
            'fs-write', 'network', 'raw-socket', 'child-process', 'env-read'
        ];
        const heavyCount = heavyHitters.reduce((n, c) => n + (set.has(c) ? 1 : 0), 0);
        if (heavyCount >= 2) {
            return CapabilitySeverity.warn;
        }
        if (set.has('dynamic-import')) {
            return CapabilitySeverity.warn;
        }
        return CapabilitySeverity.info;
    }

    private static _summarise(capabilities: Capability[]): string {
        const labels: Record<Capability, string> = {
            'fs-read': 'fs.read',
            'fs-write': 'fs.write',
            'network': 'network',
            'raw-socket': 'net/tls socket',
            'child-process': 'child_process',
            'env-read': 'process.env reads (credential-shaped)',
            'native-bindings': 'native bindings',
            'dynamic-import': 'eval / new Function'
        };
        return capabilities.map((c) => labels[c]).join(' · ');
    }

}