/**
 * Code model — database operations for the `codes` table.
 *
 * A code is tied to exactly ONE movie OR ONE episode (enforced by a CHECK
 * constraint in schema.sql). A code can be redeemed ONCE and is then bound
 * to ONE device forever.
 *
 * All queries use parameterized statements (? / @named placeholders).
 */

const { getDb } = require('../config/database');

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

function findById(id) {
    return getDb().prepare('SELECT * FROM codes WHERE id = ?').get(id);
}

function findByCode(code) {
    return getDb().prepare('SELECT * FROM codes WHERE code = ?').get(code);
}

/**
 * True if a code string already exists (used during generation to
 * guarantee uniqueness).
 * @param {string} code
 * @returns {boolean}
 */
function codeExists(code) {
    return !!getDb().prepare('SELECT 1 FROM codes WHERE code = ?').get(code);
}

/**
 * Find a code joined with its target (movie, episode, or series) so callers
 * get a human-friendly title/slug for the unlocked content.
 * @param {string} code
 * @returns {object|undefined}
 */
function findByCodeDetailed(code) {
    return getDb().prepare(`
        SELECT
            c.*,
            m.title  AS movie_title,   m.slug AS movie_slug,
            e.title  AS episode_title, e.slug AS episode_slug,
            e.season_number AS episode_season, e.episode_number AS episode_num,
            eps.id   AS ep_series_id,  eps.title AS ep_series_title, eps.slug AS ep_series_slug,
            cs.title AS code_series_title, cs.slug AS code_series_slug
        FROM codes c
        LEFT JOIN movies   m   ON c.movie_id   = m.id
        LEFT JOIN episodes e   ON c.episode_id = e.id
        LEFT JOIN series   eps ON e.series_id  = eps.id
        LEFT JOIN series   cs  ON c.series_id  = cs.id
        WHERE c.code = ?
    `).get(code);
}

/**
 * List codes (newest first) joined with their target, with optional filters.
 * @param {object} [filters] - { movie_id?, episode_id?, series_id?, status? ('used'|'unused') }
 * @returns {object[]}
 */
function listDetailed(filters = {}) {
    const where = [];
    const params = {};

    if (filters.movie_id) { where.push('c.movie_id = @movie_id'); params.movie_id = Number(filters.movie_id); }
    if (filters.episode_id) { where.push('c.episode_id = @episode_id'); params.episode_id = Number(filters.episode_id); }
    if (filters.series_id) { where.push('c.series_id = @series_id'); params.series_id = Number(filters.series_id); }
    if (filters.status === 'used') where.push('c.is_used = 1');
    if (filters.status === 'unused') where.push('c.is_used = 0');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    return getDb().prepare(`
        SELECT
            c.*,
            m.title  AS movie_title,   m.slug AS movie_slug,
            e.title  AS episode_title, e.slug AS episode_slug,
            e.season_number AS episode_season, e.episode_number AS episode_num,
            eps.id   AS ep_series_id,  eps.title AS ep_series_title, eps.slug AS ep_series_slug,
            cs.title AS code_series_title, cs.slug AS code_series_slug
        FROM codes c
        LEFT JOIN movies   m   ON c.movie_id   = m.id
        LEFT JOIN episodes e   ON c.episode_id = e.id
        LEFT JOIN series   eps ON e.series_id  = eps.id
        LEFT JOIN series   cs  ON c.series_id  = cs.id
        ${whereSql}
        ORDER BY c.created_at DESC, c.id DESC
    `).all(params);
}

/**
 * Does this device have an active (redeemed) code for the given target?
 *
 * Access rules:
 *   - movie   : a used code with matching movie_id
 *   - episode : a used code for that episode OR for the series it belongs to
 *   - series  : a used code with matching series_id
 *
 * @param {number} deviceId
 * @param {object} target - { movieId?, episodeId?, seriesId? }
 * @returns {boolean}
 */
function checkAccess(deviceId, { movieId = null, episodeId = null, seriesId = null } = {}) {
    const db = getDb();
    if (movieId) {
        return !!db.prepare(
            'SELECT 1 FROM codes WHERE device_id = ? AND is_used = 1 AND movie_id = ?'
        ).get(deviceId, Number(movieId));
    }
    if (episodeId) {
        // Granted by a code for this specific episode OR for its whole series.
        return !!db.prepare(`
            SELECT 1 FROM codes
            WHERE device_id = ? AND is_used = 1
              AND ( episode_id = ?
                    OR series_id = (SELECT series_id FROM episodes WHERE id = ?) )
            LIMIT 1
        `).get(deviceId, Number(episodeId), Number(episodeId));
    }
    if (seriesId) {
        return !!db.prepare(
            'SELECT 1 FROM codes WHERE device_id = ? AND is_used = 1 AND series_id = ?'
        ).get(deviceId, Number(seriesId));
    }
    return false;
}

