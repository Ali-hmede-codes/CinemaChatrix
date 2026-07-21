/**
 * Category model — database operations for `categories` and the
 * `content_categories` link table.
 *
 * Categories form a simple two-level tree:
 *   - main category    → parent_id IS NULL
 *   - sub-category      → parent_id = <a main category id>
 *
 * The same set is shared by films and series. A film/series can be tagged with
 * many categories (main and/or sub), managed through `content_categories`.
 *
 * All queries use parameterized statements (? / @named placeholders).
 */

const { getDb } = require('../config/database');
const { toCategorySlug } = require('../utils/slug');

/* ------------------------------------------------------------------ */
/*  Slug helper (unique within a level)                                */
/* ------------------------------------------------------------------ */

/**
 * Does `slug` already exist among siblings (same parent), excluding `excludeId`?
 * NULL parent is normalised to 0 so main categories compare against each other.
 */
function slugExistsInParent(slug, parentId, excludeId = null) {
    return !!getDb().prepare(`
        SELECT 1 FROM categories
        WHERE slug = ?
          AND COALESCE(parent_id, 0) = COALESCE(?, 0)
          AND id != COALESCE(?, -1)
    `).get(slug, parentId ?? null, excludeId ?? null);
}

/**
 * Build a slug for `name` that is unique among its siblings. Appends a short
 * random suffix on collision.
 */
function makeUniqueSlug(name, parentId, excludeId = null) {
    const base = toCategorySlug(name);
    let slug = base;
    while (slugExistsInParent(slug, parentId, excludeId)) {
        slug = `${base}-${Math.random().toString(16).slice(2, 6)}`;
    }
    return slug;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

function findById(id) {
    return getDb().prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

/** All categories, ordered for display (mains first, then by sort/name). */
function findAllFlat() {
    return getDb().prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM content_categories cc WHERE cc.category_id = c.id) AS usage_count
        FROM categories c
        ORDER BY COALESCE(c.parent_id, 0), c.sort_order, c.name COLLATE NOCASE
    `).all();
}

/**
 * The full category tree: an array of main categories, each with a nested
 * `children` array of its sub-categories.
 * @returns {Array<object>}
 */
function findTree() {
    const rows = findAllFlat();
    const mains = [];
    const byId = new Map();

    for (const row of rows) {
        const node = { ...row, children: [] };
        byId.set(node.id, node);
    }
    for (const node of byId.values()) {
        if (node.parent_id && byId.has(node.parent_id)) {
            byId.get(node.parent_id).children.push(node);
        } else if (!node.parent_id) {
            mains.push(node);
        }
    }
    // Preserve the SQL ordering inside each level.
    const order = new Map(rows.map((r, i) => [r.id, i]));
    mains.sort((a, b) => order.get(a.id) - order.get(b.id));
    mains.forEach((m) => m.children.sort((a, b) => order.get(a.id) - order.get(b.id)));
    return mains;
}

/**
 * Keep only the ids that point at real categories, in a stable de-duplicated
 * order. Guards the link table against bad input.
 * @param {number[]} ids
 * @returns {number[]}
 */
function filterValidIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const clean = [...new Set(ids.map(Number).filter(Number.isInteger))];
    if (clean.length === 0) return [];
    const placeholders = clean.map(() => '?').join(',');
    const found = getDb()
        .prepare(`SELECT id FROM categories WHERE id IN (${placeholders})`)
        .all(...clean)
        .map((r) => r.id);
    const validSet = new Set(found);
    return clean.filter((id) => validSet.has(id));
}

/* ------------------------------------------------------------------ */
/*  Writes (categories)                                                */
/* ------------------------------------------------------------------ */

/**
 * Create a category. Pass `parent_id` to create a sub-category, or leave it
 * null/undefined for a main category.
 * @param {{name:string, parent_id?:number|null, sort_order?:number}} c
 * @returns {object} the created row
 */
function create(c) {
    const parentId = c.parent_id ?? null;
    const name = String(c.name).trim();
    const slug = makeUniqueSlug(name, parentId);

    const info = getDb().prepare(`
        INSERT INTO categories (name, slug, parent_id, sort_order)
        VALUES (@name, @slug, @parent_id, @sort_order)
    `).run({
        name,
        slug,
        parent_id: parentId,
        sort_order: c.sort_order ?? 0,
    });
    return findById(info.lastInsertRowid);
}

/**
 * Update a category's editable fields (name and/or sort_order). Renaming
 * regenerates the slug (kept unique within the level).
 * @param {number} id
 * @param {{name?:string, sort_order?:number}} fields
 * @returns {object|undefined} the updated row
 */
function update(id, fields) {
    const current = findById(id);
    if (!current) return undefined;

    const params = { id };
    const sets = [];

    if (fields.name !== undefined) {
        const name = String(fields.name).trim();
        sets.push('name = @name', 'slug = @slug');
        params.name = name;
        params.slug = makeUniqueSlug(name, current.parent_id ?? null, id);
    }
    if (fields.sort_order !== undefined) {
        sets.push('sort_order = @sort_order');
        params.sort_order = Number(fields.sort_order) || 0;
    }
    if (sets.length === 0) return current;

    getDb().prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return findById(id);
}

/** Delete a category. Sub-categories and assignments cascade automatically. */
function deleteById(id) {
    const info = getDb().prepare('DELETE FROM categories WHERE id = ?').run(id);
    return info.changes > 0;
}

/* ------------------------------------------------------------------ */
/*  Assignments (content_categories)                                   */
/* ------------------------------------------------------------------ */

/**
 * Replace all category assignments for a movie (or series) with `categoryIds`.
 * Invalid ids are silently dropped. Runs in a transaction.
 * @param {'movie'|'series'} kind
 * @param {number} contentId
 * @param {number[]} categoryIds
 */
function setAssignments(kind, contentId, categoryIds) {
    const col = kind === 'series' ? 'series_id' : 'movie_id';
    const valid = filterValidIds(categoryIds);
    const db = getDb();

    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM content_categories WHERE ${col} = ?`).run(contentId);
        if (valid.length) {
            const insert = db.prepare(
                `INSERT OR IGNORE INTO content_categories (category_id, ${col}) VALUES (?, ?)`
            );
            for (const cid of valid) insert.run(cid, contentId);
        }
    });
    tx();
    return valid;
}

