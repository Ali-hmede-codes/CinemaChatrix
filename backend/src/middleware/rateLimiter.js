/**
 * Rate-limiting middleware.
 *
 * Three tiers:
 *   - apiLimiter       : general API routes (100 req / 15 min)
 *   - authLimiter      : login & auth endpoints (5 req / 15 min)
 *   - codeRedeemLimiter: code redemption (5 req / 15 min) — prevents brute force
 */

const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const windowMs = env.security.rateLimitWindow * 60 * 1000; // minutes → ms

/* ------------------------------------------------------------------ */
/*  Limiters                                                           */
/* ------------------------------------------------------------------ */

const apiLimiter = rateLimit({
    windowMs,
    max: env.security.rateLimitMax,
    standardHeaders: true,          // Return rate limit info in headers
    legacyHeaders: false,           // Disable X-RateLimit-* headers
    // Don't count import-status polling: the admin panel polls this every
    // couple of seconds while a bulk remote import runs, which would
    // otherwise quickly exhaust the general limit on long imports.
    skip: (req) => req.originalUrl.startsWith('/api/imports/'),
    message: {
        success: false,
        error: 'Too many requests. Please try again later.',
    },
});

const authLimiter = rateLimit({
    windowMs,
    max: env.security.codeRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many login attempts. Please try again in 15 minutes.',
    },
});

const codeRedeemLimiter = rateLimit({
    windowMs,
    max: env.security.codeRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many code attempts. Please try again in 15 minutes.',
    },
});

module.exports = { apiLimiter, authLimiter, codeRedeemLimiter };
