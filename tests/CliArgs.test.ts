import {describe, expect, it} from 'vitest';
import {CliArgsError, FailOnLevel, parseCliArgs} from '../Cli/CliArgs.js';

describe('parseCliArgs', () => {
    it('returns defaults for an empty argv', () => {
        const args = parseCliArgs([]);
        expect(args.configPath).toBe('nppm.json');
        expect(args.projects).toEqual([]);
        expect(args.json).toBe(false);
        expect(args.sarif).toBe(false);
        expect(args.failOn).toBe(FailOnLevel.risk);
        expect(args.runOsv).toBe(true);
        expect(args.runHeuristics).toBe(true);
        expect(args.runUnused).toBe(true);
        expect(args.concurrency).toBe(10);
        expect(args.help).toBe(false);
    });

    it('flips --sarif independently of --json', () => {
        expect(parseCliArgs(['--sarif']).sarif).toBe(true);
        expect(parseCliArgs(['--sarif']).json).toBe(false);
    });

    it('rejects --json and --sarif passed together', () => {
        expect(() => parseCliArgs(['--json', '--sarif'])).toThrow(/mutually exclusive/);
    });

    it('accepts both `--key=value` and `--key value` forms', () => {
        const a = parseCliArgs(['--config=other.json', '--fail-on', 'warn']);
        expect(a.configPath).toBe('other.json');
        expect(a.failOn).toBe(FailOnLevel.warn);
    });

    it('collects repeated --project flags', () => {
        const a = parseCliArgs(['--project=alpha', '--project', 'beta']);
        expect(a.projects).toEqual(['alpha', 'beta']);
    });

    it('toggles the three `--no-*` flags', () => {
        const a = parseCliArgs(['--no-osv', '--no-heuristics', '--no-unused']);
        expect(a.runOsv).toBe(false);
        expect(a.runHeuristics).toBe(false);
        expect(a.runUnused).toBe(false);
    });

    it('flags `--help` short and long', () => {
        expect(parseCliArgs(['-h']).help).toBe(true);
        expect(parseCliArgs(['--help']).help).toBe(true);
    });

    it('rejects unknown flags', () => {
        expect(() => parseCliArgs(['--bogus'])).toThrow(CliArgsError);
    });

    it('rejects an unexpected positional', () => {
        expect(() => parseCliArgs(['something'])).toThrow(CliArgsError);
    });

    it('rejects an invalid --fail-on value', () => {
        expect(() => parseCliArgs(['--fail-on=catastrophe'])).toThrow(/Invalid --fail-on/);
    });

    it('rejects a non-numeric --concurrency value', () => {
        expect(() => parseCliArgs(['--concurrency=abc'])).toThrow(/positive integer/);
    });

    it('rejects --concurrency 0', () => {
        expect(() => parseCliArgs(['--concurrency=0'])).toThrow(/positive integer/);
    });

    it('rejects a flag with no value', () => {
        expect(() => parseCliArgs(['--config'])).toThrow(/Missing value/);
    });
});