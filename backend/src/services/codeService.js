/**
 * Code generation service.
 *
 * Produces cryptographically-random unlock codes in the format:
 *
 *     CHX-XXXX-XXXX
 *
 *   CHX  = fixed prefix (CinemaChatrix)
 *   XXXX = 4 random chars from an unambiguous charset (no 0/O/1/I)
 *   XXXX = 4 random chars
 *
 * ~1.07e18 possible combinations, so collisions are astronomically
 * unlikely — but we still verify uniqueness against the database.
 */

const crypto = require('crypto');

// Unambiguous uppercase alphanumerics (excludes 0, O, 1, I to avoid typos)
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PREFIX = 'CHX';
const GROUP_LEN = 4;

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
 * Generate one code, e.g. "CHX-7K3M-9P2X".
 * @returns {string}
 */
function generateCode() {
    return `${PREFIX}-${randomGroup()}-${randomGroup()}`;
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
 * so "chx 7k3m 9p2x" and "CHX7K3M9P2X" both resolve correctly.
 *
 * @param {string} raw
 * @returns {string|null} normalized code, or null if it can't be parsed
 */
function normalize(raw) {
    if (!raw) return null;
    const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cleaned.startsWith(PREFIX)) return null;

    const body = cleaned.slice(PREFIX.length);
    if (body.length !== GROUP_LEN * 2) return null;

    return `${PREFIX}-${body.slice(0, GROUP_LEN)}-${body.slice(GROUP_LEN)}`;
}

module.exports = {
    generateCode,
    generateUnique,
    normalize,
    CHARSET,
    PREFIX,
};
