import {describe, expect, it} from 'vitest';
import {CliArgsError} from '../cli/CliArgs.js';
import {CardRunner, CARD_HELP_TEXT, RunCardIO} from '../cli/Card.js';

describe('CardRunner._parse — argv parser', () => {

    it('returns defaults for an empty argv', () => {
        const a = CardRunner._parse([]);
        expect(a.configPath).toBe('nppm.json');
        expect(a.projects).toEqual([]);
        expect(a.output).toBe('nppm-card.svg');
        expect(a.toStdout).toBe(false);
        expect(a.title).toBeNull();
        expect(a.runOsv).toBe(true);
        expect(a.runHeuristics).toBe(true);
        expect(a.runUnused).toBe(true);
        expect(a.runExternal).toBe(true);
        expect(a.concurrency).toBe(10);
        expect(a.help).toBe(false);
    });

    it('honours -o and --output equally', () => {
        expect(CardRunner._parse(['-o', 'card.svg']).output).toBe('card.svg');
        expect(CardRunner._parse(['--output=card.svg']).output).toBe('card.svg');
        expect(CardRunner._parse(['--output', 'card.svg']).output).toBe('card.svg');
    });

    it('flips --stdout', () => {
        expect(CardRunner._parse(['--stdout']).toStdout).toBe(true);
    });

    it('collects --project repeatedly', () => {
        expect(CardRunner._parse(['--project=a', '--project', 'b']).projects).toEqual(['a', 'b']);
    });

    it('parses --title', () => {
        expect(CardRunner._parse(['--title=my-repo']).title).toBe('my-repo');
    });

    it('toggles every --no-* flag', () => {
        const a = CardRunner._parse(['--no-osv', '--no-heuristics', '--no-unused', '--no-external']);
        expect(a.runOsv).toBe(false);
        expect(a.runHeuristics).toBe(false);
        expect(a.runUnused).toBe(false);
        expect(a.runExternal).toBe(false);
    });

    it('rejects an unknown flag', () => {
        expect(() => CardRunner._parse(['--whatever'])).toThrow(CliArgsError);
    });

    it('rejects a non-positive --concurrency', () => {
        expect(() => CardRunner._parse(['--concurrency=0'])).toThrow(CliArgsError);
        expect(() => CardRunner._parse(['--concurrency=abc'])).toThrow(CliArgsError);
    });

    it('rejects -o without a value', () => {
        expect(() => CardRunner._parse(['-o'])).toThrow(CliArgsError);
    });

});

describe('CardRunner.run — top-level', () => {

    function makeIO(argv: string[]): RunCardIO & {out: string[]; err: string[];} {
        const out: string[] = [];
        const err: string[] = [];
        return {
            argv: argv,
            cwd: '/tmp',
            stdout: (s): void => {out.push(s);},
            stderr: (s): void => {err.push(s);},
            out: out,
            err: err
        };
    }

    it('prints help on -h and exits 0', async() => {
        const io = makeIO(['-h']);
        const code = await CardRunner.run(io);
        expect(code).toBe(0);
        expect(io.out.join('')).toBe(CARD_HELP_TEXT);
    });

    it('exits 2 on unknown flag', async() => {
        const io = makeIO(['--whatever=x']);
        const code = await CardRunner.run(io);
        expect(code).toBe(2);
        expect(io.err.join('')).toContain('Unknown flag');
    });

});