/**
 * User controller — manage the admin accounts that can sign into the control
 * panel (stored in the `admins` table).
 *
 * Passwords are always bcrypt-hashed before storage; list/read endpoints never
 * return password hashes. Two safety rails guard deletion: you can't delete the
 * account you're signed in with, and you can't delete the last remaining admin.
 *
 *   GET    /api/users              (admin) list all admin accounts
 *   POST   /api/users              (admin) create a new admin account
 *   PUT    /api/users/:id          (admin) update username / role
 *   PUT    /api/users/:id/password (admin) change an account's password
 *   DELETE /api/users/:id          (admin) delete an admin account
 */

const bcrypt = require('bcryptjs');
const adminModel = require('../models/adminModel');
const response = require('../utils/response');
const logger = require('../utils/logger');

/* Usernames: 3–32 chars, letters/numbers plus dot, dash, underscore. */
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const MIN_PASSWORD = 6;
const ROLES = ['admin', 'superadmin'];

function normalizeRole(role) {
    return ROLES.includes(role) ? role : 'admin';
}

/* ------------------------------------------------------------------ */
/*  GET /api/users                                                     */
/* ------------------------------------------------------------------ */

function list(req, res) {
    return response.success(res, { users: adminModel.findAll() }, 'Admin accounts');
}

/* ------------------------------------------------------------------ */
/*  POST /api/users                                                    */
/* ------------------------------------------------------------------ */

async function create(req, res) {
    const { username, password, role } = req.body || {};
    const uname = String(username || '').trim();

    if (!uname) return response.error(res, 'Username is required', 400);
    if (!USERNAME_RE.test(uname)) {
        return response.error(res, 'Username must be 3–32 characters (letters, numbers, dot, dash, underscore)', 400);
    }
    if (!password || String(password).length < MIN_PASSWORD) {
        return response.error(res, `Password must be at least ${MIN_PASSWORD} characters`, 400);
    }
    if (adminModel.findByUsername(uname)) {
        return response.error(res, 'That username is already taken', 409);
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = adminModel.create(uname, passwordHash, normalizeRole(role));

    logger.info(`[users] Created admin account "${user.username}" (id=${user.id})`);
    return response.success(res, { user }, 'User created', 201);
}

/* ------------------------------------------------------------------ */
/*  PUT /api/users/:id                                                 */
/* ------------------------------------------------------------------ */

function update(req, res) {
    const id = Number(req.params.id);
    const user = adminModel.findById(id);
    if (!user) return response.notFound(res, 'User');

    const { username, role } = req.body || {};
    const fields = {};

    if (username !== undefined) {
        const uname = String(username).trim();
        if (!USERNAME_RE.test(uname)) {
            return response.error(res, 'Username must be 3–32 characters (letters, numbers, dot, dash, underscore)', 400);
        }
        const clash = adminModel.findByUsername(uname);
        if (clash && clash.id !== id) {
            return response.error(res, 'That username is already taken', 409);
        }
        fields.username = uname;
    }
    if (role !== undefined) fields.role = normalizeRole(role);

    const updated = adminModel.updateProfile(id, fields);
    logger.info(`[users] Updated admin account "${updated.username}" (id=${id})`);
    return response.success(res, { user: updated }, 'User updated');
}

/* ------------------------------------------------------------------ */
/*  PUT /api/users/:id/password                                        */
/* ------------------------------------------------------------------ */

async function changePassword(req, res) {
    const id = Number(req.params.id);
    const user = adminModel.findById(id);
    if (!user) return response.notFound(res, 'User');

    const { password } = req.body || {};
    if (!password || String(password).length < MIN_PASSWORD) {
        return response.error(res, `Password must be at least ${MIN_PASSWORD} characters`, 400);
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    adminModel.updatePassword(id, passwordHash);

    logger.info(`[users] Changed password for admin account "${user.username}" (id=${id})`);
    return response.success(res, null, 'Password changed');
}

/* ------------------------------------------------------------------ */
/*  DELETE /api/users/:id                                              */
/* ------------------------------------------------------------------ */

function remove(req, res) {
    const id = Number(req.params.id);
    const user = adminModel.findById(id);
    if (!user) return response.notFound(res, 'User');

    if (req.admin && Number(req.admin.id) === id) {
        return response.error(res, 'You cannot delete the account you are signed in with', 400);
    }
    if (adminModel.countAll() <= 1) {
        return response.error(res, 'Cannot delete the last remaining admin account', 400);
    }

    adminModel.deleteById(id);
    logger.info(`[users] Deleted admin account "${user.username}" (id=${id})`);
    return response.success(res, null, 'User deleted');
}

module.exports = { list, create, update, changePassword, remove };
