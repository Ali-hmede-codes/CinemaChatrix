/**
 * Device model — database operations for the `devices` table.
 *
 * Only the SHA-256 hash of a fingerprint is ever stored (see deviceService).
 * All queries use parameterized statements (? placeholders).
 */

const { getDb } = require('../config/database');

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

function findByFingerprint(fingerprintHash) {
    return getDb()
        .prepare('SELECT * FROM devices WHERE fingerprint_hash = ?')
        .get(fingerprintHash);
}

function findById(id) {
    return getDb().prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert a new device.
 * @param {object} d - { fingerprint_hash, user_agent?, ip_address? }
 * @returns {object} the created device row
 */
function create(d) {
    const info = getDb().prepare(`
        INSERT INTO devices (fingerprint_hash, user_agent, ip_address)
        VALUES (@fingerprint_hash, @user_agent, @ip_address)
    `).run({
        fingerprint_hash: d.fingerprint_hash,
        user_agent: d.user_agent ?? null,
        ip_address: d.ip_address ?? null,
    });
    return findById(info.lastInsertRowid);
}

/**
 * Refresh a device's last_seen timestamp.
 * @param {number} id
 */
function touch(id) {
    getDb()
        .prepare('UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE id = ?')
        .run(id);
}

module.exports = {
    findByFingerprint,
    findById,
    create,
    touch,
};
