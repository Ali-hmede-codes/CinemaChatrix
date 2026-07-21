/**
 * SQLite database connection (singleton).
 *
 * Uses better-sqlite3 for synchronous, fast, parameterized queries.
 * The database file and schema are created automatically on first run.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const env = require('./env');
const { DIRS, ensureDirectories } = require('./paths');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Connection                                                         */
/* ------------------------------------------------------------------ */

let db = null;

/**
 * Returns the singleton database instance.
 * Creates it on first call (lazy initialization so that the logger
 * and config modules are fully loaded first).
 *
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
    if (db) return db;

    // Make sure the database directory exists
    ensureDirectories();

    const dbPath = path.join(DIRS.root, env.database.path);
    logger.info(`[database] Opening SQLite at: ${dbPath}`);

    db = new Database(dbPath);

    // Recommended pragmas for reliability and performance
    db.pragma('journal_mode = WAL');       // Write-Ahead Logging — better concurrency
    db.pragma('foreign_keys = ON');        // Enforce foreign key constraints
    db.pragma('synchronous = NORMAL');     // Good balance of safety vs speed (safe with WAL)
    db.pragma('busy_timeout = 5000');      // Wait 5s if database is locked

    return db;
}

/**
 * Initializes the database schema by running schema.sql.
 * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
 */
function initSchema() {
    const database = getDb();
    const schemaPath = DIRS.schemaSql;

    if (!fs.existsSync(schemaPath)) {
        throw new Error(`[database] Schema file not found: ${schemaPath}`);
    }

    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

    // Apply in-place migrations BEFORE running schema.sql. schema.sql may
    // reference new columns (e.g. the index on codes.series_id) that an older
    // database won't have until migrated, which would otherwise error out.
    runMigrations(database);

    database.exec(schemaSql);

    logger.info('[database] Schema initialized successfully');
}

/**
 * Idempotent, in-place schema migrations for existing databases.
 *
 * `CREATE TABLE IF NOT EXISTS` never alters an already-existing table, so
 * structural changes (new columns, changed CHECK constraints) must be
 * applied here. Each migration checks whether it still needs to run.
 */
