import {describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {CommitsHttpFetcher, GitCommitsFetcher} from '../Releases/GitCommitsFetcher.js';

function stubHttp(map: Record<string, {ok: boolean; status: number; body: unknown}>): CommitsHttpFetcher {
    return {
        async fetch(url) {
            if (!(url in map)) {
                throw new Error(`unexpected fetch ${url}`);
            }
            const e = map[url];
            return {ok: e.ok, status: e.status, statusText: 'stub', body: e.body};
        }
    };
}

describe('GitCommitsFetcher', () => {
    it('maps a GitHub commit list to GitCommit rows', async () => {
        const sha = '0123456789abcdef0123456789abcdef01234567';
        const http = stubHttp({
            'https://api.github.com/repos/stefanwerfling/figtree/commits?per_page=50': {
                ok: true, status: 200, body: [
                    {
                        sha,
                        html_url: `https://github.com/stefanwerfling/figtree/commit/${sha}`,
                        commit: {
                            message: 'Add health endpoint\n\nBody text',
                            author: {name: 'Stefan', email: 'stefan@example.com', date: '2026-06-04T08:30:00Z'}
                        },
                        author: {login: 'stefanwerfling'}
                    }
                ]
            }
        });
        const fetcher = new GitCommitsFetcher(null, {http});
        const resp = await fetcher.fetch('git+https://github.com/stefanwerfling/figtree.git');
        expect(resp).not.toBeNull();
        expect(resp!.host).toBe('github');
        expect(resp!.commits).toHaveLength(1);
        const c = resp!.commits[0];
        expect(c.sha).toBe(sha);
        expect(c.shortSha).toBe(sha.slice(0, 7));
        expect(c.subject).toBe('Add health endpoint');
        expect(c.author).toBe('stefanwerfling');
        expect(c.date).toBe('2026-06-04T08:30:00Z');
    });

    it('forwards the GH token as a Bearer header when configured', async () => {
        let seenHeaders: Record<string, string> = {};
        const http: CommitsHttpFetcher = {
            async fetch(_url, headers) {
                seenHeaders = headers;
                return {ok: true, status: 200, statusText: 'ok', body: []};
            }
        };
        const fetcher = new GitCommitsFetcher(null, {http, githubToken: 't0k3n'});
        await fetcher.fetch('git+https://github.com/o/r.git');
        expect(seenHeaders.Authorization).toBe('Bearer t0k3n');
    });

    it('routes a gitea-host URL to the gitea v1 commits endpoint with the per-instance token', async () => {
        const sha = 'feedface'.padEnd(40, '0');
        let seenAuth: string|undefined;
        const http: CommitsHttpFetcher = {
            async fetch(url, headers) {
                expect(url).toBe('https://gitea.example.com/api/v1/repos/o/r/commits?limit=50');
                seenAuth = headers.Authorization;
                return {ok: true, status: 200, statusText: 'ok', body: [
                    {
                        sha,
                        html_url: `https://gitea.example.com/o/r/commit/${sha}`,
                        created: '2026-06-04T09:00:00Z',
                        commit: {
                            message: 'Update deps',
                            author: {name: 'gitea-bot', email: 'bot@example.com', date: '2026-06-04T09:00:00Z'}
                        },
                        author: {login: 'gitea-bot'}
                    }
                ]};
            }
        };
        const giteaTokens = new Map([['gitea.example.com', 'gitea-tok']]);
        const fetcher = new GitCommitsFetcher(null, {
            http,
            giteaHosts: ['gitea.example.com'],
            giteaTokens
        });
        const resp = await fetcher.fetch('git+https://gitea.example.com/o/r.git');
        expect(seenAuth).toBe('token gitea-tok');
        expect(resp?.host).toBe('gitea');
        expect(resp?.commits[0].subject).toBe('Update deps');
    });

    it('returns null for hosts we do not (yet) support', async () => {
        let called = false;
        const http: CommitsHttpFetcher = {
            async fetch() {
                called = true;
                return {ok: true, status: 200, statusText: 'ok', body: []};
            }
        };
        const fetcher = new GitCommitsFetcher(null, {http});
        const resp = await fetcher.fetch('git+https://gitlab.com/o/r.git');
        expect(resp).toBeNull();
        expect(called).toBe(false);
    });

    it('caches successful responses and serves a second call from the pocket', async () => {
        let n = 0;
        const http: CommitsHttpFetcher = {
            async fetch() {
                n++;
                return {ok: true, status: 200, statusText: 'ok', body: []};
            }
        };
        const cache = new JsonCache('/tmp/nppm-gitcommits-' + Math.random().toString(36).slice(2), 60);
        const fetcher = new GitCommitsFetcher(cache, {http});
        await fetcher.fetch('git+https://github.com/o/r.git');
        await fetcher.fetch('git+https://github.com/o/r.git');
        expect(n).toBe(1);
    });
});