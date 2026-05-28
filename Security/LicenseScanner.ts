/**
 * Compliance-oriented license classification. Five buckets, ordered by
 * how restrictive they are for the typical commercial consumer (lower
 * rank = more permissive = better):
 *
 *  - `permissive` — MIT / BSD / Apache / ISC. Do whatever.
 *  - `weak-copyleft` — LGPL / MPL / EPL. File-level boundary; usually
 *    accepted by legal teams.
 *  - `strong-copyleft` — GPL / AGPL. Viral; AGPL adds network-use
 *    obligations. Often a hard "no" for proprietary products.
 *  - `proprietary` — `UNLICENSED`, `SEE LICENSE IN …`, custom refs.
 *    Compliance-killer: assume "you may not redistribute".
 *  - `unknown` — no `license` field at all, or a string we don't
 *    recognise. Worth flagging because we can't make a decision.
 */
export enum LicenseSeverity {
    permissive = 'permissive',
    weakCopyleft = 'weak-copyleft',
    strongCopyleft = 'strong-copyleft',
    proprietary = 'proprietary',
    unknown = 'unknown'
}

export type LicenseFinding = {
    /** Original SPDX-style string as the manifest declared it (`MIT`, `(MIT OR Apache-2.0)`, `UNLICENSED`, …). `null` when absent. */
    spdx: string|null;
    /** Aggregated classification — for a compound expression this is the worst (AND) or best (OR) reachable bucket. */
    severity: LicenseSeverity;
    /** Distinct SPDX identifiers we recognised inside the expression. */
    identifiers: string[];
    /** Short German reason — mirrors the other scanners' UX. */
    reason: string;
    /** True when an allowlist/denylist rule from config determined the severity. */
    policyMatched: boolean;
};

export type LicenseScannerOptions = {
    /**
     * Patterns that always classify as `permissive` regardless of the
     * default classification. Supports a `*` suffix wildcard (`BSD-*`)
     * and exact SPDX IDs.
     */
    allowlist?: string[];
    /**
     * Patterns that always classify as `proprietary` regardless of the
     * default classification. Same syntax as `allowlist`. Denylist
     * wins over allowlist when both match.
     */
    denylist?: string[];
    /**
     * Severity to assign when no license is declared and no allow/deny
     * rule matches. Default `unknown`; security-strict teams set
     * `proprietary` so missing-license forces a manual review.
     */
    treatUnknownAs?: LicenseSeverity;
};

/**
 * Severity rank — higher = worse. Used to pick the worst bucket for an
 * `AND` expression and the best bucket for an `OR` expression. Kept as
 * a const map so the ladder is explicit rather than buried in a sort.
 */
const RANK: Record<LicenseSeverity, number> = {
    [LicenseSeverity.permissive]: 0,
    [LicenseSeverity.unknown]: 1,
    [LicenseSeverity.weakCopyleft]: 2,
    [LicenseSeverity.strongCopyleft]: 3,
    [LicenseSeverity.proprietary]: 4
};

/**
 * SPDX identifiers we treat as permissive. Kept tight — adding obscure
 * entries trains the user to ignore the badge. The list covers
 * everything that shows up in the npm top-500 plus the handful of
 * less-common identifiers (`0BSD`, `BlueOak-1.0.0`) used by tooling
 * authors who care about being explicit.
 */
const PERMISSIVE_IDS = new Set([
    'MIT', 'MIT-0', 'ISC',
    'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear', '0BSD', 'BSD-4-Clause',
    'Apache-2.0', 'Apache-1.1',
    'CC0-1.0', 'Unlicense', 'WTFPL',
    'Zlib', 'BSL-1.0',
    'PostgreSQL', 'NCSA', 'Artistic-2.0',
    'BlueOak-1.0.0', 'Python-2.0', 'CC-BY-4.0', 'CC-BY-3.0'
]);

const WEAK_COPYLEFT_IDS = new Set([
    'LGPL-2.0', 'LGPL-2.0-only', 'LGPL-2.0-or-later',
    'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
    'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
    'MPL-1.1', 'MPL-2.0',
    'EPL-1.0', 'EPL-2.0',
    'CDDL-1.0', 'CDDL-1.1',
    'OFL-1.1',
    'EUPL-1.1', 'EUPL-1.2'
]);

