/**
 * Admin authentication middleware.
 *
 * Verifies the JWT from either:
 *   - the httpOnly `admin_token` cookie (server-rendered pages), or
 *   - the `Authorization: Bearer <token>` header (API clients).
 *
 * On success, attaches the decoded payload to `req.admin` and calls next().
 * On failure, responds 401 (no token) or 403 (invalid/expired token).
 */

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const response = require('../utils/response');

module.exports = function authMiddleware(req, res, next) {
    const token =
        req.cookies?.admin_token ||
        (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
            ? req.headers.authorization.split(' ')[1]
            : null);

    if (!token) {
        return response.unauthorized(res, 'Authentication required');
    }

    try {
        const decoded = jwt.verify(token, env.jwt.secret);
        req.admin = decoded;
        return next();
    } catch (err) {
        return response.forbidden(res, 'Invalid or expired token');
    }
};
