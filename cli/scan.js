#!/usr/bin/env node

import {createServer} from 'vite';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nppmRoot = path.resolve(__dirname, '..');

/*
 * Vite is already a runtime dep — reuse it as the TS loader instead of
 * pulling in a second one (tsx). `middlewareMode + appType:'custom'`
 * gives us a server we never wire HTTP onto; we just call
 * `ssrLoadModule` to transpile + import the TypeScript entry.
 */
const vite = await createServer({
    configFile: false,
    root: nppmRoot,
    server: {middlewareMode: true, hmr: false},
    appType: 'custom',
    logLevel: 'silent'
});

try {
    const mod = await vite.ssrLoadModule('./cli/Scan.ts');
    const exit = await mod.ScanRunner.run({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s)
    });
    await vite.close();
    process.exit(exit);
} catch (e) {
    process.stderr.write(`nppm scan: fatal — ${e?.stack ?? e}\n`);
    await vite.close();
    process.exit(2);
}