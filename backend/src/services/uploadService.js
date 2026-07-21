/**
 * Upload service — orchestrates turning an uploaded/downloaded file into a
 * stored, ready-to-serve video (+ optional poster/thumbnail).
 *
 * Used by movieController and seriesController so the upload logic lives in
 * one place. Handles both multipart file uploads (multer temp path) and
 * remote URL downloads.
 *
 * Returns DB-ready values:
 *   - videoPath     : ROOT-relative path (private, streamed later with access control)
 *   - posterPath    : "/static/..." URL (public) or null
 *   - thumbnailPath : "/static/..." URL (public) or null
 *   - duration      : seconds (integer) or null
 *   - fileSize      : bytes
 *   - quality       : label
 */

const fs = require('fs');
const path = require('path');
const paths = require('../config/paths');
const env = require('../config/env');
const storageService = require('./storageService');
const compressionService = require('./compressionService');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts'];

// Input-level FFmpeg flags for remote HLS ingest. The protocol whitelist lets
// the HLS demuxer follow the playlist over http(s), and the reconnect flags
// keep long segment downloads alive through transient network hiccups.
const HLS_INPUT_OPTIONS = [
    '-protocol_whitelist file,http,https,tcp,tls,crypto',
    '-reconnect 1',
    '-reconnect_streamed 1',
    '-reconnect_delay_max 5',
];

/**
 * Best-effort extraction of a file extension (no dot) from a URL's path.
 * Returns null if none / not a recognised video extension.
 * @param {string} url
 * @returns {string|null}
 */
function extFromUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const ext = path.extname(pathname).slice(1).toLowerCase();
        return VIDEO_EXTS.includes(ext) ? ext : null;
    } catch {
        return null;
    }
}

/**
 * True if a URL points at an HLS playlist (.m3u8). Query strings are ignored.
 * @param {string} url
 * @returns {boolean}
 */
function isHlsUrl(url) {
    try {
        return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
    } catch {
        return false;
    }
}

/**
 * True if a just-downloaded file is actually an HLS playlist. Some hosts serve
 * a playlist even from a URL that doesn't end in .m3u8, so we sniff the header.
 * @param {string} filePath
 * @returns {boolean}
 */
