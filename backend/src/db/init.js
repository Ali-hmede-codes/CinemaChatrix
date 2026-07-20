/**
 * Database initialization script.
 *
 * Usage:  npm run init-db
 *
 * 1. Creates all directories
 * 2. Opens the SQLite connection
 * 3. Runs schema.sql (CREATE TABLE IF NOT EXISTS — safe to re-run)
 * 4. Seeds the default admin user if none exists
 *
 * This script is idempotent — you can run it as many times as you want.
 */

const bcrypt = require('bcryptjs');
const { getDb, initSchema, closeDb } = require('../config/database');
const { ensureDirectories } = require('../config/paths');
const env = require('../config/env');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Seed admin                                                         */
/* ------------------------------------------------------------------ */

function seedAdmin() {
    const db = getDb();

    // Check if any admin already exists
    const existing = db.prepare('SELECT id FROM admins LIMIT 1').get();

    if (existing) {
        logger.info('[init] Admin user already exists — skipping seed');
        return;
    }

    // Hash the password from env (dynamically — no hard-coded hashes)
    const passwordHash = bcrypt.hashSync(env.admin.password, 10);

    db.prepare(`
        INSERT INTO admins (username, password_hash, role)
        VALUES (?, ?, 'admin')
    `).run(env.admin.username, passwordHash);

    logger.info(`[init] Default admin created — username: "${env.admin.username}"`);
    logger.warn('[init] IMPORTANT: Change the default admin password after first login!');
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

function main() {
    logger.info('========================================');
    logger.info('  CinemaChatrix — Database Initialization');
    logger.info('========================================');

    try {
        // 1. Create directories
        logger.info('[init] Ensuring directories...');
        ensureDirectories();

        // 2. Initialize schema
        logger.info('[init] Creating database schema...');
        initSchema();

        // 3. Seed admin
        logger.info('[init] Seeding admin user...');
        seedAdmin();

        // 4. Summary
        const db = getDb();
        const tables = db.prepare(`
            SELECT name FROM sqlite_master
            WHERE type='table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        `).all();

        logger.info(`[init] Tables created: ${tables.map(t => t.name).join(', ')}`);
        logger.info('[init] Database initialization complete!');
    } catch (err) {
        logger.error('[init] Database initialization failed:', err);
        process.exit(1);
    } finally {
        closeDb();
    }
}

main();
