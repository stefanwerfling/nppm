/**
 * Frontend mirror of `MatrixBuilder.cleanRange`. Same algorithm,
 * duplicated on the client side because the matrix badge loader and
 * the detail panel both run in the browser and can't reach into the
 * backend module.
 */
export class Version {

    /**
     * Strip range modifiers (`^`, `~`, `>=`, `=`, leading `v`,
     * whitespace) so `^1.2.3` becomes `1.2.3`, the version we can
     * actually pass to a tarball / vuln lookup. Deliberately lossy:
     * caret/tilde widening collapses to "same".
     */
    public static cleanRange(range: string): string {
        return range
        .trim()
        .replace(/^[\^~=v]+/u, '')
        .replace(/^>=\s*/u, '')
        .split(/\s/u)[0];
    }

}