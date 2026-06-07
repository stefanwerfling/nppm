import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GithubRateLimitError} from '../backend/Github/GithubRateLimitError.js';
import {GithubRateLimitGuard} from '../backend/Github/GithubRateLimitGuard.js';

function mkResponse(opts: {
    status?: number;
    remaining?: number|null;
    reset?: number|null;
}): Response {
    const headers = new Headers();
    if (opts.remaining !== undefined && opts.remaining !== null) {
        headers.set('x-ratelimit-remaining', String(opts.remaining));
    }
    if (opts.reset !== undefined && opts.reset !== null) {
        headers.set('x-ratelimit-reset', String(opts.reset));
    }
    return new Response(null, {status: opts.status ?? 200, headers: headers});
}

describe('GithubRateLimitGuard', () => {
    const HOST = 'api.github.com';

    beforeEach(() => {
        GithubRateLimitGuard._resetForTest();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-07T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('canRequest=true when nothing was observed', () => {
        expect(GithubRateLimitGuard.canRequest(HOST)).toBe(true);
        expect(GithubRateLimitGuard.cooldownUntil(HOST)).toBeNull();
    });

    it('parses X-RateLimit headers and tracks remaining', () => {
        const resetSec = Math.floor(Date.now() / 1000) + 600;
        GithubRateLimitGuard.observe(HOST, mkResponse({remaining: 42, reset: resetSec}));
        expect(GithubRateLimitGuard.canRequest(HOST)).toBe(true);
        expect(GithubRateLimitGuard.cooldownUntil(HOST)).toBeNull();
    });

    it('flips to canRequest=false when remaining hits 0 and reset is in the future', () => {
        const resetSec = Math.floor(Date.now() / 1000) + 600;
        GithubRateLimitGuard.observe(HOST, mkResponse({status: 403, remaining: 0, reset: resetSec}));
        expect(GithubRateLimitGuard.canRequest(HOST)).toBe(false);
        expect(GithubRateLimitGuard.cooldownUntil(HOST)).toBe(resetSec * 1000);
    });

    it('emits the depletion warn exactly once per window', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const resetSec = Math.floor(Date.now() / 1000) + 600;
        GithubRateLimitGuard.observe(HOST, mkResponse({status: 403, remaining: 0, reset: resetSec}));
        GithubRateLimitGuard.observe(HOST, mkResponse({status: 403, remaining: 0, reset: resetSec}));
        GithubRateLimitGuard.observe(HOST, mkResponse({status: 403, remaining: 0, reset: resetSec}));
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/api\.github\.com rate-limit exhausted/u);
    });

    it('lifts the cool-down automatically once the reset epoch passes', () => {
        const resetSec = Math.floor(Date.now() / 1000) + 60;
        GithubRateLimitGuard.observe(HOST, mkResponse({status: 403, remaining: 0, reset: resetSec}));
        expect(GithubRateLimitGuard.canRequest(HOST)).toBe(false);
        vi.advanceTimersByTime(61_000);
        expect(GithubRateLimitGuard.canRequest(HOST)).toBe(true);
        expect(GithubRateLimitGuard.cooldownUntil(HOST)).toBeNull();
    });

    it('observe() is a no-op when headers are missing or unparseable', () => {
        GithubRateLimitGuard.observe(HOST, mkResponse({}));
        GithubRateLimitGuard.observe(HOST, new Response(null, {
            status: 200,
            headers: {'x-ratelimit-remaining': 'lol', 'x-ratelimit-reset': 'nope'}
        }));
        expect(GithubRateLimitGuard.canRequest(HOST)).toBe(true);
    });

    it('keeps per-host state independent', () => {
        const resetSec = Math.floor(Date.now() / 1000) + 600;
        GithubRateLimitGuard.observe('api.github.com', mkResponse({status: 403, remaining: 0, reset: resetSec}));
        expect(GithubRateLimitGuard.canRequest('api.github.com')).toBe(false);
        expect(GithubRateLimitGuard.canRequest('gitea.example.com')).toBe(true);
    });

    it('fetch() short-circuits with GithubRateLimitError when cool-down is active', async() => {
        const resetSec = Math.floor(Date.now() / 1000) + 600;
        GithubRateLimitGuard.observe(HOST, mkResponse({status: 403, remaining: 0, reset: resetSec}));

        const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(mkResponse({status: 200, remaining: 100, reset: resetSec}));
        await expect(GithubRateLimitGuard.fetch(HOST, 'https://api.github.com/x'))
        .rejects.toBeInstanceOf(GithubRateLimitError);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetch() runs the underlying call and records headers on success', async() => {
        const resetSec = Math.floor(Date.now() / 1000) + 600;
        vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(mkResponse({status: 200, remaining: 3, reset: resetSec}));
        const res = await GithubRateLimitGuard.fetch(HOST, 'https://api.github.com/x');
        expect(res.status).toBe(200);
        expect(GithubRateLimitGuard.canRequest(HOST)).toBe(true);

        // The next call should still be allowed and observe headers
        vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(mkResponse({status: 403, remaining: 0, reset: resetSec}));
        await GithubRateLimitGuard.fetch(HOST, 'https://api.github.com/y');
        expect(GithubRateLimitGuard.canRequest(HOST)).toBe(false);
    });

    it('GithubRateLimitError carries host + resetAt for the UI', () => {
        const resetAt = Date.now() + 600_000;
        const err = new GithubRateLimitError('api.github.com', resetAt);
        expect(err.host).toBe('api.github.com');
        expect(err.resetAt).toBe(resetAt);
        expect(err.message).toMatch(/Rate limit reached on api\.github\.com/u);
    });
});