import {ApiRegistryLogEntry} from '../../shared/Api/ApiTypes.js';

/**
 * In-memory activity log for the registry proxy (step 18.6). Every
 * served request is recorded here so the RegistryView can show a live
 * request feed (store HIT vs upstream MISS vs 404) and running
 * hit/miss counters. Purely ephemeral — resets on server restart, like
 * the GitHub rate-limit guard's counters.
 *
 * A bounded ring buffer keeps the most recent entries for replay to a
 * newly-connected SSE client; live entries are pushed to every current
 * subscriber. Subscribers are plain callbacks so the controller owns
 * the actual `res` writing.
 */
export class RegistryActivity {

    private readonly _max: number;
    private _buf: ApiRegistryLogEntry[] = [];
    private _hits = 0;
    private _misses = 0;
    private readonly _subs = new Set<(entry: ApiRegistryLogEntry) => void>();

    public constructor(maxEntries = 200) {
        this._max = maxEntries;
    }

    /**
     * Record one served request. Tarball hits/misses feed the running
     * counters; every entry lands in the ring buffer and is fanned out
     * to live subscribers.
     */
    public record(entry: ApiRegistryLogEntry): void {
        if (entry.kind === 'tarball' && entry.result === 'hit') {
            this._hits++;
        } else if (entry.kind === 'tarball' && entry.result === 'miss') {
            this._misses++;
        }
        this._buf.push(entry);
        if (this._buf.length > this._max) {
            this._buf = this._buf.slice(this._buf.length - this._max);
        }
        for (const sub of this._subs) {
            sub(entry);
        }
    }

    /** Most-recent entries, oldest first. */
    public recent(): ApiRegistryLogEntry[] {
        return [...this._buf];
    }

    public counters(): {hits: number; misses: number;} {
        return {hits: this._hits, misses: this._misses};
    }

    /**
     * Subscribe to live entries. Returns an unsubscribe function the
     * SSE handler calls when the client disconnects.
     */
    public subscribe(fn: (entry: ApiRegistryLogEntry) => void): () => void {
        this._subs.add(fn);
        return (): void => {
            this._subs.delete(fn);
        };
    }

}