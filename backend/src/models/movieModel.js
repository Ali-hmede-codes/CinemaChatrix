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
 * title search. Powers the user app's paginated Films tab (infinite scroll).
 * @param {{limit?:number, offset?:number, q?:string}} opts
 * @returns {object[]}
 */
function findPublishedPaged({ limit = 24, offset = 0, q = '' } = {}) {
    const cols = `id, title, slug, description, poster_path, thumbnail_path,
                  duration, file_size, quality, created_at`;
    if (q) {
        return getDb().prepare(`
            SELECT ${cols}
            FROM movies
            WHERE is_published = 1 AND title LIKE ? ESCAPE '\\'
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `).all(likeParam(q), limit, offset);
    }
    return getDb().prepare(`
        SELECT ${cols}
        FROM movies
        WHERE is_published = 1
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
}

/**
 * Total number of published films (optionally matching a title search).
 * Used to compute `has_more` for pagination.
 * @param {string} q
 * @returns {number}
 */
function countPublished(q = '') {
    if (q) {
        return getDb().prepare(
            `SELECT COUNT(*) AS n FROM movies WHERE is_published = 1 AND title LIKE ? ESCAPE '\\'`
        ).get(likeParam(q)).n;
    }
    return getDb().prepare('SELECT COUNT(*) AS n FROM movies WHERE is_published = 1').get().n;
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
