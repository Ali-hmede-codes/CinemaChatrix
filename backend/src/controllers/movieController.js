/**
 * Movie controller — film CRUD + upload.
 *
 * Create accepts multipart/form-data:
 *   fields: title, description, quality, is_published, video_url, poster_url
 *   files : video (required unless video_url given), poster (optional)
 */

const movieModel = require('../models/movieModel');
const uploadService = require('../services/uploadService');
const storageService = require('../services/storageService');
const remoteImportService = require('../services/remoteImportService');
const { uniqueSlug } = require('../utils/slug');
const paths = require('../config/paths');
const response = require('../utils/response');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseBool(val, fallback = 1) {
    if (val === undefined || val === null || val === '') return fallback;
    return ['1', 'true', 'on', 'yes'].includes(String(val).toLowerCase()) ? 1 : 0;
}

async function cleanupTempFiles(req) {
    if (!req.files) return;
    const all = Object.values(req.files).flat();
    for (const f of all) {
        await storageService.remove(f.path);
    }
}

/* ------------------------------------------------------------------ */
/*  GET /api/movies  (admin)                                           */
/* ------------------------------------------------------------------ */

function list(req, res) {
    return response.success(res, { movies: movieModel.findAll() }, 'All films');
}

/* ------------------------------------------------------------------ */
/*  GET /api/movies/:slug  (public)                                    */
/* ------------------------------------------------------------------ */

function getBySlug(req, res) {
    const movie = movieModel.findBySlug(req.params.slug);
    if (!movie) return response.notFound(res, 'Film');
    // Never expose the private filesystem video path publicly
    const { video_path, ...safe } = movie;
    return response.success(res, { movie: safe }, 'Film info');
}

/* ------------------------------------------------------------------ */
/*  POST /api/movies  (admin, multipart)                               */
/* ------------------------------------------------------------------ */

async function create(req, res, next) {
    const videoFile = req.files?.video?.[0];
    const posterFile = req.files?.poster?.[0];
    const { title, description, quality, is_published, video_url, poster_url } = req.body;

    try {
        if (!title || !title.trim()) {
            await cleanupTempFiles(req);
            return response.error(res, 'Title is required', 400);
        }
        if (!videoFile && !video_url) {
            await cleanupTempFiles(req);
            return response.error(res, 'A video file or video_url is required', 400);
        }

        const slug = uniqueSlug(title, movieModel.slugExists);

        const video = await uploadService.processVideo({
            tempPath: videoFile?.path,
            url: video_url,
            category: 'film',
            slug,
        });

        const posterPath = await uploadService.processPoster({
            tempPath: posterFile?.path,
            url: poster_url,
            category: 'film',
            slug,
        });

        const movie = movieModel.create({
            title: title.trim(),
            slug,
            description,
            poster_path: posterPath,
            video_path: video.videoPath,
            thumbnail_path: video.thumbnailPath,
            duration: video.duration,
            file_size: video.fileSize,
            quality: quality || video.quality,
            is_published: parseBool(is_published, 1),
        });

        logger.info(`[movies] Created film "${movie.title}" (id=${movie.id})`);
        return response.success(res, { movie }, 'Film created', 201);
    } catch (err) {
        await cleanupTempFiles(req);
        return next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  POST /api/movies/bulk  (admin, JSON) — DoodStream-style import      */
/* ------------------------------------------------------------------ */

/**
 * Import many films at once from a box of remote links.
 * Body: { text?, items?, is_published?, description? }
 *   - text : newline-separated links ("Title | url | posterUrl" per line)
 *   - items: alternative structured array [{ title, video_url, poster_url }]
 * Returns 202 with a job id; poll GET /api/imports/:id for progress.
 */
function bulkCreate(req, res) {
    const { text, items, is_published, description } = req.body;

    const parsed = Array.isArray(items) && items.length
        ? remoteImportService.normalizeItems(items)
        : remoteImportService.parseItems(text);

    if (!parsed.length) {
        return response.error(res, 'No valid video links found. Paste one link per line.', 400);
    }

    const job = remoteImportService.startFilmImport(parsed, {
        is_published: parseBool(is_published, 1),
        description: description ? String(description).trim() : null,
    });

    logger.info(`[movies] Bulk import started: ${parsed.length} link(s), job=${job.id}`);
    return response.success(res, { job: remoteImportService.publicJob(job) }, 'Import started', 202);
}

/* ------------------------------------------------------------------ */
/*  PUT /api/movies/:id  (admin, multipart: poster optional)           */
/* ------------------------------------------------------------------ */

async function update(req, res, next) {
    const movie = movieModel.findById(Number(req.params.id));
    if (!movie) {
        await cleanupTempFiles(req);
        return response.notFound(res, 'Film');
    }

    const posterFile = req.files?.poster?.[0];
    const { title, description, quality, is_published, poster_url } = req.body;

    try {
        const fields = {};
        if (title !== undefined) {
            if (!title.trim()) {
                await cleanupTempFiles(req);
                return response.error(res, 'Title cannot be empty', 400);
            }
            fields.title = title.trim();
        }
        if (description !== undefined) fields.description = description;
        if (quality !== undefined) fields.quality = quality;
        if (is_published !== undefined) fields.is_published = parseBool(is_published, movie.is_published);

        // Optional poster replacement (file or URL)
        if (posterFile || poster_url) {
            const newPoster = await uploadService.processPoster({
                tempPath: posterFile?.path,
                url: poster_url,
                category: 'film',
                slug: movie.slug,
            });
            if (newPoster) {
                await storageService.remove(paths.publicUrlToAbs(movie.poster_path));
                fields.poster_path = newPoster;
            }
        }

        const updated = movieModel.update(movie.id, fields);
        logger.info(`[movies] Updated film "${updated.title}" (id=${movie.id})`);
        return response.success(res, { movie: updated }, 'Film updated');
    } catch (err) {
        await cleanupTempFiles(req);
        return next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  DELETE /api/movies/:id  (admin)                                    */
/* ------------------------------------------------------------------ */

async function remove(req, res, next) {
    try {
        const movie = movieModel.findById(Number(req.params.id));
        if (!movie) return response.notFound(res, 'Film');

        // Remove files from disk (best-effort)
        const videoAbs = paths.toAbsolute(movie.video_path);
        await storageService.remove(videoAbs);
        await storageService.removeEmptyDir(videoAbs); // clean up the auto-created folder
        await storageService.remove(paths.publicUrlToAbs(movie.poster_path));
        await storageService.remove(paths.publicUrlToAbs(movie.thumbnail_path));

        movieModel.deleteById(movie.id);
        logger.info(`[movies] Deleted film "${movie.title}" (id=${movie.id})`);
        return response.success(res, null, 'Film deleted');
    } catch (err) {
        return next(err);
    }
}

module.exports = { list, getBySlug, create, bulkCreate, update, remove };
