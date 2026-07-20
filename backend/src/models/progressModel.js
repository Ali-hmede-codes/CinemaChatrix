/**
 * Watch-progress model — database operations for the `watch_progress` table.
 *
 * Stores where a device stopped watching a film or episode so the player can
 * resume. A row is unique per (device, movie|episode) — see the unique index
 * in schema.sql. To stay portable across SQLite versions we do a manual
 * find-then-update/insert rather than relying on ON CONFLICT with an
 * expression index.
 *
 * All queries use parameterized statements (? / @named placeholders).
 */

const { getDb } = require('../config/database');

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

/**
 * Find the saved progress for a device + content target.
 * @param {number} deviceId
 * @param {object} target - { movieId?, episodeId? }
 * @returns {object|undefined}
 */
function find(deviceId, { movieId = null, episodeId = null } = {}) {
    if (movieId) {
        return getDb().prepare(
            'SELECT * FROM watch_progress WHERE device_id = ? AND movie_id = ?'
        ).get(deviceId, Number(movieId));
    }
    if (episodeId) {
        return getDb().prepare(
            'SELECT * FROM watch_progress WHERE device_id = ? AND episode_id = ?'
        ).get(deviceId, Number(episodeId));
    }
    return undefined;
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert or update the progress for a device + content target.
 * @param {object} p - { device_id, movie_id?, episode_id?, current_time, duration }
 * @returns {object} the stored progress row
 */
function upsert({ device_id, movie_id = null, episode_id = null, current_time = 0, duration = null }) {
    const db = getDb();
    const isCompleted = duration && current_time >= duration * 0.95 ? 1 : 0;

    const existing = find(device_id, {
        movieId: movie_id,
        episodeId: episode_id,
    });

    if (existing) {
        db.prepare(`
            UPDATE watch_progress
            SET current_time = @current_time,
                duration     = @duration,
                is_completed = @is_completed,
                updated_at   = CURRENT_TIMESTAMP
            WHERE id = @id
        `).run({
            id: existing.id,
            current_time: Number(current_time) || 0,
            duration: duration != null ? Number(duration) : null,
            is_completed: isCompleted,
        });
        return db.prepare('SELECT * FROM watch_progress WHERE id = ?').get(existing.id);
    }

    const info = db.prepare(`
        INSERT INTO watch_progress
            (device_id, movie_id, episode_id, current_time, duration, is_completed)
        VALUES
            (@device_id, @movie_id, @episode_id, @current_time, @duration, @is_completed)
    `).run({
        device_id,
        movie_id: movie_id != null ? Number(movie_id) : null,
        episode_id: episode_id != null ? Number(episode_id) : null,
        current_time: Number(current_time) || 0,
        duration: duration != null ? Number(duration) : null,
        is_completed: isCompleted,
    });
    return db.prepare('SELECT * FROM watch_progress WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = {
    find,
    upsert,
};
