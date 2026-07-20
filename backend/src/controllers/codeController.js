/**
 * Code controller — the one-time / one-device unlock system.
 *
 * Admin (JWT-protected):
 *   POST   /api/codes/generate   generate N codes for a film or episode
 *   GET    /api/codes            list codes (+ optional filters)
 *   DELETE /api/codes/:id        delete a code
 *
 * Public (device, rate-limited):
 *   POST   /api/codes/redeem     redeem a code — binds it to the device
 *   POST   /api/codes/check      check whether a device already has access
 *
 * A code targets exactly ONE movie OR ONE episode. Once redeemed it is
 * bound to a single device and cannot be reused on any other device.
 */

const codeModel = require('../models/codeModel');
const deviceModel = require('../models/deviceModel');
const movieModel = require('../models/movieModel');
const seriesModel = require('../models/seriesModel');
const codeService = require('../services/codeService');
const deviceService = require('../services/deviceService');
const response = require('../utils/response');
const logger = require('../utils/logger');

// Safety cap so a single request can't generate an unbounded batch.
const MAX_QUANTITY = 500;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve an optional expiry input into an ISO datetime string (or null).
 * Accepts either `expires_at` (explicit date) or `expires_in_days` (offset).
 */
function resolveExpiry({ expires_at, expires_in_days }) {
    if (expires_at) {
        const d = new Date(expires_at);
        if (isNaN(d.getTime())) throw new Error('Invalid expires_at date');
        return d.toISOString();
    }
    if (expires_in_days !== undefined && expires_in_days !== null && expires_in_days !== '') {
        const days = Number(expires_in_days);
        if (!Number.isFinite(days) || days <= 0) return null; // 0 / invalid → never expires
        const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        return d.toISOString();
    }
    return null;
}

/**
 * Shape a joined code row into a friendly object with a `target` block.
 */
function shapeCode(row) {
    let target;
    if (row.movie_id != null) {
        target = {
            type: 'movie',
            id: row.movie_id,
            title: row.movie_title,
            slug: row.movie_slug,
        };
    } else if (row.episode_id != null) {
        target = {
            type: 'episode',
            id: row.episode_id,
            title: row.episode_title,
            slug: row.episode_slug,
            season_number: row.episode_season,
            episode_number: row.episode_num,
            series_id: row.ep_series_id,
            series_title: row.ep_series_title,
            series_slug: row.ep_series_slug,
        };
    } else {
        target = {
            type: 'series',
            id: row.series_id,
            title: row.code_series_title,
            slug: row.code_series_slug,
        };
    }

    const expired = row.expires_at ? new Date(row.expires_at) < new Date() : false;
    let status = 'available';
    if (row.is_used) status = 'used';
    else if (expired) status = 'expired';

    return {
        id: row.id,
        code: row.code,
        status,
        is_used: !!row.is_used,
        expired,
        device_id: row.device_id,
        created_at: row.created_at,
        used_at: row.used_at,
        expires_at: row.expires_at,
        target,
    };
}

/* ================================================================== */
/*  ADMIN                                                              */
/* ================================================================== */

/**
 * POST /api/codes/generate  (admin)
 * Body: { movie_id? | episode_id? | series_id?, quantity?, expires_at? | expires_in_days? }
 *
 * A series_id code unlocks EVERY episode of that series (present and future).
 */
function generate(req, res, next) {
    try {
        const { movie_id, episode_id, series_id, quantity = 1 } = req.body || {};

        const movieId = movie_id ? Number(movie_id) : null;
        const episodeId = episode_id ? Number(episode_id) : null;
        const seriesId = series_id ? Number(series_id) : null;

        // Exactly one target is required (matches the DB CHECK constraint).
        const targetsProvided = [movieId, episodeId, seriesId].filter(Boolean).length;
        if (targetsProvided !== 1) {
            return response.error(res, 'Provide exactly one target: movie_id, episode_id, or series_id', 400);
        }

        // Verify the target exists.
        if (movieId && !movieModel.findById(movieId)) {
            return response.notFound(res, 'Film');
        }
        if (episodeId && !seriesModel.findEpisodeById(episodeId)) {
            return response.notFound(res, 'Episode');
        }
        if (seriesId && !seriesModel.findById(seriesId)) {
            return response.notFound(res, 'Series');
        }

        // Validate quantity.
        const qty = Number(quantity);
        if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
            return response.error(res, `Quantity must be a whole number between 1 and ${MAX_QUANTITY}`, 400);
        }

        // Resolve optional expiry.
        let expiresAt;
        try {
            expiresAt = resolveExpiry(req.body || {});
        } catch (e) {
            return response.error(res, e.message, 400);
        }

        // Generate unique codes and persist them.
        const codes = codeService.generateUnique(qty, codeModel.codeExists);
        const created = codeModel.createMany({
            codes,
            movie_id: movieId,
            episode_id: episodeId,
            series_id: seriesId,
            created_by: req.admin.id,
            expires_at: expiresAt,
        });

        const detailed = created.map((c) => shapeCode(codeModel.findByCodeDetailed(c.code)));

        const targetLabel = movieId ? `movie=${movieId}` : episodeId ? `episode=${episodeId}` : `series=${seriesId}`;
        logger.info(`[codes] Generated ${qty} code(s) for ${targetLabel} by admin=${req.admin.id}`);
        return response.success(res, { codes: detailed, count: detailed.length }, 'Codes generated', 201);
    } catch (err) {
        return next(err);
    }
}

