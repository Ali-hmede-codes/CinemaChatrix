/**
 * URL slug utilities.
 *
 * Wraps the 'slugify' package with project-specific defaults and
 * adds a uniqueness helper that appends a short suffix if a slug
 * already exists in the database.
 */

const slugify = require('slugify');
const crypto = require('crypto');

/**
 * Convert a title to a URL-safe slug.
 *
 * @param {string} title
 * @returns {string} e.g. "Inception 2010!" → "inception-2010"
 */
function toSlug(title) {
    return slugify(title, {
        lower: true,
        strict: true,   // remove special characters
        locale: 'en',
    });
}

/**
 * Generate a unique slug by appending a short random suffix if needed.
 *
 * @param {string} title
 * @param {function} existsFn - async or sync function(slug) => boolean
 * @returns {string} a slug guaranteed to be unique
 */
function uniqueSlug(title, existsFn) {
    const base = toSlug(title);
    let slug = base;
    let attempt = 0;

    while (existsFn(slug)) {
        attempt++;
        const suffix = crypto.randomBytes(2).toString('hex'); // 4 chars
        slug = `${base}-${suffix}`;
    }

    return slug;
}

/**
 * Slugify a category name, guaranteeing a non-empty result.
 *
 * Under `strict` mode `toSlug` drops every character it can't transliterate,
 * so a purely non-Latin name (e.g. Arabic "دراما") slugifies to an empty
 * string. When that happens we fall back to a short, stable token derived from
 * a hash of the name so the same name always yields the same base slug.
 * Uniqueness (per level) is still enforced by the caller.
 *
 * @param {string} name
 * @returns {string} a non-empty slug base
 */
function toCategorySlug(name) {
    const base = toSlug(name);
    if (base) return base;
    const hash = crypto.createHash('md5').update(String(name || '')).digest('hex');
    return `cat-${hash.slice(0, 8)}`;
}

module.exports = { toSlug, uniqueSlug, toCategorySlug };
