#!/usr/bin/env node
/**
 * Generate manual screenshots from a live nppm instance.
 *
 * Workflow: spawn the dev server, drive a headless Chromium through
 * every view, write PNGs into doc/screenshots/. The PNG filenames are
 * referenced verbatim from doc/manual_en.md + doc/manual_de.md — keep
 * them stable when adding new shots.
 *
 * Usage:
 *
 *   npm run docs:screenshots
 *
 * The server uses your existing nppm.json so the shots reflect *your*
 * configured projects. That's deliberate — generic stock projects
 * would feel artificial in the manual.
 */
import {spawn} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(__dirname, 'screenshots');

async function readBaseUrl() {
    if (process.env.NPPM_SCREENSHOT_URL) {
        return process.env.NPPM_SCREENSHOT_URL;
    }
    try {
        const cfg = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'nppm.json'), 'utf-8'));
        const port = cfg?.server?.port ?? 5190;
        return `http://localhost:${port}`;
    } catch {
        return 'http://localhost:5190';
    }
}

const VIEWPORT = {width: 1400, height: 900, deviceScaleFactor: 1};

async function waitForServer(url, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                return;
            }
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Server at ${url} did not come up within ${timeoutMs} ms`);
}

async function shot(page, file, options = {}) {
    const target = path.join(SHOTS_DIR, file);
    await page.screenshot({path: target, fullPage: false, ...options});
    console.log(`📸 ${path.relative(PROJECT_ROOT, target)}`);
}

async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until at least one matrix row is rendered. Indirect proxy for
 * "the matrix data has loaded", since we have no test hook to query.
 */
async function waitForMatrix(page) {
    await page.waitForSelector('.matrix-row', {timeout: 30_000});
    // Give the lazy security/heuristics badges a moment to land — they
    // come in after the table is already on screen.
    await sleep(2500);
}

async function clickTreeProject(page, name) {
    await page.evaluate((n) => {
        const items = Array.from(document.querySelectorAll('.tree-item'));
        const hit = items.find((el) => el.textContent && el.textContent.trim().startsWith(n));
        if (hit) {
            hit.click();
        }
    }, name);
    await sleep(800);
}

async function clickToggle(page, label) {
    await page.evaluate((l) => {
        const btns = Array.from(document.querySelectorAll('.installed-toggle-btn'));
        const hit = btns.find((b) => b.textContent && b.textContent.trim() === l);
        if (hit) {
            hit.click();
        }
    }, label);
    await sleep(1500);
}

async function captureLanguage(browser, baseUrl, lang) {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Set the locale via localStorage before the app boots.
    await page.evaluateOnNewDocument((l) => {
        window.localStorage.setItem('nppm.lang', l);
    }, lang);

    console.log(`\n=== Capturing ${lang.toUpperCase()} ===`);

    await page.goto(baseUrl, {waitUntil: 'networkidle2'});
    await waitForMatrix(page);

    const suffix = lang === 'en' ? '' : `_${lang}`;

    await shot(page, `01_matrix${suffix}.png`);

    // Pick the first configured project from the treeview.
    const firstProject = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.tree-item'));
        const hit = items.find((el) => !el.textContent?.includes('Matrix'));
        return hit?.textContent?.trim() ?? null;
    });

    if (firstProject) {
        await clickTreeProject(page, firstProject);
        await shot(page, `02_declared${suffix}.png`);

        await clickToggle(page, lang === 'de' ? 'Installiert' : 'Installed');
        await sleep(2000);
        await shot(page, `03_installed${suffix}.png`);

        await clickToggle(page, lang === 'de' ? 'Matrix' : 'Matrix');
        await sleep(2000);
        await shot(page, `04_project_matrix${suffix}.png`);

        await clickToggle(page, lang === 'de' ? 'Tree' : 'Tree');
        await sleep(2500);
        await shot(page, `05_tree${suffix}.png`);

        await clickToggle(page, lang === 'de' ? 'History' : 'History');
        await sleep(1500);
        await shot(page, `06_history${suffix}.png`);
    } else {
        console.log('No configured project found — skipping per-project shots.');
    }

    // Click a matrix cell to capture the detail panel.
    await page.evaluate(() => {
        const treeMatrix = Array.from(document.querySelectorAll('.tree-item'))
            .find((el) => el.textContent?.trim() === 'Matrix');
        treeMatrix?.click();
    });
    await sleep(1500);
    await waitForMatrix(page);

    // Open the panel on the first clickable cell.
    await page.evaluate(() => {
        const cell = document.querySelector('.matrix-cell-clickable');
        cell?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    await sleep(2500);
    await shot(page, `07_panel_files${suffix}.png`);

    // Switch to the Dependencies tab.
    await page.evaluate((label) => {
        const tabs = Array.from(document.querySelectorAll('.pdp-tab'));
        const hit = tabs.find((t) => t.textContent?.trim() === label);
        hit?.click();
    }, lang === 'de' ? 'Abhängigkeiten' : 'Dependencies');
    await sleep(800);
    await shot(page, `08_panel_deps${suffix}.png`);

    // Releases tab.
    await page.evaluate((label) => {
        const tabs = Array.from(document.querySelectorAll('.pdp-tab'));
        const hit = tabs.find((t) => t.textContent?.trim() === label);
        hit?.click();
    }, lang === 'de' ? 'Releases' : 'Releases');
    await sleep(2500);
    await shot(page, `09_panel_releases${suffix}.png`);

    // Security tab.
    await page.evaluate((label) => {
        const tabs = Array.from(document.querySelectorAll('.pdp-tab'));
        const hit = tabs.find((t) => t.textContent?.trim().startsWith(label));
        hit?.click();
    }, lang === 'de' ? 'Sicherheit' : 'Security');
    await sleep(2500);
    await shot(page, `10_panel_security${suffix}.png`);

    await page.close();
}

async function main() {
    if (!existsSync(SHOTS_DIR)) {
        await mkdir(SHOTS_DIR, {recursive: true});
    }

    const baseUrl = await readBaseUrl();
    console.log(`Starting nppm at ${baseUrl} …`);

    const server = spawn('node', ['./cli/dev.js'], {
        cwd: PROJECT_ROOT,
        env: {...process.env, NPPM_PROJECT_ROOT: PROJECT_ROOT},
        stdio: ['ignore', 'pipe', 'pipe']
    });

    server.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
    server.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));

    try {
        await waitForServer(baseUrl);
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        try {
            await captureLanguage(browser, baseUrl, 'en');
            await captureLanguage(browser, baseUrl, 'de');
        } finally {
            await browser.close();
        }
    } finally {
        server.kill();
    }

    console.log('\n✓ Screenshots written to doc/screenshots/');
}

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});