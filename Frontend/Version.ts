/**
 * Frontend mirror of `MatrixBuilder.cleanRange` — strips range
 * modifiers so `^1.2.3` becomes `1.2.3`, the version we can actually
 * pass to a tarball / vuln lookup. Deliberately lossy: caret/tilde
 * widening collapses to "same".
 *
 * Used by the matrix badge loader, the detail panel, and (future)
 * anywhere else that needs a concrete version out of a range.
 */
export function cleanRange(range: string): string {
    return range
        .trim()
        .replace(/^[\^~=v]+/, '')
        .replace(/^>=\s*/, '')
        .split(/\s/)[0];
}