/**
 * Centralized error-handling middleware.
 *
 * Placed last in the Express middleware chain (after all routes).
 * Catches errors passed via next(err) and thrown in async route handlers.
 */

const logger = require('../utils/logger');
const response = require('../utils/response');

/* ------------------------------------------------------------------ */
/*  404 handler — no route matched                                     */
/* ------------------------------------------------------------------ */

function notFoundHandler(req, res, _next) {
    return response.error(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);
}

/* ------------------------------------------------------------------ */
/*  500 handler — catch-all for all errors                             */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
    // Log the full error with stack trace
    logger.error(`[error] ${req.method} ${req.originalUrl}: ${err.message}`, { stack: err.stack });

    // Multer file size error
    if (err.code === 'LIMIT_FILE_SIZE') {
        return response.error(res, 'File too large. Maximum upload size exceeded.', 413);
    }

    // Multer unexpected field
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return response.error(res, 'Unexpected file field in upload.', 400);
    }

    // JSON parse error
    if (err.type === 'entity.parse.failed') {
        return response.error(res, 'Invalid JSON in request body.', 400);
    }

    // Express-validator errors (array in err.errors)
    if (err.errors && Array.isArray(err.errors)) {
        return response.error(res, 'Validation failed', 422, err.errors);
    }

    // Default — don't leak internal error details in production, EXCEPT for
    // errors explicitly flagged as safe to show (operational, user-facing ones
    // such as a bad import link or a missing FFmpeg). Truly unexpected errors
    // still fall back to a generic message so we never leak internals.
    const expose = err.expose === true || (typeof err.status === 'number' && err.status < 500);
    const message = process.env.NODE_ENV === 'production' && !expose
        ? 'Internal server error'
        : err.message;

    return response.error(res, message, err.status || 500);
}

module.exports = { notFoundHandler, errorHandler };