function runMigrations(database) {
    /* ---- Migration: whole-series codes -------------------------------
     * Adds `codes.series_id` and relaxes the target CHECK constraint so a
     * code can unlock an entire series. SQLite can't modify a CHECK on an
     * existing table, so we rebuild the table (preserving all rows).
     * ------------------------------------------------------------------ */
    const codeCols = database.prepare('PRAGMA table_info(codes)').all();
    const hasSeriesId = codeCols.some((c) => c.name === 'series_id');

    if (codeCols.length > 0 && !hasSeriesId) {
        logger.info('[database] Migrating codes table → adding whole-series support…');
        const migrate = database.transaction(() => {
            database.exec(`
                CREATE TABLE codes_new (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    code       TEXT UNIQUE NOT NULL,
                    movie_id   INTEGER,
                    episode_id INTEGER,
                    series_id  INTEGER,
                    is_used    INTEGER DEFAULT 0,
                    device_id  INTEGER,
                    created_by INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    used_at    DATETIME,
                    expires_at DATETIME,
                    FOREIGN KEY (movie_id)   REFERENCES movies(id)   ON DELETE SET NULL,
                    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL,
                    FOREIGN KEY (series_id)  REFERENCES series(id)   ON DELETE SET NULL,
                    FOREIGN KEY (device_id)  REFERENCES devices(id)  ON DELETE SET NULL,
                    FOREIGN KEY (created_by) REFERENCES admins(id),
                    CONSTRAINT chk_code_target CHECK (
                        (movie_id   IS NOT NULL AND episode_id IS NULL AND series_id IS NULL) OR
                        (episode_id IS NOT NULL AND movie_id   IS NULL AND series_id IS NULL) OR
                        (series_id  IS NOT NULL AND movie_id   IS NULL AND episode_id IS NULL)
                    )
                );

                INSERT INTO codes_new
                    (id, code, movie_id, episode_id, series_id, is_used, device_id,
                     created_by, created_at, used_at, expires_at)
                SELECT
                    id, code, movie_id, episode_id, NULL, is_used, device_id,
                    created_by, created_at, used_at, expires_at
                FROM codes;

                DROP TABLE codes;
                ALTER TABLE codes_new RENAME TO codes;

                CREATE INDEX IF NOT EXISTS idx_codes_code    ON codes(code);
                CREATE INDEX IF NOT EXISTS idx_codes_movie   ON codes(movie_id);
                CREATE INDEX IF NOT EXISTS idx_codes_episode ON codes(episode_id);
                CREATE INDEX IF NOT EXISTS idx_codes_series  ON codes(series_id);
                CREATE INDEX IF NOT EXISTS idx_codes_device  ON codes(device_id);
            `);
        });
        migrate();
        logger.info('[database] codes table migrated successfully');
    }

    /* ---- Migration: cascade-delete codes with their content -----------
     * The original content FKs used ON DELETE SET NULL. That conflicts with
     * chk_code_target (exactly one of movie/episode/series must be non-NULL):
     * deleting the target nulled the only non-NULL column, leaving an
     * all-NULL row that fails the CHECK and throws SQLITE_CONSTRAINT_CHECK
     * (crashing episode/movie/series deletes). Rebuild with ON DELETE CASCADE
     * so a code is removed together with the content it unlocks.
     * ------------------------------------------------------------------ */
    const codeFks = database.prepare('PRAGMA foreign_key_list(codes)').all();
    const contentFks = ['movie_id', 'episode_id', 'series_id'];
    const needsCascade = codeFks.some(
        (fk) => contentFks.includes(fk.from) && fk.on_delete !== 'CASCADE'
    );

    if (codeFks.length > 0 && needsCascade) {
        logger.info('[database] Migrating codes table → ON DELETE CASCADE for content targets…');
        const migrateCascade = database.transaction(() => {
            database.exec(`
                CREATE TABLE codes_cascade (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    code       TEXT UNIQUE NOT NULL,
                    movie_id   INTEGER,
                    episode_id INTEGER,
                    series_id  INTEGER,
                    is_used    INTEGER DEFAULT 0,
                    device_id  INTEGER,
                    created_by INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    used_at    DATETIME,
                    expires_at DATETIME,
                    FOREIGN KEY (movie_id)   REFERENCES movies(id)   ON DELETE CASCADE,
                    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
                    FOREIGN KEY (series_id)  REFERENCES series(id)   ON DELETE CASCADE,
                    FOREIGN KEY (device_id)  REFERENCES devices(id)  ON DELETE SET NULL,
                    FOREIGN KEY (created_by) REFERENCES admins(id),
                    CONSTRAINT chk_code_target CHECK (
                        (movie_id   IS NOT NULL AND episode_id IS NULL AND series_id IS NULL) OR
                        (episode_id IS NOT NULL AND movie_id   IS NULL AND series_id IS NULL) OR
                        (series_id  IS NOT NULL AND movie_id   IS NULL AND episode_id IS NULL)
                    )
                );

                INSERT INTO codes_cascade
                    (id, code, movie_id, episode_id, series_id, is_used, device_id,
                     created_by, created_at, used_at, expires_at)
                SELECT
                    id, code, movie_id, episode_id, series_id, is_used, device_id,
                    created_by, created_at, used_at, expires_at
                FROM codes;

                DROP TABLE codes;
                ALTER TABLE codes_cascade RENAME TO codes;

                CREATE INDEX IF NOT EXISTS idx_codes_code    ON codes(code);
                CREATE INDEX IF NOT EXISTS idx_codes_movie   ON codes(movie_id);
                CREATE INDEX IF NOT EXISTS idx_codes_episode ON codes(episode_id);
                CREATE INDEX IF NOT EXISTS idx_codes_series  ON codes(series_id);
                CREATE INDEX IF NOT EXISTS idx_codes_device  ON codes(device_id);
            `);
        });
        migrateCascade();
        logger.info('[database] codes table migrated to ON DELETE CASCADE');
    }

    /* ---- Migration: universal (redeemer-chosen) codes -----------------
     * Adds `codes.kind` and relaxes the target CHECK so a code can be
     * generic — unlocking a film / series the redeemer picks at redeem time
     * (all targets NULL until then). SQLite can't modify a CHECK on an
     * existing table, so we rebuild it (preserving all rows).
     * ------------------------------------------------------------------ */
    const codeCols2 = database.prepare('PRAGMA table_info(codes)').all();
    const hasKind = codeCols2.some((c) => c.name === 'kind');

    if (codeCols2.length > 0 && !hasKind) {
        logger.info('[database] Migrating codes table → adding universal (redeemer-chosen) code support…');
        const migrateKind = database.transaction(() => {
            database.exec(`
                CREATE TABLE codes_kind (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    code       TEXT UNIQUE NOT NULL,
                    movie_id   INTEGER,
                    episode_id INTEGER,
                    series_id  INTEGER,
                    kind       TEXT,
                    is_used    INTEGER DEFAULT 0,
                    device_id  INTEGER,
                    created_by INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    used_at    DATETIME,
                    expires_at DATETIME,
                    FOREIGN KEY (movie_id)   REFERENCES movies(id)   ON DELETE CASCADE,
                    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
                    FOREIGN KEY (series_id)  REFERENCES series(id)   ON DELETE CASCADE,
                    FOREIGN KEY (device_id)  REFERENCES devices(id)  ON DELETE SET NULL,
                    FOREIGN KEY (created_by) REFERENCES admins(id),
                    CONSTRAINT chk_code_target CHECK (
                        (movie_id   IS NOT NULL AND episode_id IS NULL AND series_id IS NULL) OR
                        (episode_id IS NOT NULL AND movie_id   IS NULL AND series_id IS NULL) OR
                        (series_id  IS NOT NULL AND movie_id   IS NULL AND episode_id IS NULL) OR
                        (movie_id IS NULL AND episode_id IS NULL AND series_id IS NULL AND COALESCE(kind,'') IN ('film','series'))
                    )
                );

                INSERT INTO codes_kind
                    (id, code, movie_id, episode_id, series_id, kind, is_used, device_id,
                     created_by, created_at, used_at, expires_at)
                SELECT
                    id, code, movie_id, episode_id, series_id, NULL, is_used, device_id,
                    created_by, created_at, used_at, expires_at
                FROM codes;

                DROP TABLE codes;
                ALTER TABLE codes_kind RENAME TO codes;

                CREATE INDEX IF NOT EXISTS idx_codes_code    ON codes(code);
                CREATE INDEX IF NOT EXISTS idx_codes_movie   ON codes(movie_id);
                CREATE INDEX IF NOT EXISTS idx_codes_episode ON codes(episode_id);
                CREATE INDEX IF NOT EXISTS idx_codes_series  ON codes(series_id);
                CREATE INDEX IF NOT EXISTS idx_codes_device  ON codes(device_id);
            `);
        });
        migrateKind();
        logger.info('[database] codes table migrated — universal codes enabled');
    }
}

/**
 * Closes the database connection gracefully.
 */
function closeDb() {
    if (db) {
        db.close();
        db = null;
        logger.info('[database] Connection closed');
    }
}

module.exports = { getDb, initSchema, closeDb };
