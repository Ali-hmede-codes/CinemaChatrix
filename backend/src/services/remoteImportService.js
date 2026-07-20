/**
 * Remote import service — DoodStream-style bulk "remote upload".
 *
 * The admin pastes MANY video links into one box. This service:
 *   1. Parses the text into a list of items (title + video URL [+ poster URL]).
 *   2. Kicks off a background job that downloads + processes them together
 *      (with a small concurrency limit so several links import at once).
 *   3. Saves each finished video into the database (films or series episodes),
 *      auto-creating its folder via the storage layer.
 *
 * Jobs live in memory and expose live progress that the admin panel polls.
 * This is intentionally lightweight — perfect for a single-server admin tool.
 *
 * Supported line formats (one item per line, parts separated by "|"):
 *   https://host/video.mp4
 *   My Title | https://host/video.mp4
 *   My Title | https://host/video.mp4 | https://host/poster.jpg
 */

const crypto = require('crypto');

const movieModel = require('../models/movieModel');
const seriesModel = require('../models/seriesModel');
const uploadService = require('./uploadService');
const { uniqueSlug } = require('../utils/slug');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

// How many links to download/process at the same time.
const CONCURRENCY = 3;

// Keep finished jobs around this long so the UI can read the final result.
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;

/* ------------------------------------------------------------------ */
/*  Job registry (in-memory)                                          */
/* ------------------------------------------------------------------ */

const jobs = new Map();

function pruneJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.status !== 'running' && now - job.updatedAt > JOB_TTL_MS) {
            jobs.delete(id);
        }
    }
}

function newJob(type, extra = {}) {
    const id = crypto.randomBytes(8).toString('hex');
    const job = {
        id,
        type, // 'film' | 'episode'
        status: 'running', // 'running' | 'done'
        createdAt: Date.now(),
        updatedAt: Date.now(),
        total: 0,
        completed: 0,
        succeeded: 0,
        failed: 0,
        items: [],
        ...extra,
    };
    jobs.set(id, job);
    return job;
}

function getJob(id) {
    return jobs.get(id) || null;
}

/**
 * Sanitized job view for the API (safe to send to the admin panel).
 */
function publicJob(job) {
    if (!job) return null;
    return {
        id: job.id,
        type: job.type,
        status: job.status,
        total: job.total,
        completed: job.completed,
        succeeded: job.succeeded,
        failed: job.failed,
        seriesSlug: job.seriesSlug,
        items: job.items.map((it) => ({
            title: it.title,
            status: it.status, // pending | downloading | processing | done | failed
            error: it.error,
            slug: it.slug,
            season_number: it.season_number,
            episode_number: it.episode_number,
        })),
    };
}

/* ------------------------------------------------------------------ */
/*  Parsing                                                            */
/* ------------------------------------------------------------------ */

function isUrl(s) {
    return /^https?:\/\//i.test(String(s).trim());
}

/**
 * Derive a human title from a video URL's filename.
 * e.g. "https://host/The.Matrix.1999.mp4" -> "The Matrix 1999"
 */
function titleFromUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const base = decodeURIComponent((pathname.split('/').pop() || '').trim());
        const noExt = base.replace(/\.[^.]+$/, '');
        const cleaned = noExt.replace(/[._+\-]+/g, ' ').replace(/\s+/g, ' ').trim();
        return cleaned || 'Untitled';
    } catch {
        return 'Untitled';
    }
}

/**
 * Parse a block of pasted text into structured items.
 * @param {string} text
 * @returns {{title:string, videoUrl:string, posterUrl:string|null}[]}
 */
function parseItems(text) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

    const items = [];
    for (const line of lines) {
        const parts = line.split('|').map((p) => p.trim()).filter(Boolean);

        let title = null;
        let videoUrl = null;
        let posterUrl = null;

        for (const p of parts) {
            if (isUrl(p)) {
                if (IMAGE_EXT.test(p)) posterUrl = posterUrl || p;
                else videoUrl = videoUrl || p;
            } else {
                title = title || p;
            }
        }

        if (!videoUrl) continue; // skip lines without a usable video link
        if (!title) title = titleFromUrl(videoUrl);

        items.push({ title, videoUrl, posterUrl });
    }
    return items;
}

/**
 * Normalize a structured items array (from JSON body) into the internal shape.
 */
