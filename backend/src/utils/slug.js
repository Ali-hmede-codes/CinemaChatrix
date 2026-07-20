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

module.exports = { toSlug, uniqueSlug };