/* ------------------------------------------------------------------ */
/*  Library — content unlocked by a device                             */
/* ------------------------------------------------------------------ */

function getUnlockedMoviesByDevice(deviceId) {
    return getDb().prepare(`
        SELECT DISTINCT m.*
        FROM codes c
        JOIN movies m ON c.movie_id = m.id
        WHERE c.device_id = ? AND c.is_used = 1 AND c.movie_id IS NOT NULL
        ORDER BY c.used_at DESC
    `).all(deviceId);
}

function getUnlockedEpisodesByDevice(deviceId) {
    // Includes episodes unlocked directly AND every episode of any series
    // the device has a redeemed whole-series code for.
    return getDb().prepare(`
        SELECT DISTINCT e.*, s.title AS series_title, s.slug AS series_slug
        FROM episodes e
        JOIN series s ON e.series_id = s.id
        WHERE e.id IN (
            SELECT episode_id FROM codes
            WHERE device_id = ? AND is_used = 1 AND episode_id IS NOT NULL
        )
        OR e.series_id IN (
            SELECT series_id FROM codes
            WHERE device_id = ? AND is_used = 1 AND series_id IS NOT NULL
        )
        ORDER BY e.series_id, e.season_number, e.episode_number
    `).all(deviceId, deviceId);
}

function getUnlockedSeriesByDevice(deviceId) {
    return getDb().prepare(`
        SELECT DISTINCT s.*
        FROM codes c
        JOIN series s ON c.series_id = s.id
        WHERE c.device_id = ? AND c.is_used = 1 AND c.series_id IS NOT NULL
        ORDER BY c.used_at DESC
    `).all(deviceId);
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert many codes for a single target in one transaction.
 *
 * @param {object} opts
 * @param {string[]} opts.codes      - pre-generated unique code strings
 * @param {number|null} opts.movie_id
 * @param {number|null} opts.episode_id
 * @param {number|null} opts.series_id
 * @param {string|null} [opts.kind]  - 'film' | 'series' for universal (redeemer-chosen) codes
 * @param {number} opts.created_by   - admin id
 * @param {string|null} [opts.expires_at] - ISO datetime or null
 * @returns {object[]} the created code rows
 */
function createMany({ codes, movie_id = null, episode_id = null, series_id = null, kind = null, created_by, expires_at = null }) {
    const db = getDb();
    const insert = db.prepare(`
        INSERT INTO codes (code, movie_id, episode_id, series_id, kind, created_by, expires_at)
        VALUES (@code, @movie_id, @episode_id, @series_id, @kind, @created_by, @expires_at)
    `);

    const insertMany = db.transaction((rows) => {
        const ids = [];
        for (const code of rows) {
            const info = insert.run({ code, movie_id, episode_id, series_id, kind, created_by, expires_at });
            ids.push(info.lastInsertRowid);
        }
        return ids;
    });

    const ids = insertMany(codes);
    return ids.map(findById);
}

/**
 * Redeem a code: mark it used and bind it to a device.
 * @param {number} id
 * @param {number} deviceId
 * @returns {object} the updated code row
 */
function activate(id, deviceId) {
    getDb().prepare(`
        UPDATE codes
        SET is_used = 1, device_id = ?, used_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(deviceId, id);
    return findById(id);
}

/**
 * Redeem a UNIVERSAL code: write the redeemer-chosen target back onto the
 * code, then mark it used and bind it to a device — all in one statement so
 * it can never end up used-but-unbound. Pass exactly one of movie_id/series_id.
 * @param {number} id
 * @param {number} deviceId
 * @param {object} target - { movie_id? , series_id? }
 * @returns {object} the updated code row
 */
function bindAndActivate(id, deviceId, { movie_id = null, series_id = null } = {}) {
    getDb().prepare(`
        UPDATE codes
        SET movie_id = ?, series_id = ?, is_used = 1, device_id = ?, used_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(movie_id, series_id, deviceId, id);
    return findById(id);
}

function deleteById(id) {
    const info = getDb().prepare('DELETE FROM codes WHERE id = ?').run(id);
    return info.changes > 0;
}

module.exports = {
    findById,
    findByCode,
    findByCodeDetailed,
    codeExists,
    listDetailed,
    checkAccess,
    getUnlockedMoviesByDevice,
    getUnlockedEpisodesByDevice,
    getUnlockedSeriesByDevice,
    createMany,
    activate,
    bindAndActivate,
    deleteById,
};
