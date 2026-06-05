import path from 'path';

/**
 * Containment helper for filesystem writes that should stay inside a
 * trusted root. Every path-segment we join with the project root
 * could in principle come from API input (upgrade `workspace`,
 * template `files` keys, ...) — a `../../etc/cron.d` segment turns
 * `path.join(root, ...)` into a write to wherever the user-supplied
 * tail points.
 *
 * `join()` resolves the candidate to an absolute path, then verifies
 * the result either equals the root or sits below it. Anything else
 * throws so the calling handler returns a 500 instead of silently
 * clobbering files outside the project.
 */
export class SafePath {

    /**
     * Resolve `parts` against `root` and return the absolute path,
     * provided the result is contained by `root`. Throws otherwise.
     *
     * Both inputs go through `path.resolve` so any `..` segments are
     * collapsed before the containment check — string-level prefix
     * matching alone would miss things like `${root}-evil` accidentally
     * passing a `startsWith(root)` test.
     */
    public static join(root: string, ...parts: string[]): string {
        const normalisedRoot = path.resolve(root);
        const candidate = path.resolve(normalisedRoot, ...parts);
        if (candidate === normalisedRoot) {
            return candidate;
        }
        if (candidate.startsWith(normalisedRoot + path.sep)) {
            return candidate;
        }
        throw new Error(
            `path escapes project root: ${parts.join('/')} (resolved to ${candidate})`
        );
    }

}