/**
 * GET /api/codes  (admin)
 * Query: { movie_id?, episode_id?, series_id?, status? }
 */
function list(req, res) {
    const { movie_id, episode_id, series_id, status } = req.query;
    const rows = codeModel.listDetailed({ movie_id, episode_id, series_id, status });
    const codes = rows.map(shapeCode);

    const summary = {
        total: codes.length,
        used: codes.filter((c) => c.status === 'used').length,
        available: codes.filter((c) => c.status === 'available').length,
        expired: codes.filter((c) => c.status === 'expired').length,
    };

    return response.success(res, { codes, summary }, 'All codes');
}

/**
 * DELETE /api/codes/:id  (admin)
 */
function remove(req, res) {
    const id = Number(req.params.id);
    const ok = codeModel.deleteById(id);
    if (!ok) return response.notFound(res, 'Code');
    logger.info(`[codes] Deleted code id=${id} by admin=${req.admin.id}`);
    return response.success(res, null, 'Code deleted');
}

/* ================================================================== */
/*  PUBLIC (device)                                                    */
/* ================================================================== */

/**
 * POST /api/codes/redeem  (device, rate-limited)
 * Body: { code, device_fingerprint, movie_id?, episode_id? }
 *
 * The optional movie_id/episode_id let the film page verify the code is
 * meant for the content currently being viewed.
 */
function redeem(req, res, next) {
    try {
        const { code, device_fingerprint, movie_id, episode_id, series_id } = req.body || {};

        if (!code || !String(code).trim()) {
            return response.error(res, 'A code is required', 400);
        }
        if (!device_fingerprint || !String(device_fingerprint).trim()) {
            return response.error(res, 'Device identification is required', 400);
        }

        const normalized = codeService.normalize(code);
        if (!normalized) {
            return response.error(res, 'Invalid code format', 400);
        }

        // Resolve (find or create) the device from its fingerprint.
        const device = deviceService.resolveDevice(
            device_fingerprint,
            req.headers['user-agent'],
            req.ip
        );

        const record = codeModel.findByCodeDetailed(normalized);
        if (!record) {
            return response.error(res, 'Invalid code', 404);
        }

        const target = shapeCode(record).target;

        // Already redeemed?
        if (record.is_used) {
            if (record.device_id === device.id) {
                // Same device returning — allow (idempotent unlock).
                return response.success(
                    res,
                    { unlocked: true, already_unlocked: true, target },
                    'Already unlocked on this device'
                );
            }
            return response.forbidden(res, 'This code has already been used on another device');
        }

        // Expired?
        if (record.expires_at && new Date(record.expires_at) < new Date()) {
            return response.forbidden(res, 'This code has expired');
        }

        // Optional: verify the code applies to the content being viewed.
        // A whole-series code is accepted on any episode of that series.
        if (movie_id && record.movie_id !== Number(movie_id)) {
            return response.forbidden(res, 'This code is not valid for this film');
        }
        if (episode_id) {
            const epId = Number(episode_id);
            const ep = seriesModel.findEpisodeById(epId);
            const covers = record.episode_id === epId
                || (record.series_id != null && ep && record.series_id === ep.series_id);
            if (!covers) {
                return response.forbidden(res, 'This code is not valid for this episode');
            }
        }
        if (series_id) {
            const sId = Number(series_id);
            let covers = record.series_id === sId;
            if (!covers && record.episode_id != null) {
                const ep = seriesModel.findEpisodeById(record.episode_id);
                covers = !!(ep && ep.series_id === sId);
            }
            if (!covers) {
                return response.forbidden(res, 'This code is not valid for this series');
            }
        }

        // Bind the code to this device — ONE TIME, ONE DEVICE.
        codeModel.activate(record.id, device.id);

        logger.info(`[codes] Redeemed ${normalized} → device=${device.id} (${target.type}=${target.id})`);
        return response.success(
            res,
            { unlocked: true, already_unlocked: false, target },
            'Code redeemed — content unlocked!'
        );
    } catch (err) {
        return next(err);
    }
}

/**
 * POST /api/codes/check  (device)
 * Body: { device_fingerprint, movie_id?, episode_id? }
 * Returns whether this device already has access to the given content.
 */
function check(req, res) {
    const { device_fingerprint, movie_id, episode_id, series_id } = req.body || {};

    if (!device_fingerprint) {
        return response.error(res, 'Device identification is required', 400);
    }
    if (!movie_id && !episode_id && !series_id) {
        return response.error(res, 'A movie_id, episode_id, or series_id is required', 400);
    }

    const hash = deviceService.hashFingerprint(device_fingerprint);
    const device = deviceModel.findByFingerprint(hash);

    if (!device) {
        return response.success(res, { hasAccess: false }, 'Access status');
    }

    const hasAccess = codeModel.checkAccess(device.id, {
        movieId: movie_id ? Number(movie_id) : null,
        episodeId: episode_id ? Number(episode_id) : null,
        seriesId: series_id ? Number(series_id) : null,
    });

    return response.success(res, { hasAccess }, 'Access status');
}

module.exports = {
    generate,
    list,
    remove,
    redeem,
    check,
};