function setForMovie(movieId, categoryIds) {
    return setAssignments('movie', movieId, categoryIds);
}

function setForSeries(seriesId, categoryIds) {
    return setAssignments('series', seriesId, categoryIds);
}

/** Category rows attached to one movie (or series), with parent names. */
function findForContent(kind, contentId) {
    const col = kind === 'series' ? 'series_id' : 'movie_id';
    return getDb().prepare(`
        SELECT c.id, c.name, c.slug, c.parent_id,
               p.name AS parent_name, p.slug AS parent_slug
        FROM content_categories cc
        JOIN categories c ON c.id = cc.category_id
        LEFT JOIN categories p ON p.id = c.parent_id
        WHERE cc.${col} = ?
        ORDER BY COALESCE(c.parent_id, 0), c.sort_order, c.name COLLATE NOCASE
    `).all(contentId);
}

function findForMovie(movieId) {
    return findForContent('movie', movieId);
}

function findForSeries(seriesId) {
    return findForContent('series', seriesId);
}

/**
 * Batch-load categories for many movies (or series) at once, avoiding N+1
 * queries. Returns a Map of contentId → category[].
 * @param {'movie'|'series'} kind
 * @param {number[]} ids
 * @returns {Map<number, object[]>}
 */
function mapForContent(kind, ids) {
    const map = new Map();
    if (!Array.isArray(ids) || ids.length === 0) return map;
    const col = kind === 'series' ? 'series_id' : 'movie_id';
    const clean = [...new Set(ids.map(Number).filter(Number.isInteger))];
    if (clean.length === 0) return map;
    const placeholders = clean.map(() => '?').join(',');

    const rows = getDb().prepare(`
        SELECT cc.${col} AS content_id,
               c.id, c.name, c.slug, c.parent_id,
               p.name AS parent_name, p.slug AS parent_slug
        FROM content_categories cc
        JOIN categories c ON c.id = cc.category_id
        LEFT JOIN categories p ON p.id = c.parent_id
        WHERE cc.${col} IN (${placeholders})
        ORDER BY COALESCE(c.parent_id, 0), c.sort_order, c.name COLLATE NOCASE
    `).all(...clean);

    for (const row of rows) {
        const { content_id, ...cat } = row;
        if (!map.has(content_id)) map.set(content_id, []);
        map.get(content_id).push(cat);
    }
    return map;
}

module.exports = {
    // reads
    findById,
    findAllFlat,
    findTree,
    filterValidIds,
    // writes
    create,
    update,
    deleteById,
    // assignments
    setForMovie,
    setForSeries,
    findForMovie,
    findForSeries,
    mapForContent,
};
