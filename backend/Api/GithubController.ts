import {ApiGithubRateLimitResponse} from '../../shared/Api/ApiTypes.js';
import {GithubRateLimitGuard} from '../Github/GithubRateLimitGuard.js';
import {ServerContext} from './ServerContext.js';

/**
 * Surfaces the in-memory `GithubRateLimitGuard` state to the frontend
 * topbar pill. One route today; future routes for cross-host quota
 * stats land here too.
 *
 * The response is intentionally never cached on disk — the guard
 * state lives only in memory for the lifetime of the dev server, and
 * each window is at most an hour; the frontend polls every 30s and
 * gets the live numbers.
 */
export class GithubController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/github/ratelimit', (_req, res): void => {
            const response: ApiGithubRateLimitResponse = {
                hosts: GithubRateLimitGuard.snapshot()
            };
            res.status(200).json(response);
        });
    }

}