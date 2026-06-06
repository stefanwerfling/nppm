#!/usr/bin/env node

import {createServer} from 'vite';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nppmRoot = path.resolve(__dirname, '..');

/*
 * Same Vite-as-TS-loader trick as cli/scan.js — Vite is already a
 * runtime dep, so we reuse it instead of adding tsx.
 */
const vite = await createServer({
    configFile: false,
    root: nppmRoot,
    server: {middlewareMode: true, hmr: false},
    appType: 'custom',
    logLevel: 'silent'
});

try {
    const mod = await vite.ssrLoadModule('./cli/Sbom.ts');
    const exit = await mod.SbomRunner.run({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s)
    });
    await vite.close();
    process.exit(exit);
} catch (e) {
    process.stderr.write(`nppm sbom: fatal — ${e?.stack ?? e}\n`);
    await vite.close();
    process.exit(2);
}