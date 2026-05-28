import fs from 'fs';
import path from 'path';
import {
    HistoryAdded,
    HistoryBumpType,
    HistoryEntry,
    HistoryFile,
    HistoryRemoved,
    HistoryUpdate
} from './History.js';

/**
 * Optional context that lets `recordSnapshot` craft a better `reason`
 * label. Currently just the OSV-known CVEs for the *outgoing* version
 * of an updated package — if the old version had vulns and the user
 * just upgraded, the new entry's reason gets a hint that the bump
 * probably addressed it.
 */
export type HistoryReasonContext = {
    cvesForOldVersion?: (name: string, version: string) => string[]|null;
};

const VERSION_REGEX = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * Per-project history persistence. One JSON file per project in
 * `<cacheDir>/history/<safe>.json`. Files are written atomically (write
 * to temp then rename) so an interrupted save can't leave a corrupt
 * half-file behind.
 *
 * `recordSnapshot` is the only mutator: it loads the prior state,
 * diffs the new package set against it, appends an entry *only when
 * something changed*, and persists. Read-only callers use `read`.
 */
export class HistoryStore {

    private readonly _dir: string;

    constructor(dir: string) {
        this._dir = dir;
        fs.mkdirSync(dir, {recursive: true});
    }

    /**
     * Load (or initialise) the history file for one project. Returns a
     * fresh empty record when no file exists yet, so callers can treat
     * "first run" and "ongoing project" uniformly.
     */
    public read(projectKey: string, projectName: string): HistoryFile {
        const file = this._fileFor(projectKey, projectName);

        if (!fs.existsSync(file)) {
            return {projectKey, projectName, lastSnapshot: null, entries: []};
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as HistoryFile;
            // Keep the display name in sync if the user renamed the
            // project in the config — the key is what's stable.
            parsed.projectName = projectName;
            return parsed;
        } catch {
            // Corrupt file → start fresh. We don't rename/back up
            // because the only way to corrupt this file is a crash
            // mid-write, and the next snapshot will overwrite it.
            return {projectKey, projectName, lastSnapshot: null, entries: []};
        }
    }

    /**
     * Diff `currentPackages` against the stored snapshot and append a
     * new entry when at least one of (added, removed, updated) is
     * non-empty. Returns the entry that was written, or `null` when
     * nothing changed.
     *
     * Same-name-different-version pairs collapse into one `update`
     * record (not added+removed) — matching the user's mental model
     * of "the package is still there, it just bumped".
     */
    public recordSnapshot(
        projectKey: string,
        projectName: string,
        lockfileSource: string,
        currentPackages: {name: string; version: string}[],
        ctx: HistoryReasonContext = {}
    ): HistoryEntry|null {
        const state = this.read(projectKey, projectName);

        // Dedupe within the input — the lockfile lists nested installs
        // separately. We track at the (name, version) level; multiple
        // copies of the same `name@version` collapse to one.
        const currentSet = new Map<string, {name: string; version: string}>();
        for (const p of currentPackages) {
            currentSet.set(`${p.name}@${p.version}`, {name: p.name, version: p.version});
        }
        const previousSet = new Map<string, {name: string; version: string}>();
        for (const p of state.lastSnapshot?.packages ?? []) {
            previousSet.set(`${p.name}@${p.version}`, {name: p.name, version: p.version});
        }

        // Group by name so we can detect same-name-version-changed as
        // an update rather than add+remove.
        const currentByName = new Map<string, string>();
        for (const p of currentSet.values()) {
            currentByName.set(p.name, p.version);
        }
        const previousByName = new Map<string, string>();
        for (const p of previousSet.values()) {
            previousByName.set(p.name, p.version);
        }

        const added: HistoryAdded[] = [];
        const removed: HistoryRemoved[] = [];
        const updated: HistoryUpdate[] = [];

        for (const [name, version] of currentByName) {
            const prev = previousByName.get(name);
            if (prev === undefined) {
                added.push({name, version});
            } else if (prev !== version) {
                const bumpType = HistoryStore._detectBumpType(prev, version);
                const cves = ctx.cvesForOldVersion?.(name, prev) ?? null;
                updated.push({
                    name,
                    fromVersion: prev,
                    toVersion: version,
                    bumpType,
                    reason: HistoryStore._describeReason(bumpType, cves)
                });
            }
        }

        for (const [name, version] of previousByName) {
            if (!currentByName.has(name)) {
                removed.push({name, version});
            }
        }

        // First-ever snapshot is special — no prior state, so "added"
        // would otherwise list every single package and dwarf the
        // entries timeline. We *do* persist the snapshot itself (so
        // the next call has a baseline) but skip writing an entry.
        const isInitial = state.lastSnapshot === null;

        if (isInitial) {
            state.lastSnapshot = {
                timestamp: Date.now(),
                packages: Array.from(currentSet.values())
            };
            this._write(projectKey, projectName, state);
            return null;
        }

        if (added.length === 0 && removed.length === 0 && updated.length === 0) {
            return null;
        }

        // Sort each list by name so the JSON file diffs cleanly in a
        // git context (when the user inspects the cache out of band).
        added.sort((a, b) => a.name.localeCompare(b.name));
        removed.sort((a, b) => a.name.localeCompare(b.name));
        updated.sort((a, b) => a.name.localeCompare(b.name));

        const entry: HistoryEntry = {
            timestamp: Date.now(),
            lockfileSource,
            added,
            removed,
            updated
        };

        state.entries.push(entry);
        state.lastSnapshot = {
            timestamp: entry.timestamp,
            packages: Array.from(currentSet.values())
        };
        this._write(projectKey, projectName, state);
        return entry;
    }

