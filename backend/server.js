/**
 * Server entry point.
 *
 * Starts the Express HTTP server on the configured port.
 * Also handles graceful shutdown (Ctrl+C / SIGTERM).
 *
 * Usage:
 *   npm start          → node server.js (production)
 *   npm run dev        → nodemon server.js (development, auto-restart)
 */

const app = require('./src/app');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const { closeDb } = require('./src/config/database');

/* ------------------------------------------------------------------ */
/*  Start server                                                       */
/* ------------------------------------------------------------------ */

const PORT = env.server.port;

const server = app.listen(PORT, () => {
    logger.info('========================================');
    logger.info(`  CinemaChatrix API`);
    logger.info(`  Environment: ${env.server.nodeEnv}`);
    logger.info(`  Listening:   http://localhost:${PORT}`);
    logger.info(`  Health:      http://localhost:${PORT}/health`);
    logger.info('========================================');
});

/* ------------------------------------------------------------------ */
/*  Graceful shutdown                                                  */
/* ------------------------------------------------------------------ */

function gracefulShutdown(signal) {
    logger.info(`[${signal}] Shutting down gracefully...`);

    server.close((err) => {
        if (err) {
            logger.error('[shutdown] Error closing server:', err);
            process.exit(1);
        }

        logger.info('[shutdown] HTTP server closed');

        // Close database connection
        closeDb();

        logger.info('[shutdown] All connections closed. Goodbye!');
        process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
        logger.error('[shutdown] Forcing exit after timeout');
        process.exit(1);
    }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Catch uncaught exceptions — log and exit
process.on('uncaughtException', (err) => {
    logger.error('[uncaughtException]', err);
    process.exit(1);
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason) => {
    logger.error('[unhandledRejection]', reason);
    process.exit(1);
});

module.exports = server;