function looksLikeHlsFile(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(7);
        const bytes = fs.readSync(fd, buf, 0, 7, 0);
        fs.closeSync(fd);
        return bytes >= 7 && buf.toString('utf8') === '#EXTM3U';
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------------ */
/*  Video                                                              */
/* ------------------------------------------------------------------ */

/**
 * Process the video for a film/episode.
 * @param {object} opts
 * @param {string} [opts.tempPath]  - multer temp file path
 * @param {string} [opts.url]       - remote video URL, incl. HLS .m3u8 (alternative to tempPath)
 * @param {'film'|'series'} opts.category
 * @param {string} opts.slug
 * @param {string} [opts.groupSlug] - folder to group files under (e.g. series slug)
 * @param {boolean} [opts.withThumbnail=true] - generate a video-frame thumbnail
 *        (films want one; episodes skip it so they inherit the series image)
 * @returns {Promise<{videoPath:string, thumbnailPath:string|null, duration:number|null, fileSize:number, quality:string}>}
 */
async function processVideo({ tempPath, url, category, slug, groupSlug = null, withThumbnail = true }) {
    // Detect a remote HLS (.m3u8) source. HLS can't be "downloaded" as one file:
    // the playlist only lists segments, so we hand the URL straight to FFmpeg,
    // which fetches + assembles the .ts segments into a real MP4.
    let isHls = url ? isHlsUrl(url) : false;

    // 1. Ensure we have a local working file (download if URL provided).
    //    HLS is skipped here — FFmpeg reads it directly from the URL.
    let workingTemp = tempPath || null;
    if (!workingTemp && url && !isHls) {
        const urlExt = extFromUrl(url) || 'mp4';
        workingTemp = path.join(paths.DIRS.uploadsTemp, `${slug}_${Date.now()}.${urlExt}`);
        logger.info(`[upload] Downloading video from URL: ${url}`);
        await storageService.downloadFromUrl(url, workingTemp);

        // Some hosts serve an HLS playlist even from a URL that doesn't end in
        // .m3u8. If that's what we got, discard it and switch to HLS ingest
        // (which needs the ORIGINAL url to resolve the relative segments).
        if (looksLikeHlsFile(workingTemp)) {
            logger.info('[upload] Downloaded file is an HLS playlist — switching to HLS ingest');
            await storageService.remove(workingTemp);
            workingTemp = null;
            isHls = true;
        }
    }
    if (!workingTemp && !isHls) {
        throw new Error('No video file or URL provided');
    }

    const quality = `${env.compression.maxResolution}p`;
    let videoAbs;
    let thumbnailUrl = null;
    let duration = null;
    let usedFfmpeg = false;

    if (isHls) {
        // 2a. HLS MUST go through FFmpeg — there is no raw file to fall back to.
        if (!compressionService.isAvailable()) {
            const err = new Error(
                'This looks like a streaming (HLS/.m3u8) link, which needs FFmpeg to import. ' +
                'FFmpeg was not found — install it and try again.'
            );
            err.expose = true; // safe, actionable message (shown even in production)
            err.status = 422;
            throw err;
        }
        videoAbs = paths.buildVideoPath(category, slug, 'mp4', groupSlug);
        try {
            await compressionService.compressVideo(url, videoAbs, { inputOptions: HLS_INPUT_OPTIONS });
        } catch (err) {
            // FFmpeg failed mid-stream — drop any partial output and surface a
            // clear, actionable reason instead of a bare 500.
            await storageService.remove(videoAbs);
            const e = new Error(
                "Couldn't import this streaming link. The source may be offline, " +
                'geo-blocked, or the signed URL may have expired — try a fresh link. ' +
                `(FFmpeg: ${err.message})`
            );
            e.expose = true;
            e.status = 422;
            throw e;
        }
        usedFfmpeg = true;
    } else if (compressionService.isAvailable()) {
        // 2b. Compress local file → final .mp4
        videoAbs = paths.buildVideoPath(category, slug, 'mp4', groupSlug);
        await compressionService.compressVideo(workingTemp, videoAbs);
        await storageService.remove(workingTemp);
        usedFfmpeg = true;
    } else {
        // 2c. No FFmpeg → keep the raw file (preserve original extension)
        const ext = (path.extname(workingTemp).slice(1) || 'mp4').toLowerCase();
        videoAbs = paths.buildVideoPath(category, slug, ext, groupSlug);
        await storageService.moveFile(workingTemp, videoAbs);
        logger.warn('[upload] Stored raw video (FFmpeg unavailable — no compression/thumbnail/duration)');
    }

    // Thumbnail + duration are only possible from a real, FFmpeg-produced MP4.
    if (usedFfmpeg) {
        // Thumbnail (best-effort) — skipped when the caller opts out.
        if (withThumbnail) {
            try {
                const thumbAbs = paths.buildThumbnailPath(slug);
                await compressionService.generateThumbnail(videoAbs, thumbAbs);
                thumbnailUrl = paths.toPublicUrl(thumbAbs);
            } catch (err) {
                logger.warn(`[upload] Thumbnail generation failed: ${err.message}`);
            }
        }

        // Duration (best-effort)
        try {
            duration = Math.round(await compressionService.probeDuration(videoAbs));
        } catch (err) {
            logger.warn(`[upload] Duration probe failed: ${err.message}`);
        }
    }

    const fileSize = storageService.getFileSize(videoAbs);

    return {
        videoPath: paths.toRootRelative(videoAbs),
        thumbnailPath: thumbnailUrl,
        duration,
        fileSize,
        quality,
    };
}

/* ------------------------------------------------------------------ */
/*  Poster                                                             */
/* ------------------------------------------------------------------ */

/**
 * Process an optional poster image.
 * @param {object} opts
 * @param {string} [opts.tempPath] - multer temp file path
 * @param {string} [opts.url]      - remote poster URL
 * @param {'film'|'series'} opts.category
 * @param {string} opts.slug
 * @returns {Promise<string|null>} "/static/..." poster URL or null
 */
async function processPoster({ tempPath, url, category, slug }) {
    if (!tempPath && !url) return null;

    const ext = tempPath
        ? (path.extname(tempPath).slice(1) || 'jpg').toLowerCase()
        : 'jpg';
    const posterAbs = paths.buildPosterPath(category, slug, ext);

    if (tempPath) {
        await storageService.moveFile(tempPath, posterAbs);
    } else {
        await storageService.downloadFromUrl(url, posterAbs);
    }
    return paths.toPublicUrl(posterAbs);
}

module.exports = {
    processVideo,
    processPoster,
};
