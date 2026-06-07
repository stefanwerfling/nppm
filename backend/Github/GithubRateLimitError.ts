/**
 * Thrown by `GithubRateLimitGuard.fetch` when a host is in active
 * cool-down. The `resetAt` epoch-ms field lets the caller surface a
 * "back in N minutes" message; `host` lets the caller distinguish
 * api.github.com from gitea.example.com when both are configured.
 */
export class GithubRateLimitError extends Error {

    public readonly host: string;
    public readonly resetAt: number;

    public constructor(host: string, resetAt: number) {
        const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
        super(`Rate limit reached on ${host}; resets in ~${minutes} min`);
        this.host = host;
        this.resetAt = resetAt;
    }

}