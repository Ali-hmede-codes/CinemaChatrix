/**
 * Code generation service.
 *
 * Produces cryptographically-random unlock codes in the format:
 *
 *     CHX-XXXX-XXXX-XXXX
 *
 *   CHX  = fixed prefix (CinemaChatrix)
 *   XXXX = 4 random chars from an unambiguous charset (no 0/O/1/I)
 *          × 3 groups = 12 random characters
 *
 * 32^12 ≈ 1.2e18 possible combinations, so collisions are astronomically
 * unlikely — but we still verify uniqueness against the database.
 *
 * Older 2-group codes (CHX-XXXX-XXXX) stay valid when redeeming, for
 * backward compatibility with codes issued before this change.
 */

const crypto = require('crypto');

// Unambiguous uppercase alphanumerics (excludes 0, O, 1, I to avoid typos)
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PREFIX = 'CHX';
const GROUP_LEN = 4;
const GROUP_COUNT = 3;   // groups in a newly-generated code → CHX-XXXX-XXXX-XXXX
const MIN_GROUPS = 2;    // still accept legacy 2-group codes when redeeming
const MAX_GROUPS = 6;    // upper bound so normalize rejects absurdly long input

/* ------------------------------------------------------------------ */
/*  Generation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Generate a single random group of characters using crypto randomness.
 * Uses rejection sampling so every character is uniformly distributed
 * (avoids the modulo bias of `byte % CHARSET.length`).
 *
 * @param {number} len
 * @returns {string}
 */
function randomGroup(len = GROUP_LEN) {
    let out = '';
    const max = Math.floor(256 / CHARSET.length) * CHARSET.length; // largest multiple of charset
    while (out.length < len) {
        const byte = crypto.randomBytes(1)[0];
        if (byte >= max) continue; // reject to keep the distribution uniform
        out += CHARSET[byte % CHARSET.length];
    }
    return out;
}

/**
 * Generate one code, e.g. "CHX-7K3M-9P2X-4H8T" (GROUP_COUNT groups).
 * @returns {string}
 */
function generateCode() {
    const groups = [];
    for (let i = 0; i < GROUP_COUNT; i++) groups.push(randomGroup());
    return `${PREFIX}-${groups.join('-')}`;
}

/**
 * Generate `quantity` unique codes.
 *
 * Uniqueness is guaranteed both within the batch and against the
 * database via the provided `existsFn` (mirrors the uniqueSlug helper).
 *
 * @param {number} quantity
 * @param {(code: string) => boolean} existsFn - returns true if the code already exists
 * @returns {string[]} array of unique codes
 */
function generateUnique(quantity, existsFn) {
    const codes = new Set();
    let guard = 0;
    const maxAttempts = quantity * 50 + 100; // safety valve against an infinite loop

    while (codes.size < quantity) {
        if (guard++ > maxAttempts) {
            throw new Error('Failed to generate unique codes — please try again');
        }
        const code = generateCode();
        if (codes.has(code)) continue;
        if (typeof existsFn === 'function' && existsFn(code)) continue;
        codes.add(code);
    }
    return [...codes];
}

/**
 * Normalize user-typed input into the canonical code format.
 * Uppercases, trims, strips spaces, and tolerates missing/extra dashes
 * so "chx 7k3m 9p2x 4h8t" and "CHX7K3M9P2X4H8T" both resolve correctly.
 *
 * Accepts any whole number of 4-char groups within [MIN_GROUPS, MAX_GROUPS],
 * so new 3-group codes and legacy 2-group codes both parse.
 *
 * @param {string} raw
 * @returns {string|null} normalized code, or null if it can't be parsed
 */
function normalize(raw) {
    if (!raw) return null;
    const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cleaned.startsWith(PREFIX)) return null;

    const body = cleaned.slice(PREFIX.length);
    const groupCount = body.length / GROUP_LEN;
    if (!Number.isInteger(groupCount) || groupCount < MIN_GROUPS || groupCount > MAX_GROUPS) {
        return null;
    }

    const groups = [];
    for (let i = 0; i < body.length; i += GROUP_LEN) {
        groups.push(body.slice(i, i + GROUP_LEN));
    }
    return `${PREFIX}-${groups.join('-')}`;
}

module.exports = {
    generateCode,
    generateUnique,
    normalize,
    CHARSET,
    PREFIX,
};
