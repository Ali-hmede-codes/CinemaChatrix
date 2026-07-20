/**
 * Device service.
 *
 * A device is identified by a fingerprint generated client-side (in the
 * browser) from stable characteristics — see BACKEND_GUIDE §7. The server
 * only ever stores the SHA-256 *hash* of that fingerprint, never the raw
 * value, which keeps it privacy-preserving and hard to spoof.
 */

const crypto = require('crypto');
const deviceModel = require('../models/deviceModel');

/* ------------------------------------------------------------------ */
/*  Hashing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Hash a raw device fingerprint with SHA-256.
 * @param {string} fingerprint
 * @returns {string} hex digest
 */
function hashFingerprint(fingerprint) {
    return crypto.createHash('sha256').update(String(fingerprint)).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  Resolution                                                         */
/* ------------------------------------------------------------------ */

/**
 * Find the device for a raw fingerprint, creating it on first sight.
 * Also refreshes `last_seen` so we know when a device was last active.
 *
 * @param {string} rawFingerprint - the raw client fingerprint
 * @param {string} [userAgent]
 * @param {string} [ipAddress]
 * @returns {object} the device row
 */
function resolveDevice(rawFingerprint, userAgent = null, ipAddress = null) {
    const fingerprintHash = hashFingerprint(rawFingerprint);

    let device = deviceModel.findByFingerprint(fingerprintHash);
    if (device) {
        deviceModel.touch(device.id);
        return device;
    }

    device = deviceModel.create({
        fingerprint_hash: fingerprintHash,
        user_agent: userAgent,
        ip_address: ipAddress,
    });
    return device;
}

module.exports = {
    hashFingerprint,
    resolveDevice,
};
