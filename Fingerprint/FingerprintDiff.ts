import {FileFingerprint, FingerprintDiff, PackageFingerprint} from './Fingerprint.js';

/**
 * Compute the set difference between two package fingerprints. Files
 * are matched by `path`, so a rename shows up as one `removed` + one
 * `added` entry (this is intentional — a renamed file is suspicious in
 * a patch release for the same reasons a new file is).
 */
export function diffFingerprints(
    before: PackageFingerprint,
    after: PackageFingerprint
): FingerprintDiff {
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
    const modified: FingerprintDiff['modified'] = [];

    for (const [path, afterFile] of byPathAfter) {
        const beforeFile = byPathBefore.get(path);

        if (!beforeFile) {
            added.push(afterFile);
            continue;
        }

        if (beforeFile.sha256 !== afterFile.sha256) {
            modified.push({path, before: beforeFile, after: afterFile});
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

    return {added, removed, modified};
}