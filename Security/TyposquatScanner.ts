/**
 * Hand-curated list of frequently-targeted npm packages. Used as the
 * needle set for the Levenshtein typosquat check.
 *
 * Inclusion criteria (subjective but consistent):
 *  - top ~150 by weekly downloads as of mid-2025
 *  - any historical-attack target (event-stream, ua-parser-js,
 *    eslint-scope, …) — names whose squats are known to have shipped
 *  - both scoped and unscoped forms when the package ecosystem
 *    uses both (`@babel/core` lives alongside `babel-cli`)
 *
 * NOT meant to be exhaustive — exhaustive would dilute the
 * Levenshtein-distance-1 signal with hundreds of look-alikes. A
 * tightly curated list keeps the badge meaningful.
 */
const POPULAR_PACKAGES: string[] = [
    // top general-purpose
    'lodash', 'underscore', 'ramda', 'immutable',
    'axios', 'request', 'node-fetch', 'got', 'superagent',
    'moment', 'dayjs', 'date-fns', 'luxon',
    'uuid', 'nanoid', 'ulid', 'shortid',
    'chalk', 'kleur', 'picocolors', 'colors', 'ansi-colors', 'ansi-styles',
    'debug', 'pino', 'winston', 'bunyan', 'log4js', 'morgan',
    'commander', 'yargs', 'minimist', 'meow', 'arg',
    'inquirer', 'prompts', 'enquirer',
    'ora', 'cli-spinners',
    'rxjs', 'observable',
    'zod', 'yup', 'joi', 'ajv', 'json-schema',
    'classnames', 'clsx',
    'semver', 'compare-versions',
    'fs-extra', 'graceful-fs',
    'glob', 'fast-glob', 'globby', 'minimatch',
    'chokidar',
    'cross-spawn', 'execa', 'shelljs',
    'mkdirp', 'rimraf', 'del',
    'mime', 'mime-types', 'content-type',
    // frontend frameworks + their ecosystems
    'react', 'react-dom', 'react-router', 'react-router-dom',
    'vue', 'vue-router', 'vuex', 'pinia',
    'svelte', 'sveltekit',
    'solid-js',
    'preact',
    '@angular/core', '@angular/common', '@angular/cli',
    'next', 'nuxt', 'astro', 'gatsby', 'remix',
    'tailwindcss', 'postcss', 'autoprefixer',
    'styled-components', 'emotion', '@emotion/react', '@emotion/styled',
    'sass', 'less',
    'prop-types',
    // backend
    'express', 'koa', 'fastify', 'hapi', 'restify', 'nest',
    '@nestjs/core', '@nestjs/common',
    'body-parser', 'cors', 'helmet', 'compression', 'morgan',
    'cookie-parser', 'express-session',
    'jsonwebtoken', 'passport', 'bcrypt', 'bcryptjs', 'argon2',
    'mongoose', 'sequelize', 'typeorm', 'prisma', 'knex',
    'pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3',
    'redis', 'ioredis', 'memcached',
    'amqplib', 'kafkajs',
    'socket.io', 'ws', 'engine.io',
    'multer', 'sharp', 'jimp',
    'dotenv', 'dotenv-expand', 'env-cmd', 'cross-env',
    // tooling / bundlers
    'webpack', 'webpack-cli', 'webpack-dev-server',
    'rollup', 'esbuild', 'vite', 'parcel', 'turbopack',
    'babel-loader', 'ts-loader', 'css-loader', 'style-loader',
    'mini-css-extract-plugin', 'html-webpack-plugin',
    'terser', 'terser-webpack-plugin', 'uglify-js',
    '@babel/core', '@babel/preset-env', '@babel/preset-react', '@babel/preset-typescript',
    'typescript', 'ts-node', 'tsx', 'tsup',
    'eslint', 'prettier', 'stylelint',
    '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin',
    // testing
    'jest', 'vitest', 'mocha', 'chai', 'sinon', 'should',
    '@testing-library/react', '@testing-library/dom',
    'cypress', 'playwright', 'puppeteer', 'webdriverio',
    'supertest', 'nock', 'msw',
    // build / release
    'rimraf', 'npm-run-all', 'concurrently', 'nodemon', 'pm2', 'forever',
    'husky', 'lint-staged', 'commitizen',
    'semantic-release', 'standard-version',
    'rollup-plugin-typescript2', '@rollup/plugin-node-resolve', '@rollup/plugin-commonjs',
    // types
    '@types/node', '@types/react', '@types/react-dom', '@types/express',
    '@types/jest', '@types/lodash', '@types/uuid'
];

const POPULAR_SET = new Set(POPULAR_PACKAGES);

/**
 * Four-level typosquat severity. Includes an explicit `exact` for
 * "matches a curated popular entry" so the UI can affirm popular
 * packages rather than going silent; `unrelated` is the dominant
 * case (every project's own packages + the long tail).
 */
export enum TyposquatLevel {
    /** Name appears verbatim in the curated popular list. */
    exact = 'exact',
    /** Levenshtein distance to closest popular > 2 and no confusables — fine. */
    unrelated = 'unrelated',
    /** Distance 2 — worth a second look. */
    warn = 'warn',
    /** Distance 1, or contains a non-ASCII (confusable) character. */
    risk = 'risk'
}

export type TyposquatFinding = {
    level: TyposquatLevel;
    /** Closest popular-package name considered, or `null` if none was close enough. */
    closestMatch: string|null;
    /** Levenshtein distance to `closestMatch`; `null` if we didn't compute (out-of-range length). */
    distance: number|null;
    /** True if the name contains non-ASCII characters (Unicode homoglyph attack). */
    hasConfusables: boolean;
    reason: string;
};

