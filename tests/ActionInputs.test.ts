import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ActionRunner} from '../cli/Action.js';

describe('readInputs', () => {
    it('returns defaults when no INPUT_ env vars are set', () => {
        const i = ActionRunner.readInputs({});
        expect(i.failOn).toBe('risk');
        expect(i.sarifOutput).toBe('nppm.sarif');
        expect(i.prComment).toBe(true);
        expect(i.configPath).toBeUndefined();
        expect(i.githubToken).toBeUndefined();
    });

    it('reads INPUT_* env vars with GitHub Actions kebab→snake mapping', () => {
        const i = ActionRunner.readInputs({
            INPUT_FAIL_ON: 'warn',
            INPUT_SARIF_OUTPUT: 'out/x.sarif',
            INPUT_PR_COMMENT: 'true',
            INPUT_CONFIG_PATH: 'subdir/nppm.json',
            INPUT_GITHUB_TOKEN: 'tok'
        });
        expect(i.failOn).toBe('warn');
        expect(i.sarifOutput).toBe('out/x.sarif');
        expect(i.configPath).toBe('subdir/nppm.json');
        expect(i.githubToken).toBe('tok');
    });

    it('treats INPUT_PR_COMMENT=false as opt-out', () => {
        const i = ActionRunner.readInputs({INPUT_PR_COMMENT: 'false'});
        expect(i.prComment).toBe(false);
    });

    it('treats empty INPUT_ strings as absent (GitHub Actions sends empties for unfilled inputs)', () => {
        const i = ActionRunner.readInputs({INPUT_CONFIG_PATH: '', INPUT_GITHUB_TOKEN: ''});
        expect(i.configPath).toBeUndefined();
        expect(i.githubToken).toBeUndefined();
    });
});

describe('readPrContext', () => {
    let dir: string;
    let evtPath: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nppm-ctx-'));
        evtPath = path.join(dir, 'event.json');
    });

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('returns null when the event is not a pull request', () => {
        expect(ActionRunner.readPrContext({GITHUB_EVENT_NAME: 'push'})).toBeNull();
    });

    it('parses a pull_request event payload', () => {
        fs.writeFileSync(evtPath, JSON.stringify({
            pull_request: {
                number: 42,
                base: {ref: 'main'},
                head: {sha: 'abc1234'}
            },
            repository: {full_name: 'octocat/hello'}
        }));
        const ctx = ActionRunner.readPrContext({
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: evtPath
        });
        expect(ctx).not.toBeNull();
        expect(ctx!.repo).toBe('octocat/hello');
        expect(ctx!.number).toBe(42);
        expect(ctx!.baseRef).toBe('main');
        expect(ctx!.headSha).toBe('abc1234');
    });

    it('also accepts the pull_request_target trigger', () => {
        fs.writeFileSync(evtPath, JSON.stringify({
            pull_request: {number: 7, base: {ref: 'dev'}, head: {sha: 's'}},
            repository: {full_name: 'a/b'}
        }));
        const ctx = ActionRunner.readPrContext({
            GITHUB_EVENT_NAME: 'pull_request_target',
            GITHUB_EVENT_PATH: evtPath
        });
        expect(ctx).not.toBeNull();
    });

    it('returns null on malformed JSON', () => {
        fs.writeFileSync(evtPath, '{not json');
        expect(ActionRunner.readPrContext({
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: evtPath
        })).toBeNull();
    });

    it('falls back to GITHUB_REPOSITORY when the payload omits the repo block', () => {
        fs.writeFileSync(evtPath, JSON.stringify({
            pull_request: {number: 1, base: {ref: 'main'}, head: {sha: 'x'}}
        }));
        const ctx = ActionRunner.readPrContext({
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: evtPath,
            GITHUB_REPOSITORY: 'fallback/repo'
        });
        expect(ctx?.repo).toBe('fallback/repo');
    });
});