const STRONG_COPYLEFT_IDS = new Set([
    'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-2.0+',
    'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'GPL-3.0+',
    'AGPL-1.0', 'AGPL-1.0-only', 'AGPL-1.0-or-later',
    'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later'
]);

/**
 * Pattern-matcher for the allow/deny config. Supports exact match and
 * a trailing `*` wildcard (`BSD-*` matches `BSD-3-Clause`). Case
 * sensitive on purpose — SPDX IDs are conventionally case sensitive
 * and the few common typos (`mit` instead of `MIT`) are something
 * `LicenseScanner` already normalises before policy matching.
 */
function matchesAny(id: string, patterns: readonly string[]|undefined): boolean {
    if (!patterns) {
        return false;
    }
    for (const p of patterns) {
        if (p.endsWith('*')) {
            if (id.startsWith(p.slice(0, -1))) {
                return true;
            }
        } else if (id === p) {
            return true;
        }
    }
    return false;
}

/**
 * Classify a single SPDX identifier (no expression syntax) — `MIT`,
 * `Apache-2.0`, `UNLICENSED`, `SEE LICENSE IN LICENSE.txt`, …. Returns
 * the bucket without touching policy rules; the caller applies
 * allow/deny on top.
 */
function classifyAtom(id: string): LicenseSeverity {
    const trimmed = id.trim();

    if (trimmed.length === 0) {
        return LicenseSeverity.unknown;
    }

    // npm's convention for "this package is proprietary, don't
    // republish". Other proprietary markers: SEE-LICENSE-IN-..., a
    // `LicenseRef-*` custom-reference, or a free-text license name.
    if (trimmed === 'UNLICENSED') {
        return LicenseSeverity.proprietary;
    }
    if (/^SEE\s+LICENSE/i.test(trimmed)) {
        return LicenseSeverity.proprietary;
    }
    if (/^LicenseRef-/.test(trimmed)) {
        return LicenseSeverity.proprietary;
    }

    // Normalise to the canonical form before set lookup. npm packages
    // are inconsistent about pluses (`GPL-3.0+` vs `GPL-3.0-or-later`)
    // and the `mit` lowercase typo is surprisingly common.
    const canonical = canonicalise(trimmed);

    if (PERMISSIVE_IDS.has(canonical)) {
        return LicenseSeverity.permissive;
    }
    if (WEAK_COPYLEFT_IDS.has(canonical)) {
        return LicenseSeverity.weakCopyleft;
    }
    if (STRONG_COPYLEFT_IDS.has(canonical)) {
        return LicenseSeverity.strongCopyleft;
    }

    return LicenseSeverity.unknown;
}

function canonicalise(id: string): string {
    // Case-canonicalise the well-known prefixes; anything else stays as-is.
    const upper = id.toUpperCase();
    for (const known of [...PERMISSIVE_IDS, ...WEAK_COPYLEFT_IDS, ...STRONG_COPYLEFT_IDS]) {
        if (upper === known.toUpperCase()) {
            return known;
        }
    }
    return id;
}

/**
 * Token kinds used by the SPDX expression parser. Only the four kinds
 * SPDX 2.x defines (id, OR, AND, WITH) plus parentheses — enough for
 * 99 % of expressions seen on npm.
 */
type Token =
    | {kind: 'id'; value: string}
    | {kind: 'op'; value: 'OR'|'AND'|'WITH'}
    | {kind: 'lparen'}
    | {kind: 'rparen'};

