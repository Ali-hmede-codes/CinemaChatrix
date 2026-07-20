/**
 * Compression service — FFmpeg wrapper.
 *
 * FFmpeg is an OPTIONAL external dependency. If it is not installed/available
 * on the system PATH (or the configured FFMPEG_PATH), the service degrades
 * gracefully: isAvailable() returns false and the caller stores the raw video
 * without compression/thumbnail. Everything auto-upgrades once FFmpeg exists.
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { spawnSync } = require('child_process');
const env = require('../config/env');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Availability detection (cached)                                    */
/* ------------------------------------------------------------------ */

let _available = null;

/**
 * Returns true if both ffmpeg and ffprobe can be executed.
 * Result is cached after the first call.
 * @returns {boolean}
 */
function isAvailable() {
    if (_available !== null) return _available;

    const check = (bin) => {
        try {
            const res = spawnSync(bin, ['-version'], { stdio: 'ignore' });
            return !res.error && res.status === 0;
        } catch {
            return false;
        }
    };

    _available = check(env.compression.ffmpegPath) && check(env.compression.ffprobePath);

    if (_available) {
        ffmpeg.setFfmpegPath(env.compression.ffmpegPath);
        ffmpeg.setFfprobePath(env.compression.ffprobePath);
        logger.info('[compression] FFmpeg detected — compression enabled');
    } else {
        logger.warn('[compression] FFmpeg NOT found — videos will be stored raw (no compression/thumbnail)');
    }
    return _available;
}

/* ------------------------------------------------------------------ */
/*  Compress                                                           */
/* ------------------------------------------------------------------ */

/**
 * Compress a video to H.264/AAC MP4 with faststart for streaming.
 *
 * `inputPath` may be a local file OR a remote URL (e.g. an HLS .m3u8 playlist),
 * in which case FFmpeg fetches and assembles the stream itself. Pass any
 * input-level flags (such as an HLS protocol whitelist) via `inputOptions`.
 *
 * @param {string} inputPath - local file path or remote URL
 * @param {string} outputPath
 * @param {object} [opts]
 * @param {string[]} [opts.inputOptions] - extra FFmpeg flags applied before -i
 * @returns {Promise<string>} outputPath
 */
function compressVideo(inputPath, outputPath, { inputOptions = [] } = {}) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath);

        // Input-level flags (e.g. protocol whitelist for remote HLS sources).
        if (inputOptions.length) command.inputOptions(inputOptions);

        command
            .outputOptions([
                '-c:v libx264',
                `-crf ${env.compression.videoCrf}`,
                `-preset ${env.compression.videoPreset}`,
                '-c:a aac',
                '-b:a 128k',
                '-movflags +faststart',
                `-vf scale=-2:${env.compression.maxResolution}`,
                '-profile:v high',
                '-level 4.0',
                '-pix_fmt yuv420p',
            ])
            .output(outputPath)
            .on('start', (cmd) => logger.info(`[compression] Started: ${cmd}`))
            .on('end', () => {
                logger.info(`[compression] Done: ${outputPath}`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                logger.error(`[compression] Failed: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

/* ------------------------------------------------------------------ */
/*  Thumbnail                                                          */
/* ------------------------------------------------------------------ */

/**
 * Capture a single thumbnail frame at ~5 seconds.
 * @param {string} inputPath
 * @param {string} outputPath - absolute .jpg path
 * @returns {Promise<string>} outputPath
 */
function generateThumbnail(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .screenshots({
                timestamps: ['00:00:05'],
                filename: path.basename(outputPath),
                folder: path.dirname(outputPath),
                size: '640x?',
            })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err));
    });
}

/* ------------------------------------------------------------------ */
/*  Probe                                                              */
/* ------------------------------------------------------------------ */

/**
 * Read the video duration in seconds.
 * @param {string} inputPath
 * @returns {Promise<number>} duration (seconds)
 */
function probeDuration(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata?.format?.duration || 0;
            resolve(Number(duration));
        });
    });
}

module.exports = {
    isAvailable,
    compressVideo,
    generateThumbnail,
    probeDuration,
};
