#!/usr/bin/env node

import { createServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = process.cwd();

const configFile = path.resolve(projectRoot, 'nppm.json');

if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify({
        projects: [],
        server: {
            port: 5190
        },
        browser: {
            open: false
        }
    }, null, 2));
    console.log('✅ nppm.json created');
}

const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

process.env.NPPM_PROJECT_ROOT = projectRoot;
process.env.NPPM_CONFIG_FILE = configFile;

let openBrowser = false;
let serverPort = 5190;
const serverHost = 'localhost';

if (config) {
    if (config.server) {
        if (config.server.port) {
            serverPort = config.server.port;
        }
    }

    if (config.browser) {
        if (config.browser.open) {
            openBrowser = true;
        }
    }
}

// Vite run
createServer({
    configFile: path.resolve(__dirname, '../vite.config.ts'),
    root: path.resolve(__dirname, '..'),
}).then(server => {
    return new Promise((resolve, reject) => {
        server.httpServer.on('error', err => {
            reject(err);
        });

        server.listen(serverPort).then(resolve).catch(reject);
    });
}).then(() => {
    console.log(`🚀 NPPM running at http://${serverHost}:${serverPort}`);

    if (openBrowser) {
        void open(`http://${serverHost}:${serverPort}`);
    }
}).catch(err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${serverPort} already in use!`);
    } else {
        console.error('❌ Failed to start NPPM:', err);
    }

    process.exit(1);
});