function tokenize(expr: string): Token[]|null {
    const tokens: Token[] = [];
    let i = 0;
    const s = expr.trim();

    while (i < s.length) {
        const ch = s[i];

        if (ch === ' ' || ch === '\t' || ch === '\n') {
            i++;
            continue;
        }

        if (ch === '(') {
            tokens.push({kind: 'lparen'});
            i++;
            continue;
        }

        if (ch === ')') {
            tokens.push({kind: 'rparen'});
            i++;
            continue;
        }

        // Identifier / keyword. SPDX IDs use [A-Za-z0-9.+-], plus the
        // keywords OR/AND/WITH. Read until we hit a space or paren.
        let j = i;
        while (j < s.length && !/[\s()]/.test(s[j])) {
            j++;
        }
        const word = s.slice(i, j);
        if (word.length === 0) {
            return null;
        }

        const upper = word.toUpperCase();
        if (upper === 'OR' || upper === 'AND' || upper === 'WITH') {
            tokens.push({kind: 'op', value: upper as 'OR'|'AND'|'WITH'});
        } else {
            tokens.push({kind: 'id', value: word});
        }
        i = j;
    }

    return tokens;
}

/**
 * Recursive-descent SPDX expression evaluator. Grammar (simplified):
 *
 *   expr   := term (OR term)*
 *   term   := factor (AND factor)*
 *   factor := atom (WITH id)?
 *   atom   := id | '(' expr ')'
 *
 * Returns the aggregate `{severity, identifiers}` of the expression.
 * `null` means we couldn't parse — caller falls back to atom-level
 * classification of the whole string.
 */
function evalExpression(
    tokens: Token[]
): {severity: LicenseSeverity; identifiers: string[]}|null {
    let pos = 0;
    const ids = new Set<string>();

    const peek = (): Token|null => tokens[pos] ?? null;
    const consume = (): Token|null => tokens[pos++] ?? null;

    const parseAtom = (): LicenseSeverity|null => {
        const tok = consume();
        if (!tok) {
            return null;
        }
        if (tok.kind === 'lparen') {
            const inner = parseExpr();
            const close = consume();
            if (!close || close.kind !== 'rparen') {
                return null;
            }
            return inner;
        }
        if (tok.kind === 'id') {
            ids.add(tok.value);
            return classifyAtom(tok.value);
        }
        return null;
    };

    const parseFactor = (): LicenseSeverity|null => {
        const sev = parseAtom();
        if (sev === null) {
            return null;
        }
        // `Apache-2.0 WITH Classpath-exception-2.0` — the WITH clause
        // is an exception that loosens the parent license, never
        // changes its bucket.
        if (peek()?.kind === 'op' && (peek() as {value: string}).value === 'WITH') {
            consume();
            const next = consume();
            if (!next || next.kind !== 'id') {
                return null;
            }
            ids.add(next.value);
        }
        return sev;
    };

    const parseTerm = (): LicenseSeverity|null => {
        let sev = parseFactor();
        if (sev === null) {
            return null;
        }
        while (peek()?.kind === 'op' && (peek() as {value: string}).value === 'AND') {
            consume();
            const next = parseFactor();
            if (next === null) {
                return null;
            }
            // AND: must comply with both — worst wins.
            if (RANK[next] > RANK[sev]) {
                sev = next;
            }
        }
        return sev;
    };

    const parseExpr = (): LicenseSeverity|null => {
        let sev = parseTerm();
        if (sev === null) {
            return null;
        }
        while (peek()?.kind === 'op' && (peek() as {value: string}).value === 'OR') {
            consume();
            const next = parseTerm();
            if (next === null) {
                return null;
            }
            // OR: user can pick the best one.
            if (RANK[next] < RANK[sev]) {
                sev = next;
            }
        }
        return sev;
    };

    const severity = parseExpr();
    if (severity === null || pos !== tokens.length) {
        return null;
    }
    return {severity, identifiers: Array.from(ids)};
}

/**
 * Classifies the `license` field of an npm package against a (small)
 * SPDX-expression grammar and an optional allow/deny policy. The
 * intent is *compliance*, not legal interpretation — the buckets are
 * coarse so reviewers can scan a matrix and spot the rows that need a
 * lawyer's attention.
 */
export class LicenseScanner {

    private readonly _allowlist: readonly string[]|undefined;
    private readonly _denylist: readonly string[]|undefined;
    private readonly _treatUnknownAs: LicenseSeverity;

    constructor(opts: LicenseScannerOptions = {}) {
        this._allowlist = opts.allowlist;
        this._denylist = opts.denylist;
        this._treatUnknownAs = opts.treatUnknownAs ?? LicenseSeverity.unknown;
    }

