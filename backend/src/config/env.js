/**
 * Environment variable loader and validator.
 *
 * Loads dotenv, reads all required variables, validates them,
 * and exports a single frozen config object so the rest of the
 * app never touches process.env directly.
 */

const dotenv = require('dotenv');
const path = require('path');

// Load .env file from project root
dotenv.config({ path: path.join(__dirname, '../../.env') });

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function required(key) {
    const val = process.env[key];
    if (val === undefined || val === null || val === '') {
        throw new Error(`[env] Missing required environment variable: ${key}`);
    }
    return val;
}

function optional(key, fallback) {
    const val = process.env[key];
    return val === undefined || val === null || val === '' ? fallback : val;
}

function parseIntEnv(key, fallback) {
    const raw = process.env[key];
    const num = Number.parseInt(raw, 10);
    return isNaN(num) ? fallback : num;
}

/**
 * Resolve an external binary path. Priority:
 *   1. Explicit env var (a system-wide install or a custom path)
 *   2. A bundled static binary shipped as an optional npm dependency
 *   3. The bare command name — relies on the system PATH
 * The static packages are optional; if they aren't installed we fall back to
 * the PATH lookup so nothing breaks on environments that provide their own.
 * @param {string} envKey
 * @param {string} staticModule - npm module that exports the binary path
 * @param {string} bareName - command name to try on PATH as a last resort
 * @returns {string}
 */
function resolveBinary(envKey, staticModule, bareName) {
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv;
    try {
        const resolved = require(staticModule);
        // ffmpeg-static exports the path string; ffprobe-static exports { path }.
        const p = typeof resolved === 'string' ? resolved : resolved && resolved.path;
        if (p) return p;
    } catch {
        /* optional dependency not installed — fall through to PATH */
    }
    return bareName;
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const config = {
    server: {
        port: parseIntEnv('PORT', 3001),
        nodeEnv: optional('NODE_ENV', 'development'),
        isProduction: optional('NODE_ENV', 'development') === 'production',
    },

    database: {
        path: optional('DB_PATH', './database/cinema.db'),
    },

    jwt: {
        secret: required('JWT_SECRET'),
        expiresIn: optional('JWT_EXPIRES_IN', '24h'),
    },

    admin: {
        username: optional('ADMIN_USERNAME', 'admin'),
        password: optional('ADMIN_PASSWORD', 'ChangeMe123!'),
    },

    upload: {
        maxUploadSize: optional('MAX_UPLOAD_SIZE', '5GB'),
        uploadDir: optional('UPLOAD_DIR', './uploads'),
        tempDir: optional('TEMP_DIR', './uploads/_temp'),
    },

    compression: {
        // Defaults to the bundled ffmpeg-static / ffprobe-static binaries so
        // HLS (.m3u8) and file imports work without a manual system install.
        // Set FFMPEG_PATH / FFPROBE_PATH to override with a system FFmpeg.
        ffmpegPath: resolveBinary('FFMPEG_PATH', 'ffmpeg-static', 'ffmpeg'),
        ffprobePath: resolveBinary('FFPROBE_PATH', 'ffprobe-static', 'ffprobe'),
        videoCrf: parseIntEnv('VIDEO_CRF', 23),
        videoPreset: optional('VIDEO_PRESET', 'veryfast'),
        // Video encoder: 'auto' prefers hardware accel (NVENC/QSV/AMF) with a
        // libx264 fallback; or force one (libx264, h264_nvenc, h264_qsv, ...).
        // Note: sources already in H.264 within maxResolution are stream-copied
        // (no re-encode), so this only matters when a real re-encode is needed.
        videoEncoder: optional('VIDEO_ENCODER', 'auto'),
        maxResolution: parseIntEnv('MAX_RESOLUTION', 1080),
    },

    security: {
        corsOrigin: optional('CORS_ORIGIN', 'http://localhost:3001'),
        rateLimitWindow: parseIntEnv('RATE_LIMIT_WINDOW', 15),
        rateLimitMax: parseIntEnv('RATE_LIMIT_MAX', 100),
        codeRateLimitMax: parseIntEnv('CODE_RATE_LIMIT_MAX', 5),
    },

    player: {
        plyrVersion: optional('PLYR_VERSION', '3.7.8'),
    },
};

// Freeze to prevent accidental mutation
module.exports = Object.freeze({
    ...config,
    server: Object.freeze(config.server),
    database: Object.freeze(config.database),
    jwt: Object.freeze(config.jwt),
    admin: Object.freeze(config.admin),
    upload: Object.freeze(config.upload),
    compression: Object.freeze(config.compression),
    security: Object.freeze(config.security),
    player: Object.freeze(config.player),
});
