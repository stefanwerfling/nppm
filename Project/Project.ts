import {ConfigProjectType} from '../Config/Config.js';
import {Lockfile} from './Lockfile.js';
import {PackageManifest} from './PackageManifest.js';

/**
 * Common interface every project source implements. The backend collects
 * all configured projects behind this so API routes do not need to know
 * whether the data came from disk, GitHub, or Gitea.
 */
export interface Project {

    /**
     * Stable display name for the UI. Falls back to a derived value
     * (directory basename, repo slug, …) when the config did not set
     * one.
     */
    getName(): string;

    /**
     * Identifier the server uses to key persistent per-project state
     * (history, future caches) by. Must be stable across server
     * restarts and unaffected by the user renaming the project in the
     * config — typically the resolved absolute path for local projects
     * and the repo URL for remote ones.
     */
    getKey(): string;

    /**
     * Source kind from the config — used by the frontend to group the
     * treeview.
     */
    getType(): ConfigProjectType;

    /**
     * Returns every parsed manifest belonging to this project: the root
     * package.json plus one entry per resolved workspace. Errors during
     * parsing should reject so the API layer can surface a per-project
     * error state.
     */
    loadManifests(): Promise<PackageManifest[]>;

    /**
     * Returns the parsed `package-lock.json` for this project, or `null`
     * when no lockfile is present (libraries without committed locks,
     * remote projects we can't reach efficiently, etc). Rejects only on
     * a *broken* lockfile so callers can distinguish "no lockfile" from
     * "couldn't read".
     */
    loadLockfile(): Promise<Lockfile|null>;

    /**
     * Hidden projects stay in the treeview (so per-project drill-down
     * keeps working) but are excluded from the cross-project matrix.
     * Persisted as `hidden: true` in nppm.json.
     */
    isHidden(): boolean;

    /** In-memory flip; the route handler also writes through to nppm.json. */
    setHidden(hidden: boolean): void;

    /**
     * Index of this project's entry in `nppm.json`'s `projects` array.
     * Used by the visibility / edit routes to address the right config
     * row when writing back. `-1` for projects that bypassed the loader
     * (test harnesses).
     */
    getConfigIndex(): number;

    /**
     * Ordered list of template ids the project is bound to. The
     * Templates compliance checker resolves these against the
     * loaded catalogue (later entries override earlier ones on
     * conflict). Empty when the project hasn't opted into any
     * template.
     */
    getTemplates(): string[];
}