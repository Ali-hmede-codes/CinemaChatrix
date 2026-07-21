/**
 * Catalog controller — the PUBLIC browse surface for the user app.
 *
 * These endpoints expose only published content and never leak private
 * filesystem paths (the `video_path` column). They power the Home, Movies,
 * and Series tabs of the user app.
 *
 *   GET /api/catalog/home     films + series in one call (for the home feed)
 *   GET /api/catalog/films    published films
 *   GET /api/catalog/series   published series (with episode counts)
 *   GET /api/catalog/film/:slug     single film (public detail)
 *   GET /api/catalog/series/:slug   single series + its episodes (public detail)
 *
 * IMPORTANT: nothing here reveals whether the current device owns the
 * content — ownership is resolved separately via /api/library so the browse
 * responses can be cached and are identical for everyone.
 */

const movieModel = require('../models/movieModel');
const seriesModel = require('../models/seriesModel');
const categoryModel = require('../models/categoryModel');
const paths = require('../config/paths');
const response = require('../utils/response');

/* ------------------------------------------------------------------ */
/*  Shaping helpers                                                    */
/* ------------------------------------------------------------------ */

/** Public film card — poster always resolves to something displayable. */
function shapeFilm(m) {
    return {
        type: 'film',
        id: m.id,
        title: m.title,
        slug: m.slug,
        description: m.description,
        poster: m.poster_path || m.thumbnail_path || paths.DEFAULT_IMAGE_URL,
        duration: m.duration,
        quality: m.quality,
        categories: m.categories || [],
        created_at: m.created_at,
    };
}

/** Public series card. */
function shapeSeries(s) {
    return {
        type: 'series',
        id: s.id,
        title: s.title,
        slug: s.slug,
        description: s.description,
        poster: s.poster_path || paths.DEFAULT_IMAGE_URL,
        episode_count: s.episode_count ?? 0,
        categories: s.categories || [],
        created_at: s.created_at,
    };
}

/**
 * Attach a `categories` array to each row in place (batch, no N+1), then return
 * the rows so callers can map them straight through a shaper.
 * @param {'movie'|'series'} kind
 * @param {object[]} rows
 */
function attachCategories(kind, rows) {
    const map = categoryModel.mapForContent(kind, rows.map((r) => r.id));
    rows.forEach((r) => { r.categories = map.get(r.id) || []; });
    return rows;
}

/* ------------------------------------------------------------------ */
/*  Pagination helper                                                  */
/* ------------------------------------------------------------------ */

/** Parse ?page, ?limit and ?q into a safe { page, limit, offset, q }. */
function parsePaging(req) {
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(limit) || limit < 1) limit = 24;
    limit = Math.min(limit, 60); // hard cap so a client can't request everything
    const q = (req.query.q || '').toString().trim().slice(0, 100);
    return { page, limit, offset: (page - 1) * limit, q };
}

/** Parse an optional ?category=<id> filter into a positive integer or null. */
function parseCategoryId(req) {
    const raw = req.query.category;
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/* ------------------------------------------------------------------ */
/*  GET /api/catalog/home                                              */
/* ------------------------------------------------------------------ */

function home(req, res) {
    // Home only needs enough to fill the rails — the first page of each kind.
    // The paginated Films/Series tabs load the rest on demand.
    const films = attachCategories('movie', movieModel.findPublishedPaged({ limit: 12, offset: 0 })).map(shapeFilm);
    const series = attachCategories('series', seriesModel.findPublishedPaged({ limit: 12, offset: 0 })).map(shapeSeries);

    // "Newly added" = the most recent items across both kinds. The newest 12
    // overall are guaranteed to live inside the newest 12 of each list.
    const newly = [...films, ...series]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 12);

    // The category tree so the home screen can render browse-by-category rails.
    const categories = categoryModel.findTree();

    return response.success(res, { films, series, newly, categories }, 'Catalog');
}

/* ------------------------------------------------------------------ */
/*  GET /api/catalog/films?page=&limit=&q=&category=                   */
/* ------------------------------------------------------------------ */