function normalizeItems(items) {
    return (items || [])
        .map((it) => {
            const videoUrl = String(it.video_url || it.videoUrl || '').trim();
            if (!videoUrl) return null;
            const posterUrl = String(it.poster_url || it.posterUrl || '').trim() || null;
            const title = String(it.title || '').trim() || titleFromUrl(videoUrl);
            return { title, videoUrl, posterUrl };
        })
        .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/*  Concurrency runner                                                 */
/* ------------------------------------------------------------------ */

async function runPool(items, limit, worker) {
    let index = 0;
    const size = Math.min(limit, items.length);
    const runners = [];
    for (let i = 0; i < size; i++) {
        runners.push((async () => {
            while (index < items.length) {
                const current = index++;
                await worker(items[current], current);
            }
        })());
    }
    await Promise.all(runners);
}

/* ------------------------------------------------------------------ */
/*  Film import                                                        */
/* ------------------------------------------------------------------ */

/**
 * Start a background job that imports many films from remote URLs.
 * @param {{title:string, videoUrl:string, posterUrl:string|null}[]} items
 * @param {object} opts - { is_published, description }
 * @returns {object} the created job
 */
function startFilmImport(items, opts = {}) {
    const job = newJob('film');
    job.total = items.length;
    job.items = items.map((it) => ({
        title: it.title,
        videoUrl: it.videoUrl,
        posterUrl: it.posterUrl || null,
        status: 'pending',
        error: null,
        slug: null,
        id: null,
    }));

    // Fire-and-forget background processing.
    (async () => {
        await runPool(job.items, CONCURRENCY, async (item) => {
            try {
                item.status = 'downloading';
                job.updatedAt = Date.now();

                const slug = uniqueSlug(item.title, movieModel.slugExists);

                item.status = 'processing';
                job.updatedAt = Date.now();

                const video = await uploadService.processVideo({
                    url: item.videoUrl,
                    category: 'film',
                    slug,
                });

                let posterPath = null;
                if (item.posterUrl) {
                    try {
                        posterPath = await uploadService.processPoster({
                            url: item.posterUrl,
                            category: 'film',
                            slug,
                        });
                    } catch (err) {
                        logger.warn(`[import] Poster failed for "${item.title}": ${err.message}`);
                    }
                }

                const movie = movieModel.create({
                    title: item.title,
                    slug,
                    description: opts.description ?? null,
                    poster_path: posterPath,
                    video_path: video.videoPath,
                    thumbnail_path: video.thumbnailPath,
                    duration: video.duration,
                    file_size: video.fileSize,
                    quality: video.quality,
                    is_published: opts.is_published ?? 1,
                });

                item.status = 'done';
                item.slug = movie.slug;
                item.id = movie.id;
                job.succeeded++;
                logger.info(`[import] Film imported: "${movie.title}" (id=${movie.id})`);
            } catch (err) {
                item.status = 'failed';
                item.error = err.message;
                job.failed++;
                logger.error(`[import] Film "${item.title}" failed: ${err.message}`);
            } finally {
                job.completed++;
                job.updatedAt = Date.now();
            }
        });

        job.status = 'done';
        job.updatedAt = Date.now();
        pruneJobs();
    })();

    return job;
}

/* ------------------------------------------------------------------ */
/*  Episode import                                                     */
/* ------------------------------------------------------------------ */

/**
 * Start a background job that imports many episodes into a series from URLs.
 * Episode numbers are auto-assigned, continuing after the highest existing
 * episode in the chosen season.
 *
 * @param {object} series - the series row
 * @param {{title:string, videoUrl:string}[]} items
 * @param {object} opts - { season_number }
 * @returns {object} the created job
 */
function startEpisodeImport(series, items, opts = {}) {
    const season = Number(opts.season_number) || 1;

    const existing = seriesModel
        .findEpisodesBySeries(series.id)
        .filter((e) => e.season_number === season);
    const startEp = existing.reduce((max, e) => Math.max(max, e.episode_number), 0) + 1;

    const job = newJob('episode', { seriesId: series.id, seriesSlug: series.slug });
    job.total = items.length;
    job.items = items.map((it, i) => ({
        title: it.title,
        videoUrl: it.videoUrl,
        season_number: season,
        episode_number: startEp + i, // pre-assigned so numbering stays deterministic
        status: 'pending',
        error: null,
        slug: null,
        id: null,
    }));

    (async () => {
        await runPool(job.items, CONCURRENCY, async (item) => {
            try {
                item.status = 'downloading';
                job.updatedAt = Date.now();

                const slug = uniqueSlug(
                    `${series.slug}-s${item.season_number}e${item.episode_number}-${item.title}`,
                    seriesModel.episodeSlugExists
                );

                item.status = 'processing';
                job.updatedAt = Date.now();

                const video = await uploadService.processVideo({
                    url: item.videoUrl,
                    category: 'series',
                    slug,
                    groupSlug: series.slug, // all episodes share one series folder
                    withThumbnail: false,   // episodes inherit the series image by default
                });

                const episode = seriesModel.createEpisode({
                    series_id: series.id,
                    season_number: item.season_number,
                    episode_number: item.episode_number,
                    title: item.title,
                    slug,
                    description: null,
                    video_path: video.videoPath,
                    thumbnail_path: null, // falls back to the series poster when served
                    duration: video.duration,
                    file_size: video.fileSize,
                    quality: video.quality,
                });

                item.status = 'done';
                item.slug = episode.slug;
                item.id = episode.id;
                job.succeeded++;
                logger.info(`[import] Episode imported: "${episode.title}" (series=${series.id})`);
            } catch (err) {
                item.status = 'failed';
                item.error = err.message;
                job.failed++;
                logger.error(`[import] Episode "${item.title}" failed: ${err.message}`);
            } finally {
                job.completed++;
                job.updatedAt = Date.now();
            }
        });

        job.status = 'done';
        job.updatedAt = Date.now();
        pruneJobs();
    })();

    return job;
}

module.exports = {
    parseItems,
    normalizeItems,
    titleFromUrl,
    startFilmImport,
    startEpisodeImport,
    getJob,
    publicJob,
};
