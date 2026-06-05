import {describe, expect, it} from 'vitest';
import {GithubClient} from '../cli/GithubClient.js';
import {STICKY_MARKER} from '../cli/ActionFormat.js';

/**
 * Lightweight fetch double — captures every request and returns a
 * canned response per URL. Each entry is matched by URL substring +
 * method so the test can answer different things for the
 * list-comments GET and the patch / post.
 */
type Cap = {url: string; method: string; headers: Headers; body: string|null;};

function fetchDouble(
    routes: {match: (url: string, init?: RequestInit) => boolean; body: unknown; status?: number;}[]
): {fetchFn: typeof fetch; calls: Cap[];} {
    const calls: Cap[] = [];
    const fetchFn = (async(input: RequestInfo|URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        calls.push({
            url: url, method: method,
            headers: new Headers(init?.headers as HeadersInit ?? {}),
            body: typeof init?.body === 'string' ? init.body : null
        });
        const route = routes.find((r) => r.match(url, init));
        const status = route?.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status: status,
            statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
            json: async() => route?.body ?? {}
        } as unknown as Response;
    }) as typeof fetch;
    return {fetchFn: fetchFn, calls: calls};
}

describe('GithubClient.upsertStickyComment', () => {
    it('posts a fresh comment when no marker is found', async() => {
        const {fetchFn, calls} = fetchDouble([
            {match: (u, i) => u.includes('/comments') && (i?.method ?? 'GET') === 'GET',
                body: [{id: 1, body: 'unrelated comment'}]},
            {match: (u, i) => u.endsWith('/comments') && i?.method === 'POST',
                body: {id: 999}, status: 201}
        ]);
        const client = new GithubClient({token: 't', repo: 'o/r', fetch: fetchFn});
        const id = await client.upsertStickyComment(42, `${STICKY_MARKER}\nhello`);
        expect(id).toBe(999);
        // GET first, then POST.
        expect(calls[0].method).toBe('GET');
        expect(calls[1].method).toBe('POST');
        expect(calls[1].body).toContain(STICKY_MARKER);
    });

    it('patches an existing sticky comment in place', async() => {
        const {fetchFn, calls} = fetchDouble([
            {match: (u, i) => u.includes('/comments') && (i?.method ?? 'GET') === 'GET',
                body: [
                    {id: 17, body: 'unrelated'},
                    {id: 42, body: `${STICKY_MARKER}\nold body`}
                ]},
            {match: (u, i) => u.includes('/comments/42') && i?.method === 'PATCH',
                body: {id: 42}}
        ]);
        const client = new GithubClient({token: 't', repo: 'o/r', fetch: fetchFn});
        const id = await client.upsertStickyComment(42, `${STICKY_MARKER}\nnew body`);
        expect(id).toBe(42);
        // GET then PATCH (no POST).
        expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch?.body).toContain('new body');
    });

    it('returns null when the list endpoint refuses', async() => {
        const {fetchFn} = fetchDouble([
            {match: () => true, body: {}, status: 401}
        ]);
        const client = new GithubClient({token: 't', repo: 'o/r', fetch: fetchFn});
        // No previous comment found → tries POST, which is also 401 here.
        const id = await client.upsertStickyComment(42, 'x');
        expect(id).toBeNull();
    });

    it('sends Bearer auth + correct API version headers', async() => {
        const {fetchFn, calls} = fetchDouble([
            {match: () => true, body: []}
        ]);
        const client = new GithubClient({token: 'super-secret', repo: 'o/r', fetch: fetchFn});
        await client.upsertStickyComment(1, 'body');
        const headers = calls[0].headers;
        expect(headers.get('Authorization')).toBe('Bearer super-secret');
        expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
        expect(headers.get('Accept')).toBe('application/vnd.github+json');
    });
});