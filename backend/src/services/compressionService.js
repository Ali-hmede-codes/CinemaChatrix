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
/*  Encoder selection (hardware-accelerated when available)            */
/* ------------------------------------------------------------------ */

let _encoder = null;

/**
 * Run a tiny throwaway encode to check whether an encoder actually works on
 * this machine — a codec can be compiled into FFmpeg yet fail at runtime when
 * the matching GPU/driver is absent. Feeds the `auto` selection below.
 * @param {string} encoder
 * @returns {boolean}
 */
function encoderWorks(encoder) {
    try {
        const res = spawnSync(
            env.compression.ffmpegPath,
            [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2:r=10',
                '-frames:v', '3', '-c:v', encoder, '-f', 'null', '-',
            ],
            { stdio: 'ignore', timeout: 20000 }
        );
        return !res.error && res.status === 0;
    } catch {
        return false;
    }
}

/**
 * Resolve which H.264 encoder to use (cached after first call).
 *   - an explicit VIDEO_ENCODER (e.g. libx264, h264_nvenc) is used as-is
 *   - "auto" probes common hardware encoders and falls back to libx264
 * @returns {string}
 */
function selectEncoder() {
    if (_encoder) return _encoder;

    const configured = String(env.compression.videoEncoder || 'libx264').toLowerCase();
    if (configured !== 'auto') {
        _encoder = configured;
        return _encoder;
    }

    const candidates = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'];
    _encoder = candidates.find(encoderWorks) || 'libx264';
    logger.info(
        _encoder === 'libx264'
            ? '[compression] Using software encoder: libx264'
            : `[compression] Hardware encoder enabled: ${_encoder}`
    );
    return _encoder;
}

/**
 * Build the video-codec output flags for the chosen encoder. CRF maps to the
 * nearest quality knob each encoder exposes; hardware encoders ignore the
 * x264 -preset (they use their own internal speed presets).
 * @param {string} encoder
 * @returns {string[]}
 */
function videoEncodeOptions(encoder) {
    const crf = env.compression.videoCrf;
    const preset = env.compression.videoPreset;

    switch (encoder) {
        case 'h264_nvenc':
            return ['-c:v h264_nvenc', '-preset p5', '-rc vbr', `-cq ${crf}`, '-b:v 0', '-profile:v high', '-pix_fmt yuv420p'];
        case 'h264_qsv':
            return ['-c:v h264_qsv', `-global_quality ${crf}`, '-profile:v high'];
        case 'h264_amf':
            return ['-c:v h264_amf', '-rc cqp', `-qp_i ${crf}`, `-qp_p ${crf}`, '-quality speed', '-profile:v high', '-pix_fmt yuv420p'];
        case 'h264_videotoolbox':
            return ['-c:v h264_videotoolbox', '-profile:v high', '-pix_fmt yuv420p'];
        case 'libx264':
        default:
            return ['-c:v libx264', `-crf ${crf}`, `-preset ${preset}`, '-profile:v high', '-level 4.0', '-pix_fmt yuv420p'];
    }
}

/* ------------------------------------------------------------------ */
/*  Probe                                                              */
/* ------------------------------------------------------------------ */

/**
 * Inspect a source's primary streams so we can pick the fastest safe path.
 * @param {string} inputPath - local file or remote URL
 * @param {object} [opts]
 * @param {string[]} [opts.inputOptions] - flags applied to the probe (e.g. HLS whitelist)
 * @returns {Promise<{durationSec:number, formatName:string, videoCodec:string|null, audioCodec:string|null, width:number|null, height:number|null}>}
 */
function probeMedia(inputPath, { inputOptions = [] } = {}) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath).ffprobe(inputOptions, (err, metadata) => {
            if (err) return reject(err);
            const streams = (metadata && metadata.streams) || [];
            const video = streams.find((s) => s.codec_type === 'video') || null;
            const audio = streams.find((s) => s.codec_type === 'audio') || null;
            resolve({
                durationSec: Number((metadata && metadata.format && metadata.format.duration) || 0),
                formatName: (metadata && metadata.format && metadata.format.format_name) || '',
                videoCodec: video && video.codec_name ? video.codec_name : null,
                audioCodec: audio && audio.codec_name ? audio.codec_name : null,
                width: video && video.width ? video.width : null,
                height: video && video.height ? video.height : null,
            });
        });
    });
}

/* ------------------------------------------------------------------ */
/*  Transcode / remux                                                  */
/* ------------------------------------------------------------------ */

/**
 * Run a single FFmpeg pass and resolve with the output path.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {object} opts
 * @param {string[]} [opts.inputOptions]
 * @param {string[]} [opts.outputOptions]
 * @returns {Promise<string>}
 */
