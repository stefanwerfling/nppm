import {DependencyType} from '../Project/PackageManifest.js';

/**
 * Maps `ApiUpgradeRequest.depType` → `package.json` property name.
 * `peerDependencies`/`optionalDependencies`/`devDependencies` are the
 * standard npm buckets; anything else is rejected upstream.
 */
const DEP_BUCKETS: Record<string, string> = {
    [DependencyType.dependency]: 'dependencies',
    [DependencyType.dev]: 'devDependencies',
    [DependencyType.peer]: 'peerDependencies',
    [DependencyType.optional]: 'optionalDependencies'
};

/**
 * Outcome of a surgical edit. `changed` is `false` when the requested
 * dep wasn't found in the named bucket — the caller surfaces that as
 * a precondition failure, not a 500.
 */
export type EditResult = {
    changed: boolean;
    before: string;
    after: string;
};

/**
 * Minimal `package.json` editor that bumps one dep's range in a single
 * named bucket while preserving the user's formatting. Strategy: parse
 * → mutate → serialise with `JSON.stringify(obj, null, indent)` where
 * `indent` is detected from the file (the same trick npm itself uses
 * on `npm install --save`). Property order is preserved by V8 for
 * string keys, so the round-trip leaves everything else untouched.
 *
 * No comments / trailing commas / JSON5 support — the npm
 * `package.json` spec is strict JSON and that's what we round-trip.
 */
export class PackageJsonEditor {

    /**
     * Apply the bump. Returns the original + rewritten file contents
     * so the caller can show a diff or hand them to a writer. Does not
     * touch disk.
     */
    public static apply(
        source: string,
        depType: string,
        name: string,
        toRange: string
    ): EditResult {
        const bucket = DEP_BUCKETS[depType];
        if (!bucket) {
            throw new Error(`PackageJsonEditor: unknown depType "${depType}"`);
        }

        const parsed = JSON.parse(source) as Record<string, unknown>;
        const deps = parsed[bucket];
        if (!deps || typeof deps !== 'object') {
            return {changed: false, before: source, after: source};
        }
        const depsObj = deps as Record<string, string>;
        if (!Object.prototype.hasOwnProperty.call(depsObj, name)) {
            return {changed: false, before: source, after: source};
        }
        if (depsObj[name] === toRange) {
            return {changed: false, before: source, after: source};
        }

        depsObj[name] = toRange;
        const indent = PackageJsonEditor._detectIndent(source);
        const trailing = source.endsWith('\n') ? '\n' : '';
        const after = JSON.stringify(parsed, null, indent) + trailing;
        return {changed: true, before: source, after};
    }

    /**
     * Look at the first indented property and infer the indent unit.
     * npm-style: two spaces is the convention but the user might run
     * tabs or four spaces. We bias toward preserving what we see.
     * Falls back to two spaces when nothing matches.
     */
    private static _detectIndent(source: string): string|number {
        const m = /^(\s+)"[^"]+"\s*:/m.exec(source);
        if (!m) {
            return 2;
        }
        const lead = m[1];
        if (lead.startsWith('\t')) {
            return '\t';
        }
        // Number of spaces in the first indented line.
        return lead.length;
    }

    /**
     * Look up the *current* range for a name in a named bucket.
     * Returns `null` when the dep / bucket is missing. Used by the
     * preview endpoint to sanity-check the request against the
     * frontend's view of the world (frontend may be stale).
     */
    public static currentRange(source: string, depType: string, name: string): string|null {
        const bucket = DEP_BUCKETS[depType];
        if (!bucket) {
            return null;
        }
        try {
            const parsed = JSON.parse(source) as Record<string, unknown>;
            const deps = parsed[bucket];
            if (!deps || typeof deps !== 'object') {
                return null;
            }
            const depsObj = deps as Record<string, string>;
            return Object.prototype.hasOwnProperty.call(depsObj, name) ? depsObj[name] : null;
        } catch {
            return null;
        }
    }
}