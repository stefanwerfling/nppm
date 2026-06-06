import {ApiReleasesResponse} from '../../shared/Api/ApiTypes.js';
import {GitResolver} from '../Fingerprint/GitResolver.js';
import {ServerContext} from './ServerContext.js';

/**
 * Merged release timeline for one package: registry-known versions
 * plus (when the source is github.com) the matching GitHub release
 * titles / bodies. When `version` is a git URL we route to the
 * commits fetcher instead — the npm packument of the same `name`
 * belongs to an unrelated package (see the figtree / fundon
 * collision), so its releases would be misleading.
 */
export class ReleasesController {

    public static register(ctx: ServerContext): void {
        ctx.app.get('/api/releases', async(req, res): Promise<void> => {
            const name = typeof req.query.name === 'string' ? req.query.name : '';
            const version = typeof req.query.version === 'string' ? req.query.version : '';
            if (!name) {
                res.status(400).json({success: false, msg: 'name query param is required'});
                return;
            }
            if (version && GitResolver.isGitVersion(version)) {
                try {
                    const commits = await ctx.gitCommitsFetcher.fetch(version);
                    if (!commits) {
                        const empty: ApiReleasesResponse = {name: name, releases: []};
                        res.status(200).json(empty);
                        return;
                    }
                    const response: ApiReleasesResponse = {
                        name: name,
                        repository: commits.repoUrl,
                        releases: commits.commits.map((c) => ({
                            version: c.shortSha,
                            publishedAt: c.date,
                            name: c.subject,
                            url: c.url,
                            publisher: c.author ?? undefined,
                            sha: c.sha
                        }))
                    };
                    res.status(200).json(response);
                } catch (e) {
                    res.status(500).json({success: false, msg: (e as Error).message});
                }
                return;
            }
            try {
                const out = await ctx.releasesFetcher.fetch(name);
                if (!out) {
                    res.status(404).json({success: false, msg: `Unknown package ${name}`});
                    return;
                }
                const response: ApiReleasesResponse = out;
                res.status(200).json(response);
            } catch (e) {
                res.status(500).json({success: false, msg: (e as Error).message});
            }
        });
    }

}