#!/usr/bin/env node

import {createServer} from 'vite';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nppmRoot = path.resolve(__dirname, '..');

/*
 * Same loading pattern as `cli/scan.js` — Vite is already a runtime
 * dep and gives us the TS loader without pulling in tsx.
 */
const vite = await createServer({
    configFile: false,
    root: nppmRoot,
    server: {middlewareMode: true, hmr: false},
    appType: 'custom',
    logLevel: 'silent'
});

try {
    const mod = await vite.ssrLoadModule('./cli/Action.ts');
    const exit = await mod.ActionRunner.run({
        env: process.env,
        cwd: process.cwd(),
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s)
    });
    await vite.close();
    process.exit(exit);
} catch (e) {
    process.stderr.write(`nppm action: fatal — ${e?.stack ?? e}\n`);
    await vite.close();
    process.exit(2);
}