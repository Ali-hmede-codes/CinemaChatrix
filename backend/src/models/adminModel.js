/**
 * Admin model — all database operations for the `admins` table.
 *
 * Every query uses parameterized statements (? placeholders) so there's
 * no risk of SQL injection. Password hashing/verification is handled in
 * the controller — this model only stores and reads raw rows.
 */

const { getDb } = require('../config/database');

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/**
 * Find an admin by username.
 * @param {string} username
 * @returns {object|undefined} admin row or undefined
 */
function findByUsername(username) {
    return getDb()
        .prepare('SELECT * FROM admins WHERE username = ?')
        .get(username);
}

/**
 * Find an admin by id.
 * @param {number} id
 * @returns {object|undefined} admin row or undefined
 */
function findById(id) {
    return getDb()
        .prepare('SELECT id, username, role, created_at FROM admins WHERE id = ?')
        .get(id);
}

/**
 * Create a new admin.
 * @param {string} username
 * @param {string} passwordHash - already-bcrypt-hashed password
 * @param {string} role
 * @returns {object} the created admin (id, username, role)
 */
function create(username, passwordHash, role = 'admin') {
    const info = getDb()
        .prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
        .run(username, passwordHash, role);
    return findById(info.lastInsertRowid);
}

/**
 * Update an admin's password.
 * @param {number} id
 * @param {string} passwordHash - already-bcrypt-hashed password
 * @returns {boolean} true if a row was updated
 */
function updatePassword(id, passwordHash) {
    const info = getDb()
        .prepare('UPDATE admins SET password_hash = ? WHERE id = ?')
        .run(passwordHash, id);
    return info.changes > 0;
}

module.exports = {
    findByUsername,
    findById,
    create,
    updatePassword,
};
