/**
 * Express application configuration.
 *
 * Wires up all middleware (helmet, cors, morgan, rate limiter, etc.)
 * and mounts route groups. This file does NOT start the server —
 * that's done in server.js so the app can be imported in tests.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('path');

const env = require('./config/env');
const { ensureDirectories, DIRS } = require('./config/paths');
const { initSchema } = require('./config/database');
const { apiLimiter } = require('./middleware/rateLimiter');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/authRoutes');
const movieRoutes = require('./routes/movieRoutes');
const seriesRoutes = require('./routes/seriesRoutes');
const importRoutes = require('./routes/importRoutes');
const codeRoutes = require('./routes/codeRoutes');
const catalogRoutes = require('./routes/catalogRoutes');
const libraryRoutes = require('./routes/libraryRoutes');
const watchRoutes = require('./routes/watchRoutes');
const logger = require('./utils/logger');

/* ------------------------------------------------------------------ */
/*  App factory                                                        */
/* ------------------------------------------------------------------ */

function createApp() {
    const app = express();

    /* ---- Trust proxy (for accurate IPs behind reverse proxy) ------ */
    app.set('trust proxy', 1);

    /* ---- Security headers ----------------------------------------- */
    app.use(helmet({
        // Allow video/poster responses to be embedded cross-origin.
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        // In production, ship an explicit Content-Security-Policy that permits
        // exactly what the admin/user frontends use: same-origin scripts, inline
        // styles (one inline style attr + runtime styling), Google Fonts,
        // same-origin media (video streams) and images. Scripts stay locked to
        // 'self' (no inline/CDN JS) — that's where XSS protection matters most.
        // CSP is left off in development to keep local iteration friction-free.
        contentSecurityPolicy: env.server.isProduction ? {
            useDefaults: true,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
                imgSrc: ["'self'", 'data:', 'blob:'],
                mediaSrc: ["'self'", 'blob:'],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                // Don't force http→https upgrades: TLS is owned by the reverse
                // proxy/CDN, and this would break plain-HTTP or local testing.
                upgradeInsecureRequests: null,
            },
        } : false,
    }));

    /* ---- CORS ----------------------------------------------------- */
    app.use(cors({
        origin: env.security.corsOrigin.split(',').map(s => s.trim()),
        credentials: true,  // Allow cookies (httpOnly auth token)
    }));

    /* ---- Body parsing --------------------------------------------- */
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    /* ---- Cookies --------------------------------------------------- */
    app.use(cookieParser());

    /* ---- HTTP request logging ------------------------------------- */
    const morganFormat = env.server.isProduction ? 'combined' : 'dev';
    app.use(morgan(morganFormat, {
        stream: {
            write: (message) => logger.http(message.trim()),
        },
    }));

    /* ---- Bundled images (default fallback image, etc.) ------------ */
    app.use('/static/images', express.static(DIRS.images, {
        maxAge: '7d',
        setHeaders: (res) => {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
    }));

    /* ---- Static files (posters, thumbnails) ----------------------- */
    app.use('/static', express.static(DIRS.public, {
        maxAge: '7d',
        setHeaders: (res) => {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
    }));

    /* ---- Admin panel (static frontend) ---------------------------- */
    app.use('/admin', express.static(path.join(DIRS.public, 'admin')));

    /* ---- User app (static frontend) ------------------------------- */
    app.use('/app', express.static(path.join(DIRS.public, 'user')));

    /* ---- Root → user app (admins go to /admin/) ------------------- */
    app.get('/', (req, res) => res.redirect('/app/'));

    /* ---- Rate limiting (all /api routes) -------------------------- */
    app.use('/api', apiLimiter);

    /* ---- Health check --------------------------------------------- */
    app.get('/health', (req, res) => {
        res.json({
            success: true,
            message: 'CinemaChatrix API is running',
            data: {
                status: 'ok',
                env: env.server.nodeEnv,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
            },
        });
    });

    /* ---- API routes (mounted in Phase 2+) ------------------------- */
    app.use('/api/auth', authRoutes);
    app.use('/api/movies', movieRoutes);
    app.use('/api/series', seriesRoutes);
    app.use('/api/imports', importRoutes);
    app.use('/api/codes', codeRoutes);
    app.use('/api/catalog', catalogRoutes);
    app.use('/api/library', libraryRoutes);
    app.use('/api/watch', watchRoutes);

    // Temporary placeholder so /api responds during Phase 1
    app.get('/api', (req, res) => {
        res.json({
            success: true,
            message: 'CinemaChatrix API',
            data: {
                version: '1.0.0',
                endpoints: 'Coming in Phase 2+',
            },
        });
    });

    /* ---- 404 + Error handlers (must be last) ---------------------- */
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

/* ------------------------------------------------------------------ */
/*  Initialize on first import                                         */
/* ------------------------------------------------------------------ */

// Ensure directories exist
ensureDirectories();

// Initialize database schema (idempotent — safe on every start)
try {
    initSchema();
} catch (err) {
    logger.error('[app] Failed to initialize database schema:', err);
    throw err;
}

module.exports = createApp();
