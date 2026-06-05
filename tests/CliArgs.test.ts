import {describe, expect, it} from 'vitest';
import {CliArgsError, FailOnLevel, CliArgsParser} from '../cli/CliArgs.js';

describe('CliArgsParser', () => {
    it('returns defaults for an empty argv', () => {
        const args = CliArgsParser.parse([]);
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
        expect(CliArgsParser.parse(['--sarif']).sarif).toBe(true);
        expect(CliArgsParser.parse(['--sarif']).json).toBe(false);
    });

    it('rejects --json and --sarif passed together', () => {
        expect(() => CliArgsParser.parse(['--json', '--sarif'])).toThrow(/mutually exclusive/);
    });

    it('accepts both `--key=value` and `--key value` forms', () => {
        const a = CliArgsParser.parse(['--config=other.json', '--fail-on', 'warn']);
        expect(a.configPath).toBe('other.json');
        expect(a.failOn).toBe(FailOnLevel.warn);
    });

    it('collects repeated --project flags', () => {
        const a = CliArgsParser.parse(['--project=alpha', '--project', 'beta']);
        expect(a.projects).toEqual(['alpha', 'beta']);
    });

    it('toggles the three `--no-*` flags', () => {
        const a = CliArgsParser.parse(['--no-osv', '--no-heuristics', '--no-unused']);
        expect(a.runOsv).toBe(false);
        expect(a.runHeuristics).toBe(false);
        expect(a.runUnused).toBe(false);
    });

    it('flags `--help` short and long', () => {
        expect(CliArgsParser.parse(['-h']).help).toBe(true);
        expect(CliArgsParser.parse(['--help']).help).toBe(true);
    });

    it('rejects unknown flags', () => {
        expect(() => CliArgsParser.parse(['--bogus'])).toThrow(CliArgsError);
    });

    it('rejects an unexpected positional', () => {
        expect(() => CliArgsParser.parse(['something'])).toThrow(CliArgsError);
    });

    it('rejects an invalid --fail-on value', () => {
        expect(() => CliArgsParser.parse(['--fail-on=catastrophe'])).toThrow(/Invalid --fail-on/);
    });

    it('rejects a non-numeric --concurrency value', () => {
        expect(() => CliArgsParser.parse(['--concurrency=abc'])).toThrow(/positive integer/);
    });

    it('rejects --concurrency 0', () => {
        expect(() => CliArgsParser.parse(['--concurrency=0'])).toThrow(/positive integer/);
    });

    it('rejects a flag with no value', () => {
        expect(() => CliArgsParser.parse(['--config'])).toThrow(/Missing value/);
    });
});