-- ============================================================
--  CinemaChatrix — Database Schema
--  SQLite via better-sqlite3
--  All queries in the app use parameterized statements (?).
-- ============================================================

-- ============ ADMINS ============
CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT DEFAULT 'admin',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ MOVIES (films) ============
CREATE TABLE IF NOT EXISTS movies (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT NOT NULL,
    slug           TEXT UNIQUE NOT NULL,
    description    TEXT,
    poster_path    TEXT,
    video_path     TEXT NOT NULL,
    thumbnail_path TEXT,
    duration       INTEGER,              -- seconds
    file_size      INTEGER,              -- bytes
    quality        TEXT DEFAULT '1080p',
    is_published   INTEGER DEFAULT 1,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ SERIES ============
CREATE TABLE IF NOT EXISTS series (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    slug         TEXT UNIQUE NOT NULL,
    description  TEXT,
    poster_path  TEXT,
    is_published INTEGER DEFAULT 1,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ EPISODES (belongs to series) ============
CREATE TABLE IF NOT EXISTS episodes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id      INTEGER NOT NULL,
    season_number  INTEGER DEFAULT 1,
    episode_number INTEGER NOT NULL,
    title          TEXT NOT NULL,
    slug           TEXT UNIQUE NOT NULL,
    description    TEXT,
    video_path     TEXT NOT NULL,
    thumbnail_path TEXT,
    duration       INTEGER,
    file_size      INTEGER,
    quality        TEXT DEFAULT '1080p',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
);

-- ============ CATEGORIES ============
-- A simple two-level tree: main categories have parent_id = NULL, and
-- sub-categories point at their main via parent_id. The same set is shared by
-- films and series (e.g. main "عربي" → sub "دراما"). Deleting a main category
-- cascades to its sub-categories (and to every assignment, see below).
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL,
    parent_id  INTEGER,               -- NULL = main category, else a sub-category
    sort_order INTEGER DEFAULT 0,     -- manual ordering within a level
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
);

-- ============ CONTENT ↔ CATEGORY (many-to-many) ============
-- Links a category to ONE movie OR ONE series. A film/series can carry many
-- categories (main and/or sub), and a category can tag many titles.
CREATE TABLE IF NOT EXISTS content_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    movie_id    INTEGER,
    series_id   INTEGER,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
    FOREIGN KEY (movie_id)    REFERENCES movies(id)     ON DELETE CASCADE,
    FOREIGN KEY (series_id)   REFERENCES series(id)     ON DELETE CASCADE,
    CONSTRAINT chk_cc_target CHECK (
        (movie_id  IS NOT NULL AND series_id IS NULL) OR
        (series_id IS NOT NULL AND movie_id  IS NULL)
    )
);

-- ============ CODES ============
-- Each code is tied to ONE movie, ONE episode, OR a WHOLE series.
-- A series code unlocks every episode of that series (present and future).
-- A code can be used ONCE on ONE device.
-- The content targets CASCADE on delete: a code is meaningless once the
-- movie / episode / series it unlocks is gone. (SET NULL would leave an
-- all-NULL row and violate chk_code_target.)
CREATE TABLE IF NOT EXISTS codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT UNIQUE NOT NULL,    -- e.g. "CHX-7K3M-9P2X-4H8T"
    movie_id   INTEGER,
    episode_id INTEGER,
    series_id  INTEGER,                 -- set for a whole-series code
    is_used    INTEGER DEFAULT 0,       -- 0 = unused, 1 = used
    device_id  INTEGER,                 -- null until redeemed
    created_by INTEGER NOT NULL,        -- admin id
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at    DATETIME,
    expires_at DATETIME,                -- optional expiry
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

-- ============ DEVICES ============
-- Each device gets a fingerprint stored in localStorage (client-side)
-- and a server-side hash. Only the hash is stored — never the raw fingerprint.
CREATE TABLE IF NOT EXISTS devices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint_hash  TEXT UNIQUE NOT NULL,
    user_agent        TEXT,
    ip_address        TEXT,
    first_seen        DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen         DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ WATCH PROGRESS ============
-- Saves where the user stopped watching for resume functionality.
CREATE TABLE IF NOT EXISTS watch_progress (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    INTEGER NOT NULL,
    movie_id     INTEGER,
    episode_id   INTEGER,
    current_time REAL NOT NULL DEFAULT 0,    -- seconds
    duration     REAL,
    is_completed INTEGER DEFAULT 0,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id)    REFERENCES devices(id)  ON DELETE CASCADE,
    FOREIGN KEY (movie_id)     REFERENCES movies(id)   ON DELETE CASCADE,
    FOREIGN KEY (episode_id)   REFERENCES episodes(id) ON DELETE CASCADE,
    CONSTRAINT chk_progress_target CHECK (
        (movie_id IS NOT NULL AND episode_id IS NULL) OR
        (movie_id IS NULL AND episode_id IS NOT NULL)
    )
);

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_codes_code       ON codes(code);
CREATE INDEX IF NOT EXISTS idx_codes_movie      ON codes(movie_id);
CREATE INDEX IF NOT EXISTS idx_codes_episode    ON codes(episode_id);
CREATE INDEX IF NOT EXISTS idx_codes_series     ON codes(series_id);
CREATE INDEX IF NOT EXISTS idx_codes_device     ON codes(device_id);
CREATE INDEX IF NOT EXISTS idx_progress_device  ON watch_progress(device_id);
CREATE INDEX IF NOT EXISTS idx_movies_slug      ON movies(slug);
CREATE INDEX IF NOT EXISTS idx_series_slug      ON series(slug);
CREATE INDEX IF NOT EXISTS idx_episodes_series  ON episodes(series_id);

-- Categories: unique slug per level (mains share parent NULL → COALESCE to 0).
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_slug
    ON categories(COALESCE(parent_id, 0), slug);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- Content ↔ category links: block duplicate assignments and speed up lookups.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_unique
    ON content_categories(category_id, COALESCE(movie_id, 0), COALESCE(series_id, 0));
CREATE INDEX IF NOT EXISTS idx_cc_movie    ON content_categories(movie_id);
CREATE INDEX IF NOT EXISTS idx_cc_series   ON content_categories(series_id);
CREATE INDEX IF NOT EXISTS idx_cc_category  ON content_categories(category_id);

-- Unique index for watch_progress upsert (ON CONFLICT).
-- COALESCE handles NULL columns so the composite key is always unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_unique
    ON watch_progress(device_id, COALESCE(movie_id, 0), COALESCE(episode_id, 0));
