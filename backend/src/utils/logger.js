/**
 * Winston logger configuration.
 *
 * Logs to both console (colorized) and rotating files.
 * In production, only warnings and errors go to the console.
 */

const path = require('path');
const fs = require('fs-extra');
const winston = require('winston');
const { DIRS } = require('../config/paths');

// Ensure logs directory exists
fs.ensureDirSync(DIRS.logs);

const { combine, timestamp, printf, colorize, errors } = winston.format;

/* ------------------------------------------------------------------ */
/*  Custom format                                                      */
/* ------------------------------------------------------------------ */

const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    if (stack) {
        return `${timestamp} [${level}] ${message}\n${stack}${metaStr}`;
    }
    return `${timestamp} [${level}] ${message}${metaStr}`;
});

/* ------------------------------------------------------------------ */
/*  Logger instance                                                    */
/* ------------------------------------------------------------------ */

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    transports: [
        // Console (colorized)
        new winston.transports.Console({
            format: combine(colorize(), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
        }),

        // All logs → app.log
        new winston.transports.File({
            filename: path.join(DIRS.logs, 'app.log'),
            maxsize: 10 * 1024 * 1024,  // 10 MB
            maxFiles: 5,
        }),

        // Errors only → error.log
        new winston.transports.File({
            filename: path.join(DIRS.logs, 'error.log'),
            level: 'error',
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5,
        }),
    ],

    // Don't crash on uncaught exceptions — log them
    handleExceptions: true,
    handleRejections: true,
});

module.exports = logger;