function runFfmpeg(inputPath, outputPath, { inputOptions = [], outputOptions = [] }) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath);
        if (inputOptions.length) command.inputOptions(inputOptions);
        command
            .outputOptions(outputOptions)
            .output(outputPath)
            .on('start', (cmd) => logger.info(`[compression] Started: ${cmd}`))
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .run();
    });
}

/**
 * Flags for a fast stream-copy remux (no re-encode). Only the primary video +
 * optional audio track are kept, so stray subtitle/data streams can't break
 * the MP4 mux. Audio is copied when already AAC, otherwise transcoded.
 * @param {object} media - result of probeMedia
 * @returns {string[]}
 */
function copyOptions(media) {
    const fromTs = /mpegts|hls/i.test(media.formatName || '');
    const opts = ['-map 0:v:0', '-map 0:a:0?', '-c:v copy'];
    if (media.audioCodec === 'aac') {
        opts.push('-c:a copy');
        if (fromTs) opts.push('-bsf:a aac_adtstoasc'); // ADTS (TS) → ASC (MP4)
    } else if (media.audioCodec) {
        opts.push('-c:a aac', '-b:a 128k');
    }
    opts.push('-movflags +faststart');
    return opts;
}

/**
 * Flags for a full re-encode to H.264/AAC MP4. Caps height at maxResolution
 * WITHOUT upscaling smaller sources, using the selected (possibly hardware)
 * encoder. `-vf` and its value are separate items so the escaped comma in the
 * min() expression survives fluent-ffmpeg's option splitting.
 * @param {string} encoder
 * @returns {string[]}
 */
function encodeOptions(encoder) {
    return [
        '-map 0:v:0',
        '-map 0:a:0?',
        ...videoEncodeOptions(encoder),
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        '-vf', `scale=-2:min(ih\\,${env.compression.maxResolution})`,
    ];
}

/**
 * Turn a source into a streaming-ready H.264/AAC MP4 as fast as possible.
 *
 * Strategy (fastest → most work):
 *   1. Probe the source. If the video is already H.264 within the target
 *      resolution, STREAM-COPY it (seconds) instead of re-encoding — which can
 *      take many minutes/hours for a large film.
 *   2. Otherwise re-encode with the selected encoder (hardware-accelerated
 *      when available), auto-falling back to libx264 if that encoder fails.
 *   3. If a stream-copy attempt fails (rare, e.g. an awkward HLS source), fall
 *      back to a re-encode.
 *
 * `inputPath` may be a local file OR a remote URL (e.g. an HLS .m3u8 playlist).
 * Pass input-level flags (such as an HLS protocol whitelist) via `inputOptions`.
 *
 * @param {string} inputPath - local file path or remote URL
 * @param {string} outputPath
 * @param {object} [opts]
 * @param {string[]} [opts.inputOptions] - extra FFmpeg flags applied before -i
 * @returns {Promise<string>} outputPath
 */
async function compressVideo(inputPath, outputPath, { inputOptions = [] } = {}) {
    const maxH = env.compression.maxResolution;

    // Probe up front. A failure (some remote sources) just means we re-encode.
    let media = null;
    try {
        media = await probeMedia(inputPath, { inputOptions });
    } catch (err) {
        logger.warn(`[compression] Probe failed (${err.message}) — will re-encode`);
    }

    const canCopy = !!media && media.videoCodec === 'h264' && (!media.height || media.height <= maxH);

    // 1. Fast path — stream copy, no re-encode.
    if (canCopy) {
        try {
            await runFfmpeg(inputPath, outputPath, { inputOptions, outputOptions: copyOptions(media) });
            logger.info(`[compression] Done (fast remux, no re-encode): ${outputPath}`);
            return outputPath;
        } catch (err) {
            logger.warn(`[compression] Fast remux failed (${err.message}) — falling back to re-encode`);
        }
    }

    // 2. Re-encode, preferring the selected (hardware) encoder.
    const encoder = selectEncoder();
    try {
        logger.info(
            `[compression] Re-encoding with ${encoder}` +
            (encoder === 'libx264' ? ` (preset ${env.compression.videoPreset})` : '')
        );
        await runFfmpeg(inputPath, outputPath, { inputOptions, outputOptions: encodeOptions(encoder) });
    } catch (err) {
        if (encoder === 'libx264') {
            logger.error(`[compression] Failed: ${err.message}`);
            throw err;
        }
        // 3. Hardware encode failed — retry once on the software encoder.
        logger.warn(`[compression] ${encoder} failed (${err.message}) — retrying with libx264`);
        await runFfmpeg(inputPath, outputPath, { inputOptions, outputOptions: encodeOptions('libx264') });
    }

    logger.info(`[compression] Done (re-encoded): ${outputPath}`);
    return outputPath;
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
    probeMedia,
    compressVideo,
    generateThumbnail,
    probeDuration,
};