    /**
     * Classify a single SPDX string (or absence thereof). `spdx: null`
     * is what callers should pass when neither the registry nor the
     * tarball manifest carried a `license` field.
     */
    public classify(spdx: string|null|undefined): LicenseFinding {
        const raw = spdx ?? null;

        // Empty / missing: respect `treatUnknownAs` from config, but
        // policy lists still apply (a denylist match on '' is unusual
        // but a hypothetical allowlist with a wildcard could legitimately
        // catch it).
        if (raw === null || raw.trim().length === 0) {
            return {
                spdx: null,
                severity: this._treatUnknownAs,
                identifiers: [],
                reason: this._treatUnknownAs === LicenseSeverity.unknown
                    ? 'Kein `license`-Feld im Paket-Manifest'
                    : 'Kein `license`-Feld — durch Config als '
                        + `${this._treatUnknownAs} behandelt`,
                policyMatched: false
            };
        }

        const tokens = tokenize(raw);
        const evaluated = tokens ? evalExpression(tokens) : null;

        // Policy lookup matches against the raw string AND each
        // recognised identifier. That way `BSD-*` in an allowlist
        // matches both the bare `BSD-3-Clause` declaration and the
        // dual-licensed `(MIT OR BSD-3-Clause)` expression.
        const candidates = evaluated && evaluated.identifiers.length > 0
            ? [raw, ...evaluated.identifiers]
            : [raw];

        // Denylist always wins so a security-strict team can override
        // even a normally-permissive license (e.g. some companies
        // forbid CC-BY-4.0 for code).
        if (candidates.some((c) => matchesAny(c, this._denylist))) {
            return {
                spdx: raw,
                severity: LicenseSeverity.proprietary,
                identifiers: evaluated?.identifiers ?? [],
                reason: `Lizenz "${raw}" auf der Denylist`,
                policyMatched: true
            };
        }

        if (candidates.some((c) => matchesAny(c, this._allowlist))) {
            return {
                spdx: raw,
                severity: LicenseSeverity.permissive,
                identifiers: evaluated?.identifiers ?? [],
                reason: `Lizenz "${raw}" auf der Allowlist`,
                policyMatched: true
            };
        }

        if (evaluated) {
            return {
                spdx: raw,
                severity: evaluated.severity,
                identifiers: evaluated.identifiers,
                reason: this._reasonFor(evaluated.severity, evaluated.identifiers, raw)
            ,
                policyMatched: false
            };
        }

        // Couldn't parse the expression — treat the whole string as a
        // single atom. Catches free-text proprietary strings ("Acme
        // Corp internal license").
        const atomSev = classifyAtom(raw);
        return {
            spdx: raw,
            severity: atomSev,
            identifiers: [],
            reason: this._reasonFor(atomSev, [], raw),
            policyMatched: false
        };
    }

    private _reasonFor(sev: LicenseSeverity, ids: string[], raw: string): string {
        const head = ids.length > 1 ? `Ausdruck "${raw}"` : `Lizenz "${raw}"`;
        switch (sev) {
            case LicenseSeverity.permissive:
                return `${head} ist permissiv — keine Compliance-Auflagen`;
            case LicenseSeverity.weakCopyleft:
                return `${head} ist Weak-Copyleft (LGPL/MPL/EPL) — Datei-Grenze, meistens akzeptiert`;
            case LicenseSeverity.strongCopyleft:
                return `${head} ist Strong-Copyleft (GPL/AGPL) — viral, Code-Freigabe-Pflicht für Derivate`;
            case LicenseSeverity.proprietary:
                return `${head} ist proprietär — keine Weitergabe ohne Vertrag`;
            case LicenseSeverity.unknown:
                return `${head} nicht im SPDX-Katalog wiedererkannt`;
        }
    }
}

/**
 * Compact summary for the matrix badge — same shape as the other
 * heuristic summaries.
 */
export type LicenseSummary = {
    name: string;
    version: string;
    spdx: string|null;
    severity: LicenseSeverity;
};