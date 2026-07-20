/**
 * Standardized API response helpers.
 *
 * Every controller uses these so the response shape is consistent:
 *
 *   Success: { success: true,  data: {...},     message: "..." }
 *   Error:   { success: false, error: "...",    details: {...} }
 */

/**
 * Send a success response.
 * @param {import('express').Response} res
 * @param {*} data - payload to return
 * @param {string} message - optional message
 * @param {number} status - HTTP status code (default 200)
 */
function success(res, data = null, message = 'OK', status = 200) {
    return res.status(status).json({
        success: true,
        message,
        data,
    });
}

/**
 * Send an error response.
 * @param {import('express').Response} res
 * @param {string} error - error message
 * @param {number} status - HTTP status code (default 400)
 * @param {*} details - optional extra details
 */
function error(res, error = 'Bad Request', status = 400, details = null) {
    const body = { success: false, error };
    if (details) body.details = details;
    return res.status(status).json(body);
}

/**
 * Send a 404 Not Found response.
 */
function notFound(res, resource = 'Resource') {
    return error(res, `${resource} not found`, 404);
}

/**
 * Send a 403 Forbidden response.
 */
function forbidden(res, message = 'Access denied') {
    return error(res, message, 403);
}

/**
 * Send a 401 Unauthorized response.
 */
function unauthorized(res, message = 'Authentication required') {
    return error(res, message, 401);
}

/**
 * Send a 500 Internal Server Error response.
 */
function serverError(res, message = 'Internal server error') {
    return error(res, message, 500);
}

module.exports = {
    success,
    error,
    notFound,
    forbidden,
    unauthorized,
    serverError,
};
