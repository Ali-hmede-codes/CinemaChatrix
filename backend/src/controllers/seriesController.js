/**
 * Series controller — series + episodes CRUD.
 *
 * Create series accepts multipart/form-data (poster optional).
 * Add episode accepts multipart/form-data with a video (file or URL).
 */

const seriesModel = require('../models/seriesModel');
const categoryModel = require('../models/categoryModel');
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

/**
 * Parse a `category_ids` field from a multipart form into an array of numeric
 * ids. Accepts a JSON array string ("[1,2]"), a repeated field (array) or a
 * comma-separated string. Returns null when the field is absent (leave the
 * series' categories untouched) and [] when explicitly empty (clear them all).
 */
function parseIdList(val) {
    if (val === undefined || val === null) return null;
    if (Array.isArray(val)) return val.map(Number).filter(Number.isInteger);
    const str = String(val).trim();
    if (str === '') return [];
    try {
        const arr = JSON.parse(str);
        if (Array.isArray(arr)) return arr.map(Number).filter(Number.isInteger);
    } catch { /* not JSON — fall through to CSV */ }
    return str.split(',').map((s) => Number(s.trim())).filter(Number.isInteger);
}

async function cleanupTempFiles(req) {
    if (!req.files) return;
    for (const f of Object.values(req.files).flat()) {
        await storageService.remove(f.path);
    }
}

/* ================================================================== */
/*  SERIES                                                             */
/* ================================================================== */

/* GET /api/series  (admin) */
function list(req, res) {
    const series = seriesModel.findAll();
    const catMap = categoryModel.mapForContent('series', series.map((s) => s.id));
    const withCats = series.map((s) => ({ ...s, categories: catMap.get(s.id) || [] }));
    return response.success(res, { series: withCats }, 'All series');
}

/* GET /api/series/:slug  (public) — series info + episodes */
function getBySlug(req, res) {
    const series = seriesModel.findBySlug(req.params.slug);
    if (!series) return response.notFound(res, 'Series');

    series.categories = categoryModel.findForSeries(series.id);

    const episodes = seriesModel.findEpisodesBySeries(series.id).map((ep) => {
        const { video_path, ...safe } = ep; // hide private path publicly
        // Default the thumbnail to the series poster (or the bundled fallback
        // image) so every episode shows an image. Resolved at read time so
        // episodes automatically pick up the series poster once it's set.
        safe.thumbnail_path = ep.thumbnail_path || series.poster_path || paths.DEFAULT_IMAGE_URL;
        return safe;
    });
    return response.success(res, { series, episodes }, 'Series info');
}

/* POST /api/series  (admin, multipart: poster optional) */
async function create(req, res, next) {
    const posterFile = req.files?.poster?.[0];
    const { title, description, is_published, poster_url, category_ids } = req.body;

    try {
        if (!title || !title.trim()) {
            await cleanupTempFiles(req);
            return response.error(res, 'Title is required', 400);
        }

        const slug = uniqueSlug(title, seriesModel.slugExists);

        const posterPath = await uploadService.processPoster({
            tempPath: posterFile?.path,
            url: poster_url,
            category: 'series',
            slug,
        });

        const series = seriesModel.create({
            title: title.trim(),
            slug,
            description,
            poster_path: posterPath,
            is_published: parseBool(is_published, 1),
        });

        // Attach any selected categories (main and/or sub).
        const catIds = parseIdList(category_ids);
        if (catIds) categoryModel.setForSeries(series.id, catIds);
        series.categories = categoryModel.findForSeries(series.id);

        logger.info(`[series] Created series "${series.title}" (id=${series.id})`);
        return response.success(res, { series }, 'Series created', 201);
    } catch (err) {
        await cleanupTempFiles(req);
        return next(err);
    }
}

/* PUT /api/series/:id  (admin, multipart: poster optional) */
async function update(req, res, next) {
    const series = seriesModel.findById(Number(req.params.id));
    if (!series) {
        await cleanupTempFiles(req);
        return response.notFound(res, 'Series');
    }

    const posterFile = req.files?.poster?.[0];
    const { title, description, is_published, poster_url, category_ids } = req.body;

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
        if (is_published !== undefined) fields.is_published = parseBool(is_published, series.is_published);

        // Optional poster replacement (file or URL)
        if (posterFile || poster_url) {
            const newPoster = await uploadService.processPoster({
                tempPath: posterFile?.path,
                url: poster_url,
                category: 'series',
                slug: series.slug,
            });
            if (newPoster) {
                await storageService.remove(paths.publicUrlToAbs(series.poster_path));
                fields.poster_path = newPoster;
            }
        }

        const updated = seriesModel.update(series.id, fields);

        // Sync categories when the field is present (empty array clears them).
        const catIds = parseIdList(category_ids);
        if (catIds !== null) categoryModel.setForSeries(series.id, catIds);
        updated.categories = categoryModel.findForSeries(series.id);

        logger.info(`[series] Updated series "${updated.title}" (id=${series.id})`);
        return response.success(res, { series: updated }, 'Series updated');
    } catch (err) {
        await cleanupTempFiles(req);
        return next(err);
    }
}

/* DELETE /api/series/:id  (admin) */
async function remove(req, res, next) {
    try {
        const series = seriesModel.findById(Number(req.params.id));
        if (!series) return response.notFound(res, 'Series');

        // Remove episode files first
        const episodes = seriesModel.findEpisodesBySeries(series.id);
        for (const ep of episodes) {
            const epAbs = paths.toAbsolute(ep.video_path);
            await storageService.remove(epAbs);
            await storageService.removeEmptyDir(epAbs); // clean up the shared series folder
            await storageService.remove(paths.publicUrlToAbs(ep.thumbnail_path));
        }
        await storageService.remove(paths.publicUrlToAbs(series.poster_path));

        seriesModel.deleteById(series.id); // episode rows cascade-deleted
        logger.info(`[series] Deleted series "${series.title}" (id=${series.id})`);
        return response.success(res, null, 'Series deleted');
    } catch (err) {
        return next(err);
    }
}

