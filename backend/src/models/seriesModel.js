/**
 * Series model — database operations for `series` and its `episodes`.
 * All queries use parameterized statements (? placeholders).
 */

const { getDb } = require('../config/database');

/**
 * Turn a raw search term into a safe LIKE pattern (escapes % _ and \ so the
 * user's text is matched literally with `ESCAPE '\'`).
 */
function likeParam(q) {
    const escaped = String(q).replace(/[\\%_]/g, (c) => '\\' + c);
    return `%${escaped}%`;
}

/**
 * Build the shared WHERE clause (+ named params) for the public, paginated
 * series queries. Uses the `s` alias. Supports an optional title search and an
 * optional category filter (matches a series tagged with the category OR, when
 * it's a main category, any of its sub-categories).
 */
function buildPublishedWhere({ q = '', categoryId = null } = {}) {
    const clauses = ['s.is_published = 1'];
    const params = {};
    if (q) {
        clauses.push("s.title LIKE @q ESCAPE '\\'");
        params.q = likeParam(q);
    }
    if (categoryId) {
        clauses.push(`s.id IN (
            SELECT cc.series_id FROM content_categories cc
            JOIN categories c ON c.id = cc.category_id
            WHERE cc.category_id = @categoryId OR c.parent_id = @categoryId
        )`);
        params.categoryId = Number(categoryId);
    }
    return { where: clauses.join(' AND '), params };
}

/* ================================================================== */
/*  SERIES                                                             */
/* ================================================================== */

function findAll() {
    return getDb().prepare('SELECT * FROM series ORDER BY created_at DESC').all();
}

/**
 * Published series only, newest first, each with an `episode_count`.
 * Used by the public user app (catalog / browse).
 * @returns {object[]}
 */
function findPublished() {
    return getDb().prepare(`
        SELECT s.id, s.title, s.slug, s.description, s.poster_path, s.created_at,
               COUNT(e.id) AS episode_count
        FROM series s
        LEFT JOIN episodes e ON e.series_id = s.id
        WHERE s.is_published = 1
        GROUP BY s.id
        ORDER BY s.created_at DESC
    `).all();
}

/**
 * A single page of published series (each with its episode count), newest
 * first, optionally filtered by a title search and/or a category. Powers the
 * paginated Series tab (infinite scroll).
 * @param {{limit?:number, offset?:number, q?:string, categoryId?:number}} opts
 * @returns {object[]}
 */
function findPublishedPaged({ limit = 24, offset = 0, q = '', categoryId = null } = {}) {
    const { where, params } = buildPublishedWhere({ q, categoryId });
    return getDb().prepare(`
        SELECT s.id, s.title, s.slug, s.description, s.poster_path, s.created_at,
               COUNT(e.id) AS episode_count
        FROM series s
        LEFT JOIN episodes e ON e.series_id = s.id
        WHERE ${where}
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });
}

/**
 * Total number of published series matching the same optional title search and
 * category filter.
 * @param {{q?:string, categoryId?:number}} opts
 * @returns {number}
 */
function countPublished({ q = '', categoryId = null } = {}) {
    const { where, params } = buildPublishedWhere({ q, categoryId });
    return getDb().prepare(`SELECT COUNT(*) AS n FROM series s WHERE ${where}`).get(params).n;
}

function findById(id) {
    return getDb().prepare('SELECT * FROM series WHERE id = ?').get(id);
}

function findBySlug(slug) {
    return getDb().prepare('SELECT * FROM series WHERE slug = ?').get(slug);
}

function slugExists(slug) {
    return !!getDb().prepare('SELECT 1 FROM series WHERE slug = ?').get(slug);
}

function create(s) {
    const info = getDb().prepare(`
        INSERT INTO series (title, slug, description, poster_path, is_published)
        VALUES (@title, @slug, @description, @poster_path, @is_published)
    `).run({
        title: s.title,
        slug: s.slug,
        description: s.description ?? null,
        poster_path: s.poster_path ?? null,
        is_published: s.is_published ?? 1,
    });
    return findById(info.lastInsertRowid);
}

function update(id, fields) {
    const allowed = ['title', 'description', 'poster_path', 'is_published'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length === 0) return findById(id);

    const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
    const params = { id };
    keys.forEach((k) => { params[k] = fields[k]; });

    getDb().prepare(`UPDATE series SET ${setClause} WHERE id = @id`).run(params);
    return findById(id);
}

function deleteById(id) {
    // Episodes are removed automatically via ON DELETE CASCADE.
    const info = getDb().prepare('DELETE FROM series WHERE id = ?').run(id);
    return info.changes > 0;
}

/* ================================================================== */
/*  EPISODES                                                           */
/* ================================================================== */

function findEpisodesBySeries(seriesId) {
    return getDb().prepare(`
        SELECT * FROM episodes
        WHERE series_id = ?
        ORDER BY season_number ASC, episode_number ASC
    `).all(seriesId);
}

function findEpisodeById(id) {
    return getDb().prepare('SELECT * FROM episodes WHERE id = ?').get(id);
}

function findEpisodeBySlug(slug) {
    return getDb().prepare('SELECT * FROM episodes WHERE slug = ?').get(slug);
}

function episodeSlugExists(slug) {
    return !!getDb().prepare('SELECT 1 FROM episodes WHERE slug = ?').get(slug);
}

function createEpisode(e) {
    const info = getDb().prepare(`
        INSERT INTO episodes
            (series_id, season_number, episode_number, title, slug, description,
             video_path, thumbnail_path, duration, file_size, quality)
        VALUES
            (@series_id, @season_number, @episode_number, @title, @slug, @description,
             @video_path, @thumbnail_path, @duration, @file_size, @quality)
    `).run({
        series_id: e.series_id,
        season_number: e.season_number ?? 1,
        episode_number: e.episode_number,
        title: e.title,
        slug: e.slug,
        description: e.description ?? null,
        video_path: e.video_path,
        thumbnail_path: e.thumbnail_path ?? null,
        duration: e.duration ?? null,
        file_size: e.file_size ?? null,
        quality: e.quality ?? '1080p',
    });
    return findEpisodeById(info.lastInsertRowid);
}

/**
 * Update editable episode fields (only provided keys are changed).
 * @param {number} id
 * @param {object} fields
 * @returns {object|undefined} updated row
 */
function updateEpisode(id, fields) {
    const allowed = ['season_number', 'episode_number', 'title', 'description', 'quality', 'thumbnail_path'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length === 0) return findEpisodeById(id);

    const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
    const params = { id };
    keys.forEach((k) => { params[k] = fields[k]; });

    getDb().prepare(`UPDATE episodes SET ${setClause} WHERE id = @id`).run(params);
    return findEpisodeById(id);
}

function deleteEpisodeById(id) {
    const info = getDb().prepare('DELETE FROM episodes WHERE id = ?').run(id);
    return info.changes > 0;
}

module.exports = {
    // series
    findAll,
    findPublished,
    findPublishedPaged,
    countPublished,
    findById,
    findBySlug,
    slugExists,
    create,
    update,
    deleteById,
    // episodes
    findEpisodesBySeries,
    findEpisodeById,
    findEpisodeBySlug,
    episodeSlugExists,
    createEpisode,
    updateEpisode,
    deleteEpisodeById,
};
