/**
 * Package URL (PURL) encoder for npm packages. PURL is the
 * cross-format identifier both CycloneDX and SPDX consume as the
 * canonical key for "this is npm package X at version Y".
 *
 * Spec: https://github.com/package-url/purl-spec
 *
 * For npm the form is:
 *  - unscoped:  `pkg:npm/<name>@<version>`
 *  - scoped:    `pkg:npm/<scope>/<name>@<version>` (scope kept lowercase
 *               and *without* the leading `@`)
 *
 * The version segment is percent-encoded so a range-style string
 * (`^1.0.0`, `git+https://...`) round-trips unambiguously through a
 * URL. Names are lowercased per the PURL npm convention.
 */
export class Purl {

    public static npm(name: string, version: string): string {
        const lower = name.toLowerCase();
        let path: string;
        if (lower.startsWith('@')) {
            const slash = lower.indexOf('/');
            if (slash < 0) {
                /*
                 * Malformed scoped name — treat as a single segment so
                 * the result is still a parseable PURL (callers can spot
                 * the weird shape from the missing slash).
                 */
                path = encodeURIComponent(lower);
            } else {
                const scope = lower.slice(1, slash);
                const pkg = lower.slice(slash + 1);
                path = `${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}`;
            }
        } else {
            path = encodeURIComponent(lower);
        }
        return `pkg:npm/${path}@${encodeURIComponent(version)}`;
    }

}