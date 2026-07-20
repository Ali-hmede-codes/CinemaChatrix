/**
 * Library controller — the user's PERSONAL, device-bound collection.
 *
 *   POST /api/library   body: { device_fingerprint }
 *
 * Returns only content this device has unlocked by redeeming codes. It never
 * returns any code strings — ownership is derived server-side from the codes
 * bound to the device, so nothing sensitive is ever sent to the client.
 *
 * SECURITY MODEL
 *   - The client stores ONLY a device fingerprint (a SHA-256-able string),
 *     never a code. Redeemed codes live in the database, bound to a device.
 *   - This endpoint hashes the fingerprint, finds the device, and lists the
 *     content unlocked by that device's redeemed codes. If the device is
 *     unknown the library is simply empty.
 *   - We also return lightweight id lists (movie_ids / series_ids /
 *     episode_ids) so the browse screens can render lock badges without
 *     leaking anything about other devices.
 */

const deviceModel = require('../models/deviceModel');
const codeModel = require('../models/codeModel');
const deviceService = require('../services/deviceService');
const seriesModel = require('../models/seriesModel');
const paths = require('../config/paths');
const response = require('../utils/response');

function shapeFilm(m) {
    return {
        type: 'film',
        id: m.id,
        title: m.title,
        slug: m.slug,
        description: m.description,
        poster: m.poster_path || m.thumbnail_path || paths.DEFAULT_IMAGE_URL,
        duration: m.duration,
        quality: m.quality,
    };
}

function getLibrary(req, res) {
    const { device_fingerprint } = req.body || {};

    if (!device_fingerprint || !String(device_fingerprint).trim()) {
        return response.error(res, 'Device identification is required', 400);
    }

    const hash = deviceService.hashFingerprint(device_fingerprint);
    const device = deviceModel.findByFingerprint(hash);

    // Unknown device → empty library (this is normal for a brand-new visitor).
    if (!device) {
        return response.success(
            res,
            { films: [], series: [], episode_ids: [], movie_ids: [], series_ids: [] },
            'Empty library'
        );
    }

    const movies = codeModel.getUnlockedMoviesByDevice(device.id);
    const episodes = codeModel.getUnlockedEpisodesByDevice(device.id);
    const fullSeries = codeModel.getUnlockedSeriesByDevice(device.id);

    // Group unlocked episodes under their series so the library can show a
    // series card that opens straight to the episodes the user actually owns.
    const seriesMap = new Map();
    const addSeries = (id, title, slug) => {
        if (!seriesMap.has(id)) {
            const s = seriesModel.findById(id);
            seriesMap.set(id, {
                type: 'series',
                id,
                title: title || (s && s.title),
                slug: slug || (s && s.slug),
                poster: (s && s.poster_path) || paths.DEFAULT_IMAGE_URL,
                whole_series: false,
                unlocked_episode_ids: [],
                episode_count: 0,
            });
        }
        return seriesMap.get(id);
    };

    // Whole-series unlocks first (these own every episode, present & future).
    for (const s of fullSeries) {
        const entry = addSeries(s.id, s.title, s.slug);
        entry.whole_series = true;
        entry.poster = s.poster_path || paths.DEFAULT_IMAGE_URL;
    }

    for (const ep of episodes) {
        const entry = addSeries(ep.series_id, ep.series_title, ep.series_slug);
        entry.unlocked_episode_ids.push(ep.id);
    }

    // Episode counts for the library series cards.
    for (const entry of seriesMap.values()) {
        const eps = seriesModel.findEpisodesBySeries(entry.id);
        entry.episode_count = entry.whole_series ? eps.length : entry.unlocked_episode_ids.length;
    }

    const films = movies.map(shapeFilm);
    const series = [...seriesMap.values()];

    return response.success(
        res,
        {
            films,
            series,
            // Id lists power lock badges on the browse screens.
            movie_ids: movies.map((m) => m.id),
            episode_ids: episodes.map((e) => e.id),
            series_ids: fullSeries.map((s) => s.id),
        },
        'Your library'
    );
}

module.exports = { getLibrary };