function films(req, res) {
    const { page, limit, offset, q } = parsePaging(req);
    const categoryId = parseCategoryId(req);
    const rows = movieModel.findPublishedPaged({ limit, offset, q, categoryId });
    const items = attachCategories('movie', rows).map(shapeFilm);
    const total = movieModel.countPublished({ q, categoryId });
    return response.success(res, {
        films: items,
        page,
        limit,
        total,
        has_more: offset + items.length < total,
    }, 'Films');
}

/* ------------------------------------------------------------------ */
/*  GET /api/catalog/series?page=&limit=&q=&category=                  */
/* ------------------------------------------------------------------ */

function series(req, res) {
    const { page, limit, offset, q } = parsePaging(req);
    const categoryId = parseCategoryId(req);
    const rows = seriesModel.findPublishedPaged({ limit, offset, q, categoryId });
    const items = attachCategories('series', rows).map(shapeSeries);
    const total = seriesModel.countPublished({ q, categoryId });
    return response.success(res, {
        series: items,
        page,
        limit,
        total,
        has_more: offset + items.length < total,
    }, 'Series');
}

/* ------------------------------------------------------------------ */
/*  GET /api/catalog/film/:slug                                        */
/* ------------------------------------------------------------------ */

function filmDetail(req, res) {
    const m = movieModel.findBySlug(req.params.slug);
    if (!m || !m.is_published) return response.notFound(res, 'Film');
    m.categories = categoryModel.findForMovie(m.id);
    return response.success(res, { film: shapeFilm(m) }, 'Film detail');
}

/* ------------------------------------------------------------------ */
/*  GET /api/catalog/series/:slug                                      */
/* ------------------------------------------------------------------ */

function seriesDetail(req, res) {
    const s = seriesModel.findBySlug(req.params.slug);
    if (!s || !s.is_published) return response.notFound(res, 'Series');

    s.categories = categoryModel.findForSeries(s.id);

    const episodes = seriesModel.findEpisodesBySeries(s.id).map((ep) => ({
        id: ep.id,
        slug: ep.slug,
        season_number: ep.season_number,
        episode_number: ep.episode_number,
        title: ep.title,
        description: ep.description,
        duration: ep.duration,
        quality: ep.quality,
        // Episodes fall back to the series poster (then the bundled default).
        thumbnail: ep.thumbnail_path || s.poster_path || paths.DEFAULT_IMAGE_URL,
    }));

    return response.success(
        res,
        { series: { ...shapeSeries(s), episode_count: episodes.length }, episodes },
        'Series detail'
    );
}

/* ------------------------------------------------------------------ */
/*  GET /api/catalog/category-rows?limit=                              */
/* ------------------------------------------------------------------ */

/**
 * One "rail" per category (mains first, each followed by its sub-categories),
 * containing the latest N published titles — films and series mixed, newest
 * first. Powers the browse-by-category rows on the user app's home screen.
 * A main-category rail includes titles tagged with the main OR any of its subs.
 * Categories with no published content are omitted.
 */
function categoryRows(req, res) {
    let perRow = parseInt(req.query.limit, 10);
    if (!Number.isFinite(perRow) || perRow < 1) perRow = 5;
    perRow = Math.min(perRow, 12);

    // Flatten the tree into display order: each main, then its children.
    const nodes = [];
    for (const main of categoryModel.findTree()) {
        nodes.push(main);
        for (const sub of main.children || []) nodes.push(sub);
    }

    const rows = [];
    for (const cat of nodes) {
        const films = movieModel.findPublishedPaged({ categoryId: cat.id, limit: perRow }).map(shapeFilm);
        const series = seriesModel.findPublishedPaged({ categoryId: cat.id, limit: perRow }).map(shapeSeries);
        const items = [...films, ...series]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, perRow);
        if (items.length) {
            rows.push({
                id: cat.id,
                name: cat.name,
                slug: cat.slug,
                parent_id: cat.parent_id,
                is_main: !cat.parent_id,
                items,
            });
        }
    }

    return response.success(res, { rows }, 'Category rows');
}

module.exports = {
    home,
    films,
    series,
    filmDetail,
    seriesDetail,
    categoryRows,
};
