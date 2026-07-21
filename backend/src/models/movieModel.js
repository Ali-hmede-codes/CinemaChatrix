/**
 * Movie model — database operations for the `movies` table.
 * All queries use parameterized statements (? placeholders).
 */

const { getDb } = require('../config/database');

/**
 * Turn a raw search term into a safe LIKE pattern. User input can contain the
 * LIKE wildcards % and _ (and the escape char \), so we escape them and match
 * with `ESCAPE '\'` to keep the search literal.
 */
function likeParam(q) {
    const escaped = String(q).replace(/[\\%_]/g, (c) => '\\' + c);
    return `%${escaped}%`;
}

/**
 * Build the shared WHERE clause (+ named params) for the public, paginated
 * film queries. Supports an optional title search and an optional category
 * filter. A category filter matches films tagged with that category OR — when
 * it's a main category — any of its sub-categories.
 */
function buildPublishedWhere({ q = '', categoryId = null } = {}) {
    const clauses = ['is_published = 1'];
    const params = {};
    if (q) {
        clauses.push("title LIKE @q ESCAPE '\\'");
        params.q = likeParam(q);
    }
    if (categoryId) {
        clauses.push(`id IN (
            SELECT cc.movie_id FROM content_categories cc
            JOIN categories c ON c.id = cc.category_id
            WHERE cc.category_id = @categoryId OR c.parent_id = @categoryId
        )`);
        params.categoryId = Number(categoryId);
    }
    return { where: clauses.join(' AND '), params };
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

function findAll() {
    return getDb()
        .prepare('SELECT * FROM movies ORDER BY created_at DESC')
        .all();
}

/**
 * Published films only, newest first, without the private `video_path`.
 * Used by the public user app (catalog / browse).
 * @returns {object[]}
 */
function findPublished() {
    return getDb().prepare(`
        SELECT id, title, slug, description, poster_path, thumbnail_path,
               duration, file_size, quality, created_at
        FROM movies
        WHERE is_published = 1
        ORDER BY created_at DESC
    `).all();
}

/**
 * A single page of published films, newest first, optionally filtered by a
 * title search and/or a category. Powers the user app's paginated Films tab.
 * @param {{limit?:number, offset?:number, q?:string, categoryId?:number}} opts
 * @returns {object[]}
 */
function findPublishedPaged({ limit = 24, offset = 0, q = '', categoryId = null } = {}) {
    const cols = `id, title, slug, description, poster_path, thumbnail_path,
                  duration, file_size, quality, created_at`;
    const { where, params } = buildPublishedWhere({ q, categoryId });
    return getDb().prepare(`
        SELECT ${cols}
        FROM movies
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });
}

/**
 * Total number of published films matching the same optional title search and
 * category filter. Used to compute `has_more` for pagination.
 * @param {{q?:string, categoryId?:number}} opts
 * @returns {number}
 */
function countPublished({ q = '', categoryId = null } = {}) {
    const { where, params } = buildPublishedWhere({ q, categoryId });
    return getDb().prepare(`SELECT COUNT(*) AS n FROM movies WHERE ${where}`).get(params).n;
}

function findById(id) {
    return getDb().prepare('SELECT * FROM movies WHERE id = ?').get(id);
}

function findBySlug(slug) {
    return getDb().prepare('SELECT * FROM movies WHERE slug = ?').get(slug);
}

function slugExists(slug) {
    return !!getDb().prepare('SELECT 1 FROM movies WHERE slug = ?').get(slug);
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert a new movie.
 * @param {object} m
 * @returns {object} the created movie row
 */
function create(m) {
    const info = getDb().prepare(`
        INSERT INTO movies
            (title, slug, description, poster_path, video_path, thumbnail_path,
             duration, file_size, quality, is_published)
        VALUES
            (@title, @slug, @description, @poster_path, @video_path, @thumbnail_path,
             @duration, @file_size, @quality, @is_published)
    `).run({
        title: m.title,
        slug: m.slug,
        description: m.description ?? null,
        poster_path: m.poster_path ?? null,
        video_path: m.video_path,
        thumbnail_path: m.thumbnail_path ?? null,
        duration: m.duration ?? null,
        file_size: m.file_size ?? null,
        quality: m.quality ?? '1080p',
        is_published: m.is_published ?? 1,
    });
    return findById(info.lastInsertRowid);
}

/**
 * Update editable movie fields (only provided keys are changed).
 * @param {number} id
 * @param {object} fields
 * @returns {object|undefined} updated row
 */
function update(id, fields) {
    const allowed = ['title', 'description', 'poster_path', 'quality', 'is_published'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length === 0) return findById(id);

    const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
    const params = { id };
    keys.forEach((k) => { params[k] = fields[k]; });

    getDb().prepare(`UPDATE movies SET ${setClause} WHERE id = @id`).run(params);
    return findById(id);
}

function deleteById(id) {
    const info = getDb().prepare('DELETE FROM movies WHERE id = ?').run(id);
    return info.changes > 0;
}

module.exports = {
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
};
