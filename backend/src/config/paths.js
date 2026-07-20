/**
 * Centralized path constants.
 *
 * Every path in the application is derived from here so there's
 * a single source of truth. No other file should use path.join()
 * with hard-coded strings.
 */

const path = require('path');
const fs = require('fs-extra');
const env = require('./env');

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

// backend/  (the directory that contains server.js)
const ROOT = path.join(__dirname, '..', '..');

/* ------------------------------------------------------------------ */
/*  Directories                                                        */
/* ------------------------------------------------------------------ */

const DIRS = {
    root: ROOT,
    src: path.join(ROOT, 'src'),
    config: path.join(ROOT, 'src', 'config'),
    images: path.join(ROOT, 'src', 'images'), // bundled images (e.g. default fallback)

    // Database
    database: path.join(ROOT, 'database'),
    dbFile: path.join(ROOT, env.database.path),

    // Schema
    schemaSql: path.join(ROOT, 'src', 'db', 'schema.sql'),

    // Uploads
    uploads: path.join(ROOT, 'uploads'),
    uploadsTemp: path.join(ROOT, 'uploads', '_temp'),

    // Public
    public: path.join(ROOT, 'public'),
    posters: path.join(ROOT, 'public', 'posters'),
    thumbnails: path.join(ROOT, 'public', 'thumbnails'),

    // Logs
    logs: path.join(ROOT, 'logs'),
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Ensures all runtime directories exist on disk.
 * Called once during server startup.
 */
function ensureDirectories() {
    const dirsToEnsure = [
        DIRS.database,
        DIRS.uploads,
        DIRS.uploadsTemp,
        DIRS.public,
        DIRS.posters,
        DIRS.thumbnails,
        DIRS.logs,
    ];
    for (const dir of dirsToEnsure) {
        fs.ensureDirSync(dir);
    }
}

/**
 * Builds a structured video storage path, auto-creating a dedicated folder
 * for each film (or for each series, shared by its episodes).
 *
 * Pattern (film):   uploads/YYYY-MM-DD/films/{slug}/{slug}.mp4
 * Pattern (series): uploads/YYYY-MM-DD/series/{seriesSlug}/{episodeSlug}.mp4
 *
 * @param {'film'|'series'} category
 * @param {string} slug - already-slugified title (used for the file name)
 * @param {string} ext - file extension without dot (default 'mp4')
 * @param {string} [groupSlug] - folder name to group files under
 *                               (e.g. the series slug so all episodes share
 *                               one folder). Defaults to `slug` → one folder
 *                               per film.
 * @returns {string} absolute path for the output video file
 */
function buildVideoPath(category, slug, ext = 'mp4', groupSlug = null) {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const folder = category === 'series' ? 'series' : 'films';
    const group = groupSlug || slug;
    const dir = path.join(DIRS.uploads, date, folder, group);
    fs.ensureDirSync(dir); // auto-create the per-title folder
    return path.join(dir, `${slug}.${ext}`);
}

/**
 * Builds a poster image path.
 * Pattern: public/posters/YYYY-MM-DD/{films|series}/{slug}.{ext}
 *
 * @param {'film'|'series'} category
 * @param {string} slug
 * @param {string} ext - file extension without dot (e.g. 'jpg', 'png')
 * @returns {string} absolute path for the poster
 */
function buildPosterPath(category, slug, ext = 'jpg') {
    const date = new Date().toISOString().split('T')[0];
    const folder = category === 'series' ? 'series' : 'films';
    const dir = path.join(DIRS.posters, date, folder);
    fs.ensureDirSync(dir);
    return path.join(dir, `${slug}.${ext}`);
}

/**
 * Builds a thumbnail path (auto-generated from video).
 * Pattern: public/thumbnails/{slug}_{timestamp}.jpg
 *
 * @param {string} slug
 * @returns {string} absolute path for the thumbnail
 */
function buildThumbnailPath(slug) {
    fs.ensureDirSync(DIRS.thumbnails);
    const timestamp = Date.now();
    return path.join(DIRS.thumbnails, `${slug}_${timestamp}.jpg`);
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

// Public URL of the fallback image used when no poster/thumbnail exists.
// Served from src/images via the /static/images route (see app.js).
const DEFAULT_IMAGE_URL = '/static/images/default_image.png';

/* ------------------------------------------------------------------ */
/*  Path <-> URL converters                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert an absolute path under public/ to its web URL served at /static.
 * @param {string} absPath
 * @returns {string|null} e.g. "/static/posters/2026-07-20/films/x.jpg"
 */
function toPublicUrl(absPath) {
    if (!absPath) return null;
    const rel = path.relative(DIRS.public, absPath).split(path.sep).join('/');
    return `/static/${rel}`;
}

/**
 * Convert an absolute path to a ROOT-relative path (forward slashes).
 * Used to store private video paths in the DB in a portable way.
 * @param {string} absPath
 * @returns {string|null} e.g. "uploads/2026-07-20/films/x_123.mp4"
 */
function toRootRelative(absPath) {
    if (!absPath) return null;
    return path.relative(ROOT, absPath).split(path.sep).join('/');
}

/**
 * Resolve a ROOT-relative path back to an absolute filesystem path.
 * @param {string} rootRelative
 * @returns {string|null}
 */
function toAbsolute(rootRelative) {
    if (!rootRelative) return null;
    return path.join(ROOT, rootRelative);
}

/**
 * Resolve a "/static/..." web URL back to its absolute filesystem path.
 * @param {string} url
 * @returns {string|null}
 */
function publicUrlToAbs(url) {
    if (!url) return null;
    const rel = url.replace(/^\/static\//, '');
    return path.join(DIRS.public, rel);
}

module.exports = {
    ROOT,
    DIRS,
    DEFAULT_IMAGE_URL,
    ensureDirectories,
    buildVideoPath,
    buildPosterPath,
    buildThumbnailPath,
    toPublicUrl,
    toRootRelative,
    toAbsolute,
    publicUrlToAbs,
};