/* ================================================================== */
/*  EPISODES                                                           */
/* ================================================================== */

/* POST /api/series/:id/episodes  (admin, multipart) */
async function addEpisode(req, res, next) {
    const series = seriesModel.findById(Number(req.params.id));
    if (!series) {
        await cleanupTempFiles(req);
        return response.notFound(res, 'Series');
    }

    const videoFile = req.files?.video?.[0];
    const { title, description, season_number, episode_number, quality, video_url } = req.body;

    try {
        if (!title || !title.trim()) {
            await cleanupTempFiles(req);
            return response.error(res, 'Episode title is required', 400);
        }
        if (!episode_number) {
            await cleanupTempFiles(req);
            return response.error(res, 'episode_number is required', 400);
        }
        if (!videoFile && !video_url) {
            await cleanupTempFiles(req);
            return response.error(res, 'A video file or video_url is required', 400);
        }

        const slug = uniqueSlug(
            `${series.slug}-s${season_number || 1}e${episode_number}-${title}`,
            seriesModel.episodeSlugExists
        );

        const video = await uploadService.processVideo({
            tempPath: videoFile?.path,
            url: video_url,
            category: 'series',
            slug,
            groupSlug: series.slug, // group all episodes under one series folder
            withThumbnail: false,   // episodes inherit the series image by default
        });

        const episode = seriesModel.createEpisode({
            series_id: series.id,
            season_number: Number(season_number) || 1,
            episode_number: Number(episode_number),
            title: title.trim(),
            slug,
            description,
            video_path: video.videoPath,
            thumbnail_path: null, // no per-episode image — falls back to the series poster when served
            duration: video.duration,
            file_size: video.fileSize,
            quality: quality || video.quality,
        });

        logger.info(`[series] Added episode "${episode.title}" to series id=${series.id}`);
        return response.success(res, { episode }, 'Episode added', 201);
    } catch (err) {
        await cleanupTempFiles(req);
        return next(err);
    }
}

/* POST /api/series/:id/episodes/bulk  (admin, JSON) — DoodStream-style import */
function bulkAddEpisodes(req, res) {
    const series = seriesModel.findById(Number(req.params.id));
    if (!series) return response.notFound(res, 'Series');

    const { text, items, season_number } = req.body;

    const parsed = Array.isArray(items) && items.length
        ? remoteImportService.normalizeItems(items)
        : remoteImportService.parseItems(text);

    if (!parsed.length) {
        return response.error(res, 'No valid video links found. Paste one link per line.', 400);
    }

    const job = remoteImportService.startEpisodeImport(series, parsed, {
        season_number,
    });

    logger.info(`[series] Bulk episode import started: ${parsed.length} link(s) into series id=${series.id}, job=${job.id}`);
    return response.success(res, { job: remoteImportService.publicJob(job) }, 'Import started', 202);
}

/* PUT /api/series/episodes/:id  (admin, multipart: thumbnail optional) */
async function updateEpisode(req, res, next) {
    const episode = seriesModel.findEpisodeById(Number(req.params.id));
    if (!episode) {
        await cleanupTempFiles(req);
        return response.notFound(res, 'Episode');
    }

    const posterFile = req.files?.poster?.[0];
    const { title, description, season_number, episode_number, quality, poster_url } = req.body;

    try {
        const fields = {};
        if (title !== undefined) {
            if (!title.trim()) {
                await cleanupTempFiles(req);
                return response.error(res, 'Episode title cannot be empty', 400);
            }
            fields.title = title.trim();
        }
        if (description !== undefined) fields.description = description;
        if (season_number !== undefined) fields.season_number = Number(season_number) || 1;
        if (episode_number !== undefined) fields.episode_number = Number(episode_number) || episode.episode_number;
        if (quality !== undefined) fields.quality = quality;

        // Optional custom thumbnail (file or URL) — stored like a poster image
        if (posterFile || poster_url) {
            const newThumb = await uploadService.processPoster({
                tempPath: posterFile?.path,
                url: poster_url,
                category: 'series',
                slug: episode.slug,
            });
            if (newThumb) {
                await storageService.remove(paths.publicUrlToAbs(episode.thumbnail_path));
                fields.thumbnail_path = newThumb;
            }
        }

        const updated = seriesModel.updateEpisode(episode.id, fields);
        logger.info(`[series] Updated episode id=${episode.id}`);
        return response.success(res, { episode: updated }, 'Episode updated');
    } catch (err) {
        await cleanupTempFiles(req);
        return next(err);
    }
}

/* DELETE /api/series/episodes/:id  (admin) */
async function removeEpisode(req, res, next) {
    try {
        const episode = seriesModel.findEpisodeById(Number(req.params.id));
        if (!episode) return response.notFound(res, 'Episode');

        const videoAbs = paths.toAbsolute(episode.video_path);
        await storageService.remove(videoAbs);
        await storageService.removeEmptyDir(videoAbs); // clean up folder if series has no more episodes
        await storageService.remove(paths.publicUrlToAbs(episode.thumbnail_path));

        seriesModel.deleteEpisodeById(episode.id);
        logger.info(`[series] Deleted episode id=${episode.id}`);
        return response.success(res, null, 'Episode deleted');
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    list,
    getBySlug,
    create,
    update,
    remove,
    addEpisode,
    bulkAddEpisodes,
    updateEpisode,
    removeEpisode,
};