/**
 * Static typosquat classifier. Two independent signals:
 *
 *  1. **Unicode confusables** — any non-ASCII character in an npm
 *     package name is a strong red flag. npm package names are
 *     ASCII per the spec, so a name with cyrillic `ѕ` for `s` is
 *     definitionally a homoglyph attack. Confusables override
 *     distance: even an exact-letter match to a popular package
 *     gets `risk` if the bytes are Unicode.
 *  2. **Levenshtein distance** to the curated popular set. Distance
 *     1 = `risk` (highly likely typosquat), distance 2 = `warn`,
 *     anything further = `unrelated`.
 *
 * The closest-popular search is bounded: we only compute the full
 * Levenshtein on candidates whose length is within 2 of the
 * input. That keeps a "scan a lockfile" pass linear in the number
 * of packages instead of quadratic in the list size.
 */
export class TyposquatScanner {

    public static classify(name: string): TyposquatFinding {
        const hasConfusables = TyposquatScanner._hasNonAscii(name);

        // Exact match — but a Unicode-encoded "exact match" is still
        // a homoglyph attack (the bytes differ even when the glyphs
        // match), so confusables take precedence.
        if (POPULAR_SET.has(name) && !hasConfusables) {
            return {
                level: TyposquatLevel.exact,
                closestMatch: name,
                distance: 0,
                hasConfusables: false,
                reason: 'Exact match in the curated popular-packages list'
            };
        }

        const {closest, distance} = TyposquatScanner._closestPopular(name);

        if (hasConfusables) {
            return {
                level: TyposquatLevel.risk,
                closestMatch: closest,
                distance,
                hasConfusables: true,
                reason: closest
                    ? `Name contains non-ASCII characters and resembles popular "${closest}" — likely a homoglyph attack`
                    : 'Name contains non-ASCII characters — npm names are ASCII-only, likely a homoglyph attack'
            };
        }

        if (distance === 1 && closest !== null) {
            return {
                level: TyposquatLevel.risk,
                closestMatch: closest,
                distance: 1,
                hasConfusables: false,
                reason: `One character away from popular "${closest}" — possible typosquat`
            };
        }

        if (distance === 2 && closest !== null) {
            return {
                level: TyposquatLevel.warn,
                closestMatch: closest,
                distance: 2,
                hasConfusables: false,
                reason: `Two characters away from popular "${closest}" — worth a second look`
            };
        }

        return {
            level: TyposquatLevel.unrelated,
            closestMatch: closest,
            distance,
            hasConfusables: false,
            reason: 'No close match in the curated popular-packages list'
        };
    }

    /**
     * Walk the popular list, return the lowest-distance candidate.
     * Skips entries whose length already differs by more than 2 (a
     * trivial lower bound on the Levenshtein distance) so the inner
     * DP only runs on plausible neighbours.
     */
    private static _closestPopular(name: string): {closest: string|null; distance: number|null} {
        let bestDist = Infinity;
        let bestMatch: string|null = null;
        for (const pop of POPULAR_PACKAGES) {
            if (Math.abs(pop.length - name.length) > 2) {
                continue;
            }
            const d = TyposquatScanner.levenshtein(name, pop, 2);
            if (d < bestDist) {
                bestDist = d;
                bestMatch = pop;
                if (d === 0) {
                    break;
                }
            }
        }
        return {
            closest: bestMatch,
            distance: bestDist === Infinity ? null : bestDist
        };
    }

    /**
     * Bounded Levenshtein DP. Two-row buffer so memory stays O(n).
     * `maxDist` short-circuits the walk: if the minimum value in
     * the current row already exceeds the cap, we return `maxDist+1`
     * so the caller can prune. Public for test use.
     */
    public static levenshtein(a: string, b: string, maxDist: number = Infinity): number {
        if (a === b) {
            return 0;
        }
        if (a.length === 0) {
            return b.length;
        }
        if (b.length === 0) {
            return a.length;
        }
        if (Math.abs(a.length - b.length) > maxDist) {
            return maxDist + 1;
        }

        let prev: number[] = new Array(b.length + 1);
        let curr: number[] = new Array(b.length + 1);
        for (let j = 0; j <= b.length; j++) {
            prev[j] = j;
        }

        for (let i = 1; i <= a.length; i++) {
            curr[0] = i;
            let rowMin = curr[0];
            for (let j = 1; j <= b.length; j++) {
                const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
                curr[j] = Math.min(
                    prev[j] + 1,          // deletion
                    curr[j - 1] + 1,      // insertion
                    prev[j - 1] + cost    // substitution
                );
                if (curr[j] < rowMin) {
                    rowMin = curr[j];
                }
            }
            if (rowMin > maxDist) {
                return maxDist + 1;
            }
            [prev, curr] = [curr, prev];
        }
        return prev[b.length];
    }

    /**
     * Any code point outside the ASCII range (0–127) is a confusable
     * candidate. npm package names are ASCII per the registry spec,
     * so a non-ASCII byte in a name a developer is about to install
     * is automatically suspicious.
     */
    private static _hasNonAscii(name: string): boolean {
        for (let i = 0; i < name.length; i++) {
            if (name.charCodeAt(i) > 127) {
                return true;
            }
        }
        return false;
    }
}

/**
 * Compact summary for the matrix badge — same shape as the other
 * heuristic summaries.
 */
export type TyposquatSummary = {
    name: string;
    version: string;
    level: TyposquatLevel|null;
    closestMatch: string|null;
    hasConfusables: boolean;
};