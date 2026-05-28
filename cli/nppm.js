#!/usr/bin/env node

/**
 * Subcommand router for the `nppm` binary. Three shapes:
 *  - `nppm`              → starts the dev server (`cli/dev.js`)
 *  - `nppm dev`          → same, explicit
 *  - `nppm scan [...]`   → headless CI scan (`cli/scan.js`)
 *  - `nppm -h | --help`  → top-level usage
 *
 * The router keeps argv0/argv1 alone and rewrites argv from position 2
 * downwards so the imported subcommand parses just its own flags.
 */

import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sub = process.argv[2];

if (sub === '-h' || sub === '--help') {
    process.stdout.write(
        'nppm — Node Project Package Manager\n\n'
        + 'Usage:\n'
        + '  nppm              Start the dev server (default)\n'
        + '  nppm dev          Start the dev server\n'
        + '  nppm scan [...]   Headless CI scan (see `nppm scan --help`)\n'
        + '  nppm --help       Show this help\n'
    );
    process.exit(0);
}

if (sub === 'scan') {
    // Drop the `scan` keyword so the scan module sees just its flags.
    process.argv.splice(2, 1);
    await import(path.resolve(__dirname, 'scan.js'));
} else {
    if (sub === 'dev') {
        process.argv.splice(2, 1);
    }
    await import(path.resolve(__dirname, 'dev.js'));
}