    private _write(projectKey: string, projectName: string, state: HistoryFile): void {
        const file = this._fileFor(projectKey, projectName);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, file);
    }

    private _fileFor(projectKey: string, projectName: string): string {
        return path.join(this._dir, HistoryStore._safeFilename(projectKey, projectName));
    }

    /**
     * Render a human-readable reason from the detected bump type and
     * any OSV findings against the outgoing version. CVE hint comes
     * first because that's the question the user asks when staring
     * at an unexpected bump.
     */
    private static _describeReason(bumpType: HistoryBumpType|null, cves: string[]|null): string {
        const parts: string[] = [];

        if (cves && cves.length > 0) {
            const head = cves.slice(0, 3).join(', ');
            const suffix = cves.length > 3 ? `, +${cves.length - 3} more` : '';
            parts.push(`Old version had CVEs (${head}${suffix})`);
        }

        if (bumpType === null) {
            parts.push('Version scheme unknown');
        } else if (bumpType === 'none') {
            parts.push('Version unchanged');
        } else {
            parts.push(`${bumpType}-bump`);
        }

        return parts.join(' — ');
    }

    private static _parseTriple(v: string): [number, number, number]|null {
        const m = VERSION_REGEX.exec(v.trim());
        return m ? [+m[1], +m[2], +m[3]] : null;
    }

    private static _detectBumpType(from: string, to: string): HistoryBumpType|null {
        const a = HistoryStore._parseTriple(from);
        const b = HistoryStore._parseTriple(to);

        if (!a || !b) {
            return null;
        }

        if (b[0] !== a[0]) {
            return 'major';
        }
        if (b[1] !== a[1]) {
            return 'minor';
        }
        if (b[2] !== a[2]) {
            return 'patch';
        }
        return 'none';
    }

    /**
     * Build the on-disk filename for one project's history. Format
     * is `<sanitised-name>-<hash-of-key>.json` — the name is what the
     * user recognises in a file listing, the short hash disambiguates
     * two projects that happen to share the same name but live at
     * different keys (`local:/a/kavula` vs `local:/b/kavula`).
     */
    private static _safeFilename(key: string, name: string): string {
        const sanitised = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_') || 'project';
        // Tiny non-crypto hash so colliding names stay distinguishable.
        let h = 0;
        for (let i = 0; i < key.length; i++) {
            h = ((h << 5) - h + key.charCodeAt(i)) | 0;
        }
        const hex = (h >>> 0).toString(16).padStart(8, '0');
        return `${sanitised}-${hex}.json`;
    }
}