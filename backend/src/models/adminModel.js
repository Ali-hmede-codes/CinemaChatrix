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

/**
 * List every admin account (never exposes password hashes), oldest first.
 * @returns {object[]} admin rows (id, username, role, created_at)
 */
function findAll() {
    return getDb()
        .prepare('SELECT id, username, role, created_at FROM admins ORDER BY created_at ASC, id ASC')
        .all();
}

/**
 * Count how many admin accounts exist. Used to block deleting the last one.
 * @returns {number}
 */
function countAll() {
    return getDb().prepare('SELECT COUNT(*) AS n FROM admins').get().n;
}

/**
 * Update an admin's profile fields (username and/or role). Only whitelisted
 * columns are ever written, so the caller can't inject arbitrary column names.
 * @param {number} id
 * @param {{username?: string, role?: string}} fields
 * @returns {object|undefined} the updated admin row
 */
function updateProfile(id, fields = {}) {
    const allowed = ['username', 'role'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k) && fields[k] !== undefined);
    if (!keys.length) return findById(id);
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k]);
    getDb().prepare(`UPDATE admins SET ${setClause} WHERE id = ?`).run(...values, id);
    return findById(id);
}

/**
 * Delete an admin account by id.
 * @param {number} id
 * @returns {boolean} true if a row was removed
 */
function deleteById(id) {
    const info = getDb().prepare('DELETE FROM admins WHERE id = ?').run(id);
    return info.changes > 0;
}

module.exports = {
    findByUsername,
    findById,
    create,
    updatePassword,
    findAll,
    countAll,
    updateProfile,
    deleteById,
};
