/**
 * Auth controller — admin login, logout, and current-user lookup.
 *
 * Passwords are verified with bcrypt. On success a JWT is issued and set
 * both as an httpOnly cookie (XSS-safe for browser pages) and returned in
 * the response body (convenient for API clients / testing tools).
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const adminModel = require('../models/adminModel');
const env = require('../config/env');
const response = require('../utils/response');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function signToken(admin) {
    return jwt.sign(
        { id: admin.id, username: admin.username, role: admin.role },
        env.jwt.secret,
        { expiresIn: env.jwt.expiresIn }
    );
}

function cookieOptions() {
    return {
        httpOnly: true,
        secure: env.server.isProduction,
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000, // 24h
    };
}

/* ------------------------------------------------------------------ */
/*  POST /api/auth/login                                               */
/* ------------------------------------------------------------------ */

async function login(req, res) {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return response.error(res, 'Username and password are required', 400);
    }

    const admin = adminModel.findByUsername(username);
    // Same generic message whether the user or password is wrong (avoids leaking which)
    if (!admin) {
        return response.unauthorized(res, 'Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) {
        return response.unauthorized(res, 'Invalid credentials');
    }

    const token = signToken(admin);
    res.cookie('admin_token', token, cookieOptions());

    logger.info(`[auth] Admin logged in: ${admin.username}`);

    return response.success(
        res,
        {
            token,
            admin: { id: admin.id, username: admin.username, role: admin.role },
        },
        'Login successful'
    );
}

/* ------------------------------------------------------------------ */
/*  POST /api/auth/logout                                              */
/* ------------------------------------------------------------------ */

function logout(req, res) {
    res.clearCookie('admin_token');
    return response.success(res, null, 'Logged out');
}

/* ------------------------------------------------------------------ */
/*  GET /api/auth/me                                                   */
/* ------------------------------------------------------------------ */

function me(req, res) {
    // req.admin is set by authMiddleware
    const admin = adminModel.findById(req.admin.id);
    if (!admin) {
        return response.notFound(res, 'Admin');
    }
    return response.success(res, { admin }, 'Current admin');
}

module.exports = { login, logout, me };
