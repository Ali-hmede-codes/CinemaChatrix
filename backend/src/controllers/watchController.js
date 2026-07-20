/**
 * Watch controller — secure playback + resume progress.
 *
 *   POST /api/watch/authorize        { device_fingerprint, type, slug }
 *                                     → { token } short-lived stream ticket
 *   GET  /api/watch/stream/:type/:slug?token=...   → byte-range video stream
 *   POST /api/watch/progress         save resume position
 *   POST /api/watch/progress/get     read resume position
 *
 * SECURITY MODEL
 *   A raw <video> element can't send custom auth headers, so instead of
 *   putting the device fingerprint (or, worse, a code) in the stream URL we
 *   issue a short-lived, signed "stream ticket" (JWT) after verifying access.
 *   The ticket is scoped to ONE piece of content and ONE device and expires
 *   quickly. The stream endpoint verifies the ticket AND re-checks that the
 *   device still owns the content before serving a single byte, so access
 *   that is later revoked (e.g. a deleted code) stops working immediately.
 *
 *   Video files live outside the web root and are only ever referenced by a
 *   server-side slug → path lookup, so paths can never be guessed or traversed.
 */

const jwt = require('jsonwebtoken');

const env = require('../config/env');
const paths = require('../config/paths');
const response = require('../utils/response');
const logger = require('../utils/logger');

const movieModel = require('../models/movieModel');
const seriesModel = require('../models/seriesModel');
const deviceModel = require('../models/deviceModel');
const codeModel = require('../models/codeModel');
const progressModel = require('../models/progressModel');
const deviceService = require('../services/deviceService');
const streamingService = require('../services/streamingService');

// How long a stream ticket stays valid. Long enough to watch a film, short
// enough that a leaked URL is useless soon after.
const STREAM_TICKET_TTL = '6h';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve a { type, slug } pair to the underlying content + access target.
 * @returns {{ content:object, target:object, kind:'film'|'episode' }|null}
 */
function resolveContent(type, slug) {
    if (type === 'film') {
        const movie = movieModel.findBySlug(slug);
        if (!movie) return null;
        return { content: movie, target: { movieId: movie.id }, kind: 'film' };
    }
    if (type === 'episode') {
        const ep = seriesModel.findEpisodeBySlug(slug);
        if (!ep) return null;
        return { content: ep, target: { episodeId: ep.id }, kind: 'episode' };
    }
    return null;
}

/* ------------------------------------------------------------------ */
/*  POST /api/watch/authorize                                          */
/* ------------------------------------------------------------------ */

function authorize(req, res, next) {
    try {
        const { device_fingerprint, type, slug } = req.body || {};

        if (!device_fingerprint || !String(device_fingerprint).trim()) {
            return response.error(res, 'Device identification is required', 400);
        }
        if (!type || !slug) {
            return response.error(res, 'A content type and slug are required', 400);
        }

        const resolved = resolveContent(type, slug);
        if (!resolved) return response.notFound(res, 'Content');

        // Resolve (find or create) the device, then confirm it owns the content.
        const device = deviceService.resolveDevice(
            device_fingerprint,
            req.headers['user-agent'],
            req.ip
        );

        const hasAccess = codeModel.checkAccess(device.id, resolved.target);
        if (!hasAccess) {
            return response.forbidden(res, 'You have not unlocked this yet. Enter a code to watch.');
        }

        // Mint a scoped, expiring stream ticket. It proves "this device may
        // stream this exact content" without exposing the fingerprint.
        const token = jwt.sign(
            {
                scope: 'stream',
                type: resolved.kind,
                slug,
                contentId: resolved.content.id,
                deviceId: device.id,
            },
            env.jwt.secret,
            { expiresIn: STREAM_TICKET_TTL }
        );

        return response.success(res, { token, ttl: STREAM_TICKET_TTL }, 'Authorized');
    } catch (err) {
        return next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  GET /api/watch/stream/:type/:slug?token=...                        */
/* ------------------------------------------------------------------ */

function stream(req, res) {
    const { type, slug } = req.params;
    const token = req.query.token;

    if (!token) {
        return response.forbidden(res, 'A valid stream ticket is required');
    }

    let payload;
    try {
        payload = jwt.verify(token, env.jwt.secret);
    } catch {
        return response.forbidden(res, 'Stream ticket is invalid or has expired');
    }

    // The ticket must match the exact content being requested.
    if (payload.scope !== 'stream' || payload.type !== type || payload.slug !== slug) {
        return response.forbidden(res, 'Stream ticket does not match this content');
    }

    const resolved = resolveContent(type, slug);
    if (!resolved || resolved.content.id !== payload.contentId) {
        return response.notFound(res, 'Content');
    }

    // Re-verify ownership at stream time so revoked access stops immediately.
    const device = deviceModel.findById(payload.deviceId);
    if (!device || !codeModel.checkAccess(device.id, resolved.target)) {
        return response.forbidden(res, 'Access to this content is no longer valid');
    }

    const absPath = paths.toAbsolute(resolved.content.video_path);
    return streamingService.streamFile(req, res, absPath);
}

/* ------------------------------------------------------------------ */
/*  Progress                                                           */
/* ------------------------------------------------------------------ */

/** Shared: resolve device + verify access from a progress request body. */
function resolveDeviceWithAccess(body) {
    const { device_fingerprint, movie_id, episode_id } = body || {};
    if (!device_fingerprint) return { error: 'Device identification is required' };
    if (!movie_id && !episode_id) return { error: 'A movie_id or episode_id is required' };

    const hash = deviceService.hashFingerprint(device_fingerprint);
    const device = deviceModel.findByFingerprint(hash);
    if (!device) return { error: 'Device not recognized', status: 403 };

    const target = movie_id
        ? { movieId: Number(movie_id) }
        : { episodeId: Number(episode_id) };

    if (!codeModel.checkAccess(device.id, target)) {
        return { error: 'No access to this content', status: 403 };
    }
    return { device, movie_id: movie_id ? Number(movie_id) : null, episode_id: episode_id ? Number(episode_id) : null };
}

/** POST /api/watch/progress — save resume position. */
function saveProgress(req, res) {
    const resolved = resolveDeviceWithAccess(req.body);
    if (resolved.error) return response.error(res, resolved.error, resolved.status || 400);

    const { current_time, duration } = req.body || {};
    progressModel.upsert({
        device_id: resolved.device.id,
        movie_id: resolved.movie_id,
        episode_id: resolved.episode_id,
        current_time: Number(current_time) || 0,
        duration: duration != null ? Number(duration) : null,
    });
    return response.success(res, null, 'Progress saved');
}

/** POST /api/watch/progress/get — read resume position. */
function getProgress(req, res) {
    const resolved = resolveDeviceWithAccess(req.body);
    if (resolved.error) {
        // Missing progress is not an error for the player — just return zero.
        return response.success(res, { current_time: 0, is_completed: false }, 'No progress');
    }

    const row = progressModel.find(resolved.device.id, {
        movieId: resolved.movie_id,
        episodeId: resolved.episode_id,
    });
    return response.success(
        res,
        row
            ? { current_time: row.current_time, duration: row.duration, is_completed: !!row.is_completed }
            : { current_time: 0, is_completed: false },
        'Progress'
    );
}

module.exports = {
    authorize,
    stream,
    saveProgress,
    getProgress,
};
