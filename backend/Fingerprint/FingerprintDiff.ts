import {FileFingerprint, FingerprintDiff as FingerprintDiffResult, PackageFingerprint} from './Fingerprint.js';

/**
 * Comparator for two `PackageFingerprint`s. Named `FingerprintDiffer`
 * (not `FingerprintDiff`) so the existing `FingerprintDiff` *type* in
 * `Fingerprint.ts` keeps its name — too many call sites already use
 * the type identifier.
 */
export class FingerprintDiffer {

    /**
     * Compute the set difference between two package fingerprints.
     * Files are matched by `path`, so a rename shows up as one
     * `removed` + one `added` entry (intentional — a renamed file is
     * suspicious in a patch release for the same reasons a new file
     * is).
     */
    public static diff(
        before: PackageFingerprint,
        after: PackageFingerprint
    ): FingerprintDiffResult {
        const byPathBefore = new Map<string, FileFingerprint>();
        for (const f of before.files) {
            byPathBefore.set(f.path, f);
        }

        const byPathAfter = new Map<string, FileFingerprint>();
        for (const f of after.files) {
            byPathAfter.set(f.path, f);
        }

        const added: FileFingerprint[] = [];
        const removed: FileFingerprint[] = [];
        const modified: FingerprintDiffResult['modified'] = [];

        for (const [path, afterFile] of byPathAfter) {
            const beforeFile = byPathBefore.get(path);

            if (!beforeFile) {
                added.push(afterFile);
                continue;
            }

            if (beforeFile.sha256 !== afterFile.sha256) {
                modified.push({path: path, before: beforeFile, after: afterFile});
            }
        }

        for (const [path, beforeFile] of byPathBefore) {
            if (!byPathAfter.has(path)) {
                removed.push(beforeFile);
            }
        }

        added.sort((a, b) => a.path.localeCompare(b.path));
        removed.sort((a, b) => a.path.localeCompare(b.path));
        modified.sort((a, b) => a.path.localeCompare(b.path));

        return {added: added, removed: removed, modified: modified};
    }

}