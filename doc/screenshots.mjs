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

/**
 * Read every configured local project's root `package.json` and return
 * the union of declared dep names (deps + devDeps + peer + optional).
 * Used by the Bulk-Upgrade Wizard capture to prefer checkboxes whose
 * row will resolve to a real edit instead of a `not-found` skip
 * (the global matrix aggregates workspaces, so workspace-only deps
 * surface in the cell but can't be reached by a root edit).
 */
async function collectRootDepNames() {
    const out = new Set();
    try {
        const cfg = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'nppm.json'), 'utf-8'));
        for (const p of cfg.projects ?? []) {
            if (p?.type !== 'local' || !p.path) {
                continue;
            }
            try {
                const pkg = JSON.parse(await readFile(path.join(p.path, 'package.json'), 'utf-8'));
                for (const bucket of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
                    for (const name of Object.keys(pkg[bucket] ?? {})) {
                        out.add(name);
                    }
                }
            } catch {
                // Project root unreadable — skip; the fallback in
                // captureBulkWizard still kicks in.
            }
        }
    } catch {
        // No nppm.json — caller will fall back to "first 3 anywhere".
    }
    return out;
}

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

    // Pick the first configured project from the treeview — i.e. the
    // first row that isn't a sentinel (Matrix / Templates / ...).
    const firstProjectUnid = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.tree-item'));
        const hit = items.find((el) => {
            const unid = el.getAttribute('data-unid') ?? '';
            return unid && !unid.startsWith('__');
        });
        return hit?.getAttribute('data-unid') ?? null;
    });

    if (firstProjectUnid) {
        await page.evaluate((unid) => {
            const it = document.querySelector(`.tree-item[data-unid="${unid}"]`);
            it?.click();
        }, firstProjectUnid);
        await sleep(800);
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
        // If the History view shows an enabled Backfill button (this
        // project has a `.git/` source), trigger it so the timeline
        // shot isn't empty when the lockfile hasn't drifted yet.
        const backfillTriggered = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('.installed-analyze-btn'));
            const hit = btns.find((b) => !b.disabled
                && /(Backfill|nachpflegen|Re-pull|neu)/i.test(b.textContent || ''));
            if (hit) {
                hit.click();
                return true;
            }
            return false;
        });
        if (backfillTriggered) {
            try {
                await page.waitForSelector('.timeline-item', {timeout: 20_000});
            } catch {
                // Backfill produced nothing — fine, take whatever's there.
            }
            await sleep(800);
        }
        await shot(page, `06_history${suffix}.png`);

        // Vulns view — auto-fires a scan on first open, so give it
        // time to settle (backfill phase can be slow on cold cache).
        await clickToggle(page, 'Vulns');
        await sleep(4000);
        await shot(page, `13_vuln_timeline${suffix}.png`);

        // PR review — defaults to main vs HEAD; the request returns
        // quickly when both refs resolve, so a short wait suffices.
        await clickToggle(page, 'PR');
        await sleep(2500);
        await shot(page, `14_pr_review${suffix}.png`);
    } else {
        console.log('No configured project found — skipping per-project shots.');
    }

    // Click a matrix cell to capture the detail panel.
    await page.evaluate(() => {
        const treeMatrix = document.querySelector('.tree-item[data-unid="__matrix__"]');
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

    await captureBulkWizard(page, lang, suffix, ROOT_DEP_NAMES);
    await captureWorkspaceDrift(page, lang, suffix);
    await captureTemplatesViews(page, lang, suffix);
    await captureSettingsDialog(page, lang, suffix);
    await captureDashboard(page, lang, suffix);
    await captureImpactModal(page, lang, suffix);
    await captureBadgeFilter(page, lang, suffix);

    await page.close();
}

/**
 * Cross-project Bulk-Upgrade Wizard. Switches back to the global
 * matrix, sets the Outdated filter so checkboxes are visible without
 * scrolling, ticks the first few, screenshots the matrix + footer,
 * then opens the wizard and screenshots its grouped preview.
 *
 * Best-effort: if the user's projects happen to have zero outdated
 * cells (everything already aligned), both screenshots get skipped
 * with a console note.
 */
async function captureBulkWizard(page, lang, suffix, rootDepNames) {
    // Close any open modal from a previous step.
    await page.keyboard.press('Escape');
    await sleep(300);

    // Switch back to the global matrix view.
    await page.evaluate(() => {
        const item = document.querySelector('.tree-item[data-unid="__matrix__"]');
        item?.click();
    });
    await sleep(1500);
    await waitForMatrix(page);

    // Activate the Outdated filter so the candidates surface together.
    const filtered = await page.evaluate((label) => {
        const btn = Array.from(document.querySelectorAll('.matrix-filter-btn'))
            .find((b) => b.textContent?.trim() === label);
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    }, lang === 'de' ? 'Veraltet' : 'Outdated');

    if (!filtered) {
        console.log('  · Outdated filter button not found — skipping bulk wizard shots');
        return;
    }
    await sleep(1500);

    // Tick up to three checkboxes. Prefer rows whose package name is
    // declared in some local project's *root* package.json — the
    // global matrix aggregates workspaces, so workspace-only deps
    // surface in the cell but a root-level edit can't reach them and
    // they'd show as `not-found` in the wizard. The fallback list is
    // generic well-known tools for repos whose `nppm.json` couldn't be
    // read at script start.
    const ticked = await page.evaluate((rootNames) => {
        const known = new Set(rootNames);
        const rows = Array.from(document.querySelectorAll('.matrix-row'));
        const target = [];

        // Pass 1 — only rows whose name is known to be in some root.
        for (const row of rows) {
            const name = row.querySelector('.matrix-cell-name > span:first-child')
                ?.textContent?.trim() ?? '';
            if (!known.has(name)) {
                continue;
            }
            const box = row.querySelector('.matrix-cell-check');
            if (box) {
                target.push(box);
            }
            if (target.length >= 3) {
                break;
            }
        }

        // Pass 2 — top up with anything else visible. Mixed planned /
        // skipped is still richer than a near-empty wizard.
        if (target.length < 3) {
            for (const extra of document.querySelectorAll('.matrix-cell-check')) {
                if (target.includes(extra)) {
                    continue;
                }
                target.push(extra);
                if (target.length >= 3) {
                    break;
                }
            }
        }

        for (const b of target) {
            b.click();
        }
        return target.length;
    }, Array.from(rootDepNames));

    if (ticked === 0) {
        console.log('  · No outdated cells with checkboxes — skipping bulk wizard shots');
        return;
    }

    // Scroll the footer into view so it lands in the screenshot. The
    // matrix area scrolls inside `.matrix-wrap`; scroll its parent so
    // the sticky footer is visible without cropping the table.
    await page.evaluate(() => {
        const footer = document.querySelector('.matrix-footer');
        footer?.scrollIntoView({block: 'end'});
    });
    await sleep(400);
    await shot(page, `11_bulk_select${suffix}.png`);

    // Click "Update selected" to open the wizard.
    const opened = await page.evaluate(() => {
        const apply = document.querySelector('.matrix-footer-apply');
        if (apply && !apply.disabled) {
            apply.click();
            return true;
        }
        return false;
    });

    if (!opened) {
        console.log('  · Update-selected button disabled — skipping wizard shot');
        return;
    }

    // Wait for the modal to render past its loading state — the
    // summary line shows up once the bulk preview returns.
    try {
        await page.waitForSelector('.bumd-summary', {timeout: 30_000});
    } catch {
        console.log('  · Wizard modal never reached summary state — taking shot anyway');
    }
    // Extra beat for any per-pick security heads-up that arrive after
    // the summary lands.
    await sleep(1500);
    await shot(page, `12_bulk_modal${suffix}.png`);

    // Close the modal so the next iteration starts clean.
    await page.keyboard.press('Escape');
    await sleep(300);
}

/**
 * WS-badge → WorkspaceDriftModal. Goes back to the global matrix,
 * scans for the first cell that carries a `.matrix-badge-drift`
 * (which means at least one project has internal-workspace drift on
 * that package), clicks it, and shoots the dialog.
 */
async function captureWorkspaceDrift(page, lang, suffix) {
    await page.keyboard.press('Escape');
    await sleep(300);

    await page.evaluate(() => {
        const item = document.querySelector('.tree-item[data-unid="__matrix__"]');
        item?.click();
    });
    await sleep(1500);
    await waitForMatrix(page);

    const clicked = await page.evaluate(() => {
        const badge = document.querySelector('.matrix-badge-drift');
        if (badge) {
            badge.click();
            badge.scrollIntoView({block: 'center'});
            return true;
        }
        return false;
    });

    if (!clicked) {
        console.log('  · No WS badges found — skipping workspace-drift shot');
        return;
    }

    try {
        await page.waitForSelector('.wdm-table', {timeout: 10_000});
    } catch {
        console.log('  · Workspace-drift modal never rendered table — skipping shot');
        await page.keyboard.press('Escape');
        return;
    }
    await sleep(500);
    await shot(page, `17_workspace_drift${suffix}.png`);
    await page.keyboard.press('Escape');
    await sleep(300);
}

/**
 * Templates sentinel row → cross-project compliance matrix, then
 * the per-project Template tab. The per-project tab needs a project
 * whose nppm.json carries a `templates: […]` entry; we pick the
 * first such tree item by checking the project-config response live.
 */
async function captureTemplatesViews(page, lang, suffix) {
    await page.keyboard.press('Escape');
    await sleep(300);

    const opened = await page.evaluate(() => {
        const item = document.querySelector('.tree-item[data-unid="__templates__"]');
        if (item) {
            item.click();
            return true;
        }
        return false;
    });

    if (!opened) {
        console.log('  · Templates sentinel row not found — skipping templates shots');
        return;
    }
    try {
        await page.waitForSelector('.tpv-table, .tpv-titlebar', {timeout: 10_000});
    } catch {
        // continue anyway
    }
    await sleep(1500);
    await shot(page, `15_templates_matrix${suffix}.png`);

    // Find a project that has templates assigned via /api/projects.
    // We POST nothing here — just check the config endpoint per
    // project until one comes back with a non-empty templates array.
    const projectWithTemplates = await page.evaluate(async () => {
        const r = await fetch('/api/projects');
        if (!r.ok) {
            return null;
        }
        const list = await r.json();
        for (const p of list.projects ?? []) {
            const c = await fetch(`/api/projects/${p.unid}/config`);
            if (!c.ok) {
                continue;
            }
            const cfg = await c.json();
            if (Array.isArray(cfg.templates) && cfg.templates.length > 0) {
                return p.unid;
            }
        }
        return null;
    });

    if (!projectWithTemplates) {
        console.log('  · No project in nppm.json has templates assigned — skipping per-project Template tab');
        return;
    }
    await page.evaluate((unid) => {
        const item = document.querySelector(`.tree-item[data-unid="${unid}"]`);
        item?.click();
    }, projectWithTemplates);
    await sleep(1500);
    await clickToggle(page, 'Template');
    await sleep(2000);
    await shot(page, `16_template_view${suffix}.png`);
}

/**
 * Dashboard sentinel row → cross-project (project × scanner) score
 * matrix. The snapshot endpoint serves the cached last result so the
 * first paint is instant; we wait long enough for the SSE re-scan to
 * fill in fresh cells too, then shoot.
 */
async function captureDashboard(page, lang, suffix) {
    await page.keyboard.press('Escape');
    await sleep(300);

    const opened = await page.evaluate(() => {
        const item = document.querySelector('.tree-item[data-unid="__dashboard__"]');
        if (item) {
            item.click();
            return true;
        }
        return false;
    });
    if (!opened) {
        console.log('  · Dashboard sentinel row not found — skipping dashboard shot');
        return;
    }
    // Snapshot paint usually lands within a few hundred ms; an SSE
    // re-scan can take seconds on a cold cache. We wait for the
    // table to appear, then a beat for the rings to settle.
    try {
        await page.waitForSelector('.dash-table, .dash-empty', {timeout: 15_000});
    } catch {
        // continue — take whatever's there
    }
    await sleep(3000);
    await shot(page, `19_dashboard${suffix}.png`);
}

/**
 * Topbar Impact button → ImpactModal. Pre-fills the query field
 * with a name that's almost certainly transitively reachable in
 * the configured projects (`lodash` is the bellwether choice), then
 * waits for the per-project list to land before shooting.
 */
async function captureImpactModal(page, lang, suffix) {
    await page.keyboard.press('Escape');
    await sleep(300);

    // The Impact button lives in the topbar — find by class first,
    // fallback to the label text if the class ever changes.
    const opened = await page.evaluate(() => {
        const byClass = document.querySelector('.topbar-impact');
        if (byClass) {
            byClass.click();
            return true;
        }
        const btns = Array.from(document.querySelectorAll('button'));
        const hit = btns.find((b) => /impact/i.test(b.textContent || ''));
        if (hit) {
            hit.click();
            return true;
        }
        return false;
    });
    if (!opened) {
        console.log('  · Topbar Impact button not found — skipping impact shot');
        return;
    }
    try {
        await page.waitForSelector('.umd-panel input', {timeout: 10_000});
    } catch {
        console.log('  · Impact modal never rendered input — skipping shot');
        return;
    }
    // Type a query that's likely to hit something in a node project.
    await page.evaluate(() => {
        const inp = document.querySelector('.umd-panel input[type="text"], .umd-panel input[type="search"], .umd-panel input');
        if (inp) {
            inp.value = 'lodash';
            inp.dispatchEvent(new Event('input', {bubbles: true}));
            inp.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        }
        const submit = document.querySelector('.umd-panel button.umd-btn-primary, .umd-panel button[type="submit"]');
        if (submit) {
            submit.click();
        }
    });
    await sleep(2500);
    await shot(page, `20_impact${suffix}.png`);
    await page.keyboard.press('Escape');
    await sleep(300);
}

/**
 * Matrix toolbar → "Badges" button → BadgeFilterModal. Goes back
 * to the global matrix first so the toolbar exists.
 */
async function captureBadgeFilter(page, lang, suffix) {
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.evaluate(() => {
        const item = document.querySelector('.tree-item[data-unid="__matrix__"]');
        item?.click();
    });
    await sleep(1500);
    await waitForMatrix(page);

    const opened = await page.evaluate(() => {
        const btn = document.querySelector('.matrix-badges-btn');
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    });
    if (!opened) {
        console.log('  · Badges button not found — skipping badge-filter shot');
        return;
    }
    try {
        await page.waitForSelector('.bfm-list', {timeout: 10_000});
    } catch {
        console.log('  · Badge-filter modal never rendered — skipping shot');
        return;
    }
    await sleep(500);
    await shot(page, `21_badge_filter${suffix}.png`);
    await page.keyboard.press('Escape');
    await sleep(300);
}

/**
 * Topbar gear → SettingsModal on the General tab.
 */
async function captureSettingsDialog(page, lang, suffix) {
    await page.keyboard.press('Escape');
    await sleep(300);
    const opened = await page.evaluate(() => {
        const btn = document.getElementById('topbar-settings');
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    });
    if (!opened) {
        console.log('  · Topbar gear not found — skipping settings shot');
        return;
    }
    try {
        await page.waitForSelector('.sm-tabs', {timeout: 10_000});
    } catch {
        console.log('  · Settings modal never rendered tabs — skipping shot');
        return;
    }
    await sleep(800);
    await shot(page, `18_settings${suffix}.png`);
    await page.keyboard.press('Escape');
    await sleep(300);
}

let ROOT_DEP_NAMES = new Set();

async function main() {
    if (!existsSync(SHOTS_DIR)) {
        await mkdir(SHOTS_DIR, {recursive: true});
    }

    ROOT_DEP_NAMES = await collectRootDepNames();
    console.log(`Loaded ${ROOT_DEP_NAMES.size} root-dep names for bulk-wizard targeting.`);

    const baseUrl = await readBaseUrl();

    // Reuse a running dev server when one is already responding.
    // Saves the dance of bouncing the user's session every time
    // screenshots get regenerated; the spawned child would otherwise
    // collide on port 5190 and Vite would silently fall back to a
    // random next-free port that the puppeteer client wouldn't hit.
    let server = null;
    const alreadyUp = await fetch(baseUrl).then((r) => r.ok).catch(() => false);
    if (alreadyUp) {
        console.log(`Reusing existing nppm at ${baseUrl} …`);
    } else {
        console.log(`Starting nppm at ${baseUrl} …`);
        server = spawn('node', ['./cli/dev.js'], {
            cwd: PROJECT_ROOT,
            env: {...process.env, NPPM_PROJECT_ROOT: PROJECT_ROOT},
            stdio: ['ignore', 'pipe', 'pipe']
        });
        server.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
        server.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
    }

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
        if (server !== null) {
            server.kill();
        }
    }

    console.log('\n✓ Screenshots written to doc/screenshots/');
}

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});