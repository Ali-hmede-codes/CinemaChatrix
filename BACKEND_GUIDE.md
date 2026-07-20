# CinemaChatrix — Backend Build Guide

> **Stack:** Node.js + Express + SQLite3 + FFmpeg
> **Goal:** A streaming platform for films & series with a code-based unlock system, admin panel, device-bound playback, and a modern video player.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Folder Structure](#2-folder-structure)
3. [Tech Stack & Dependencies](#3-tech-stack--dependencies)
4. [Database Schema](#4-database-schema)
5. [Upload System (with Auto-Compression)](#5-upload-system-with-auto-compression)
6. [Admin Authentication](#6-admin-authentication)
7. [Code System (One-Time, One-Device)](#7-code-system-one-time-one-device)
8. [Film/Series Pages & Per-Film Links](#8-filmseries-pages--per-film-links)
9. [User Library (Activated Films Only)](#9-user-library-activated-films-only)
10. [Watch Progress (Resume Watching)](#10-watch-progress-resume-watching)
11. [Modern Video Player](#11-modern-video-player)
12. [Security & Anti-Hacking Measures](#12-security--anti-hacking-measures)
13. [API Endpoints Reference](#13-api-endpoints-reference)
14. [Environment Variables](#14-environment-variables)
15. [Build Order (Step-by-Step)](#15-build-order-step-by-step)

---

## 1. Project Overview

### What we are building

| Feature | Description |
|---|---|
| **Video Storage** | Films and series uploaded by admin, auto-compressed with FFmpeg, stored in a structured folder hierarchy |
| **Code System** | Admin generates unique codes per film/episode. User redeems a code to unlock that film. Each code works **once** on **one device** only |
| **Admin Panel** | Admin can upload films/series (file or URL), create/delete folders, generate codes, delete content |
| **Per-Film Page** | Each film has its own link (`/watch/:slug`). Visiting it shows the film info + poster. If user has a valid code, the player appears |
| **User Library** | A page showing only the films the user has unlocked — never all films |
| **Watch Progress** | The player saves where the user stopped watching so they can resume |
| **Modern Player** | Uses **Plyr** (a modern, customizable, battle-tested HTML5 player) wrapping video streaming via range requests |
| **Security** | JWT auth, bcrypt hashing, helmet headers, rate limiting, signed URLs, device fingerprinting, SQL injection protection |

### Folder hierarchy for uploads

```
uploads/
└── 2026-07-16/                ← date (YYYY-MM-DD)
    ├── films/                  ← category: film
    │   └── inception_20260716.mp4
    └── series/                 ← category: series
        └── breaking-bad_s01e01_20260716.mp4
```

Posters go in:
```
public/posters/
└── 2026-07-16/
    ├── films/
    │   └── inception.jpg
    └── series/
        └── breaking-bad.jpg
```

---

## 2. Folder Structure

```
backend/
├── src/
│   ├── config/
│   │   ├── database.js           # SQLite connection (better-sqlite3)
│   │   ├── env.js                # Loads & validates .env
│   │   └── paths.js              # Centralized path constants
│   │
│   ├── controllers/
│   │   ├── authController.js     # Admin login, token refresh
│   │   ├── movieController.js    # Film CRUD
│   │   ├── seriesController.js   # Series + episodes CRUD
│   │   ├── codeController.js     # Generate, redeem, list codes
│   │   ├── uploadController.js   # File upload + URL download + compress
│   │   ├── watchController.js    # Stream video + save progress
│   │   └── libraryController.js  # User's activated films
│   │
│   ├── middleware/
│   │   ├── authMiddleware.js     # Verify admin JWT
│   │   ├── deviceMiddleware.js   # Extract/generate device fingerprint
│   │   ├── errorHandler.js       # Centralized error handler
│   │   ├── rateLimiter.js        # Rate limiting
│   │   └── validator.js          # Request body validation
│   │
│   ├── models/
│   │   ├── adminModel.js         # Admin DB operations
│   │   ├── movieModel.js         # Film DB operations
│   │   ├── seriesModel.js        # Series + episodes DB operations
│   │   ├── codeModel.js          # Code DB operations
│   │   ├── deviceModel.js        # Device DB operations
│   │   └── progressModel.js      # Watch progress DB operations
│   │
│   ├── routes/
│   │   ├── index.js              # Route aggregator
│   │   ├── authRoutes.js
│   │   ├── movieRoutes.js
│   │   ├── seriesRoutes.js
│   │   ├── codeRoutes.js
│   │   ├── uploadRoutes.js
│   │   └── watchRoutes.js
│   │
│   ├── services/
│   │   ├── compressionService.js # FFmpeg wrapper for video compression
│   │   ├── codeService.js        # Code generation logic (crypto-random)
│   │   ├── deviceService.js      # Device fingerprint generation
│   │   ├── storageService.js     # Path builder + file manager
│   │   └── streamingService.js   # Range-request video streaming
│   │
│   ├── utils/
│   │   ├── logger.js             # Winston logger
│   │   ├── crypto.js             # Hashing, token generation
│   │   ├── slug.js               # Slugify titles for URLs
│   │   └── response.js           # Standardized API response helper
│   │
│   ├── db/
│   │   ├── schema.sql            # Full DB schema
│   │   └── seed.sql              # Default admin user
│   │
│   └── app.js                    # Express app configuration
│
├── uploads/                      # Video files (gitignored)
├── public/
│   ├── posters/                  # Poster images
│   └── thumbnails/               # Auto-generated video thumbnails
├── database/
│   └── cinema.db                 # SQLite database file (gitignored)
├── logs/                         # Log files (gitignored)
├── .env                          # Environment variables (gitignored)
├── .env.example                  # Template
├── .gitignore
├── package.json
├── server.js                     # Entry point
└── README.md
```

---

## 3. Tech Stack & Dependencies

### Core

| Package | Purpose |
|---|---|
| `express` | Web framework |
| `better-sqlite3` | Synchronous, fast SQLite driver (better than sqlite3 async for simplicity) |
| `cors` | Cross-origin requests |
| `helmet` | Security headers |
| `morgan` | HTTP request logging |
| `dotenv` | Environment variables |
| `express-rate-limit` | Rate limiting |
| `express-validator` | Input validation |

### Auth & Security

| Package | Purpose |
|---|---|
| `jsonwebtoken` | JWT tokens for admin auth |
| `bcryptjs` | Password hashing |
| `crypto` (built-in) | Code generation, device fingerprinting |
| `cookie-parser` | Parse signed cookies for secure token storage |

### File Handling

| Package | Purpose |
|---|---|
| `multer` | Multipart file uploads |
| `fluent-ffmpeg` | FFmpeg wrapper for compression + thumbnails |
| `axios` | Download videos from URL |
| `fs-extra` | Enhanced file system operations |
| `path` (built-in) | Path manipulation |
| `slugify` | URL-safe slugs for film titles |

### Video Player (Frontend, served as static)

| Library | Purpose |
|---|---|
| **Plyr** (`plyr`) | Modern, customizable HTML5 video player. Lightweight, accessible, supports fullscreen, speed control, captions, and has zero-config defaults. Can be themed via CSS variables. |

> **Why Plyr over Video.js?** Plyr is more modern, smaller bundle, cleaner API, easier to customize, and wraps native `<video>` — meaning fewer edge-case bugs. It also supports HLS via `hls.js` if we add that later.

### Dev Dependencies

| Package | Purpose |
|---|---|
| `nodemon` | Auto-restart on file change |
| `jest` | Testing framework |

### External Requirement

- **FFmpeg** must be installed on the system and available in PATH.
  - Windows: download from `https://ffmpeg.org/download.html` or `winget install Gyan.FFmpeg`
  - Verify: `ffmpeg -version`

### package.json (initial)

```json
{
  "name": "cinemachatrix-backend",
  "version": "1.0.0",
  "description": "Streaming platform backend with code-based unlock system",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "init-db": "node src/db/init.js",
    "test": "jest"
  },
  "dependencies": {
    "axios": "^1.7.0",
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.0.0",
    "cookie-parser": "^1.4.6",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0",
    "express": "^4.19.0",
    "express-rate-limit": "^7.4.0",
    "express-validator": "^7.1.0",
    "fluent-ffmpeg": "^2.1.3",
    "fs-extra": "^11.2.0",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.2",
    "morgan": "^1.10.0",
    "multer": "^1.4.5-lts.1",
    "slugify": "^1.6.6"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "nodemon": "^3.1.0"
  }
}
```

---

## 4. Database Schema

Using SQLite via `better-sqlite3`. All queries use parameterized statements (prevents SQL injection).

### Entity Relationship

```
admins (1) ──< codes (1) ──> movies/episodes (1)
                                   │
devices (1) ──< codes (1) ─────────┘
devices (1) ──< watch_progress (1) ──> movies/episodes
```

### schema.sql

```sql
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
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    description   TEXT,
    poster_path   TEXT,
    video_path    TEXT NOT NULL,
    thumbnail_path TEXT,
    duration      INTEGER,              -- seconds
    file_size     INTEGER,              -- bytes
    quality       TEXT DEFAULT '1080p',
    is_published  INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ SERIES ============
CREATE TABLE IF NOT EXISTS series (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    description   TEXT,
    poster_path   TEXT,
    is_published  INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ EPISODES (belongs to series) ============
CREATE TABLE IF NOT EXISTS episodes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id     INTEGER NOT NULL,
    season_number INTEGER DEFAULT 1,
    episode_number INTEGER NOT NULL,
    title         TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    description   TEXT,
    video_path    TEXT NOT NULL,
    thumbnail_path TEXT,
    duration      INTEGER,
    file_size     INTEGER,
    quality       TEXT DEFAULT '1080p',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
);

-- ============ CODES ============
-- Each code is tied to ONE movie OR ONE episode
-- A code can be used ONCE on ONE device
CREATE TABLE IF NOT EXISTS codes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT UNIQUE NOT NULL,    -- e.g. "CHX-7K3M-9P2X"
    movie_id      INTEGER,
    episode_id    INTEGER,
    is_used       INTEGER DEFAULT 0,       -- 0 = unused, 1 = used
    device_id     INTEGER,                 -- null until redeemed
    created_by    INTEGER NOT NULL,        -- admin id
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at       DATETIME,
    expires_at    DATETIME,                -- optional expiry
    FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE SET NULL,
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES admins(id),
    CONSTRAINT chk_target CHECK (
        (movie_id IS NOT NULL AND episode_id IS NULL) OR
        (movie_id IS NULL AND episode_id IS NOT NULL)
    )
);

-- ============ DEVICES ============
-- Each device gets a fingerprint stored in localStorage + a server-side hash
CREATE TABLE IF NOT EXISTS devices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint_hash  TEXT UNIQUE NOT NULL,   -- hashed fingerprint
    user_agent        TEXT,
    ip_address        TEXT,
    first_seen        DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen         DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ WATCH PROGRESS ============
-- Saves where the user stopped watching for resume functionality
CREATE TABLE IF NOT EXISTS watch_progress (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     INTEGER NOT NULL,
    movie_id      INTEGER,
    episode_id    INTEGER,
    current_time  REAL NOT NULL DEFAULT 0,    -- seconds
    duration      REAL,
    is_completed  INTEGER DEFAULT 0,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
    CONSTRAINT chk_progress_target CHECK (
        (movie_id IS NOT NULL AND episode_id IS NULL) OR
        (movie_id IS NULL AND episode_id IS NOT NULL)
    )
);

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_codes_code ON codes(code);
CREATE INDEX IF NOT EXISTS idx_codes_movie ON codes(movie_id);
CREATE INDEX IF NOT EXISTS idx_codes_episode ON codes(episode_id);
CREATE INDEX IF NOT EXISTS idx_codes_device ON codes(device_id);
CREATE INDEX IF NOT EXISTS idx_progress_device ON watch_progress(device_id);
CREATE INDEX IF NOT EXISTS idx_movies_slug ON movies(slug);
CREATE INDEX IF NOT EXISTS idx_series_slug ON series(slug);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id);
```

### seed.sql (default admin)

```sql
-- Default admin: username = admin, password = ChangeMe123!
-- Password hash is bcrypt hash of "ChangeMe123!"
INSERT OR IGNORE INTO admins (username, password_hash, role)
VALUES ('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'admin');
```

> **IMPORTANT:** Change the default password immediately after first login.

---

## 5. Upload System (with Auto-Compression)

### Flow

```
Admin uploads video file (or provides URL)
        │
        ▼
┌─────────────────────┐
│  Multer receives    │
│  the file to /tmp   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  FFmpeg compresses  │    H.264 video, AAC audio
│  to target quality  │    CRF 23 (good balance)
└─────────┬───────────┘    -preset medium
          │
          ▼
┌─────────────────────┐
│  Move to structured │    uploads/YYYY-MM-DD/films|series/title.mp4
│  folder path        │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Generate thumbnail │    FFmpeg screenshot at 00:00:05
│  + extract duration │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Save to DB         │    movies or episodes table
└─────────────────────┘
```

### Compression Settings (FFmpeg)

```javascript
// src/services/compressionService.js (key logic)

const ffmpeg = require('fluent-ffmpeg');

function compressVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-c:v libx264',          // H.264 codec (universal support)
                '-crf 23',               // Constant Rate Factor: 18=lossless, 23=good, 28=lower quality
                '-preset medium',        // Speed vs compression efficiency
                '-c:a aac',              // AAC audio codec
                '-b:a 128k',             // Audio bitrate
                '-movflags +faststart',  // Move moov atom to start (enables streaming)
                '-vf scale=-2:1080',     // Scale to 1080p max (keeps aspect ratio)
                '-profile:v high',
                '-level 4.0',
                '-pix_fmt yuv420p'       // Broad compatibility
            ])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .run();
    });
}
```

**Why these settings?**
- `CRF 23`: Visually lossless to most viewers, reduces file size 40-60%
- `-preset medium`: Good balance of encoding speed and compression
- `faststart`: Critical for streaming — allows playback before full download
- `scale=-2:1080`: Ensures height is 1080 max, width auto-scales (must be even)
- `yuv420p`: Maximum browser compatibility

### Path Building Logic

```javascript
// src/services/storageService.js (key logic)

const path = require('path');
const fs = require('fs-extra');
const slugify = require('slugify');

function buildVideoPath(category, title) {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const safeTitle = slugify(title, { lower: true, strict: true });
    const folder = category === 'series' ? 'series' : 'films';
    const dir = path.join(process.cwd(), 'uploads', date, folder);

    fs.ensureDirSync(dir);  // creates folder if not exists

    const timestamp = Date.now();
    const filename = `${safeTitle}_${timestamp}.mp4`;
    return path.join(dir, filename);
}

function buildPosterPath(category, title, ext = 'jpg') {
    const date = new Date().toISOString().split('T')[0];
    const safeTitle = slugify(title, { lower: true, strict: true });
    const folder = category === 'series' ? 'series' : 'films';
    const dir = path.join(process.cwd(), 'public', 'posters', date, folder);

    fs.ensureDirSync(dir);

    return path.join(dir, `${safeTitle}.${ext}`);
}
```

### Multer Configuration

```javascript
// src/config/multer.js (key logic)

const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const tempDir = path.join(process.cwd(), 'uploads', '_temp');
        fs.ensureDirSync(tempDir);
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/avi', 'video/mkv', 'video/quicktime', 'video/x-matroska'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only video files allowed.'), false);
    }
};

module.exports = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 * 1024  // 5GB max (before compression)
    }
});
```

### Upload from URL

```javascript
// src/services/storageService.js — downloadFromUrl

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

async function downloadFromUrl(url, tempPath) {
    const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        timeout: 300000  // 5 min timeout
    });

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(tempPath));
        writer.on('error', reject);
    });
}
```

---

## 6. Admin Authentication

### Flow

```
Admin sends POST /api/auth/login { username, password }
        │
        ▼
   Verify with bcrypt.compare()
        │
        ▼
   Generate JWT (expires 24h)
        │
        ▼
   Set as httpOnly cookie + return in body
```

### Key Code

```javascript
// src/controllers/authController.js (key logic)

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const adminModel = require('../models/adminModel');

exports.login = async (req, res) => {
    const { username, password } = req.body;

    const admin = adminModel.findByUsername(username);
    if (!admin) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
        { id: admin.id, username: admin.username, role: admin.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    // Set httpOnly cookie (XSS-safe)
    res.cookie('admin_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000
    });

    res.json({ message: 'Login successful', token });
};

exports.logout = (req, res) => {
    res.clearCookie('admin_token');
    res.json({ message: 'Logged out' });
};
```

### Auth Middleware

```javascript
// src/middleware/authMiddleware.js

const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
    const token = req.cookies.admin_token || req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};
```

---

## 7. Code System (One-Time, One-Device)

### How it works

```
1. Admin generates code(s) for a specific film or episode
   POST /api/codes/generate { movie_id: 5, quantity: 10 }
   → Returns: ["CHX-7K3M-9P2X", "CHX-2J8L-5R1W", ...]

2. User visits film page → enters code
   POST /api/codes/redeem { code: "CHX-7K3M-9P2X", device_fingerprint: "..." }

3. Server checks:
   ✓ Code exists
   ✓ Code is not used (is_used = 0)
   ✓ Code is not expired
   ✓ Code's movie_id matches the film being viewed

4. If valid:
   → Bind code to device (set device_id, is_used=1, used_at=now)
   → Return success + film unlock token
   → Film appears in user's library

5. If code is reused:
   → Check if same device → allow (resume)
   → Different device → reject "Code already used on another device"
```

### Code Format

```
CHX-XXXX-XXXX

CHX     = prefix (CinemaChatrix)
XXXX    = 4 random uppercase alphanumeric chars
XXXX    = 4 random uppercase alphanumeric chars

Total: 12 chars, ~1.6 billion combinations
```

### Code Generation (cryptographically secure)

```javascript
// src/services/codeService.js

const crypto = require('crypto');

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0,O,1,I)

function generateCode() {
    const part = () => {
        const bytes = crypto.randomBytes(4);
        let result = '';
        for (let i = 0; i < 4; i++) {
            result += CHARSET[bytes[i] % CHARSET.length];
        }
        return result;
    };
    return `CHX-${part()}-${part()}`;
}

function generateUniqueCodes(quantity, existingCodes) {
    const codes = new Set();
    while (codes.size < quantity) {
        const code = generateCode();
        if (!existingCodes.has(code)) {
            codes.add(code);
        }
    }
    return [...codes];
}
```

### Device Fingerprinting

The device fingerprint is generated **client-side** from a combination of browser characteristics and stored in `localStorage`. It is **hashed** before being sent to the server.

```javascript
// FRONTEND — generate device fingerprint (runs in browser)
async function generateDeviceFingerprint() {
    const components = [
        navigator.userAgent,
        navigator.language,
        screen.width + 'x' + screen.height,
        screen.colorDepth,
        new Date().getTimezoneOffset(),
        navigator.hardwareConcurrency || 0,
        // Canvas fingerprint (unique per device/browser)
        getCanvasFingerprint()
    ].join('|');

    // Hash with SHA-256
    const encoder = new TextEncoder();
    const data = encoder.encode(components);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCanvasFingerprint() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('CinemaChatrix', 2, 15);
    return canvas.toDataURL();
}

// Store in localStorage so it persists
function getOrCreateDeviceId() {
    let fp = localStorage.getItem('device_fp');
    if (!fp) {
        generateDeviceFingerprint().then(hash => {
            localStorage.setItem('device_fp', hash);
            fp = hash;
        });
    }
    return fp;
}
```

> **Security note:** The fingerprint is stored in localStorage (not a cookie) to persist across sessions. The server stores only the **hash** of the fingerprint — never the raw components. This makes it extremely difficult to spoof.

### Redeem Code Logic

```javascript
// src/controllers/codeController.js (key logic)

exports.redeemCode = async (req, res) => {
    const { code, device_fingerprint, movie_id } = req.body;

    // 1. Hash the device fingerprint
    const deviceHash = crypto.createHash('sha256').update(device_fingerprint).digest('hex');

    // 2. Find or create device
    let device = deviceModel.findByFingerprint(deviceHash);
    if (!device) {
        device = deviceModel.create(deviceHash, req.headers['user-agent'], req.ip);
    }

    // 3. Find the code
    const codeRecord = codeModel.findByCode(code);
    if (!codeRecord) {
        return res.status(404).json({ error: 'Invalid code' });
    }

    // 4. Check if code is already used
    if (codeRecord.is_used) {
        // If same device → allow (user is returning)
        if (codeRecord.device_id === device.id) {
            return res.json({ message: 'Already unlocked', already_unlocked: true });
        }
        return res.status(403).json({ error: 'This code has already been used on another device' });
    }

    // 5. Check expiry
    if (codeRecord.expires_at && new Date(codeRecord.expires_at) < new Date()) {
        return res.status(403).json({ error: 'Code has expired' });
    }

    // 6. Verify the code is for THIS movie/episode
    if (movie_id && codeRecord.movie_id !== movie_id) {
        return res.status(403).json({ error: 'This code is not valid for this film' });
    }

    // 7. Bind code to device — ONE TIME, ONE DEVICE
    codeModel.activate(codeRecord.id, device.id);

    res.json({
        message: 'Code redeemed successfully! Film unlocked.',
        unlocked: true,
        movie_id: codeRecord.movie_id
    });
};
```

---

## 8. Film/Series Pages & Per-Film Links

### URL Structure

| Page | URL | Who can access |
|---|---|---|
| Film detail page | `/watch/:slug` | Public (shows info + poster, player hidden until code entered) |
| Series detail page | `/series/:slug` | Public (shows series info, episodes hidden until code) |
| Episode player | `/series/:slug/s:season/e:episode` | Requires valid code for that episode |
| User library | `/library` | Shows only unlocked films for this device |

### Film Page Behavior

```
User visits /watch/inception
        │
        ▼
  Server fetches movie by slug
        │
        ▼
  Renders page with:
    - Title, description, poster, duration
    - Code input field
    - Player HIDDEN initially
        │
        ▼
  User enters code → POST /api/codes/redeem
        │
        ▼
  Code valid? ──NO──→ Show error message
        │
       YES
        │
        ▼
  Player APPEARS
  Film added to library for this device
  If returning (already unlocked), player appears immediately
```

### Key Route

```javascript
// src/routes/watchRoutes.js

// Get film info by slug (public)
router.get('/info/:slug', watchController.getFilmInfo);

// Check if device has unlocked this film
router.post('/check-access', watchController.checkAccess);

// Stream video (only if device has access)
router.get('/stream/:slug', authMiddleware.optionalDevice, watchController.streamVideo);
```

---

## 9. User Library (Activated Films Only)

### How it works

The library shows **only** films the user has unlocked via codes. It never shows all films.

```javascript
// src/controllers/libraryController.js

exports.getUserLibrary = (req, res) => {
    const { device_fingerprint } = req.body;

    const deviceHash = crypto.createHash('sha256').update(device_fingerprint).digest('hex');
    const device = deviceModel.findByFingerprint(deviceHash);

    if (!device) {
        return res.json({ movies: [], episodes: [] });
    }

    // Get all films unlocked by this device's codes
    const movies = codeModel.getUnlockedMoviesByDevice(device.id);
    const episodes = codeModel.getUnlockedEpisodesByDevice(device.id);

    res.json({ movies, episodes });
};
```

```sql
-- Get unlocked movies for a device
SELECT m.* FROM codes c
JOIN movies m ON c.movie_id = m.id
WHERE c.device_id = ? AND c.is_used = 1 AND c.movie_id IS NOT NULL;
```

---

## 10. Watch Progress (Resume Watching)

### Save progress every 10 seconds + on pause/exit

```javascript
// src/controllers/watchController.js

exports.saveProgress = (req, res) => {
    const { device_fingerprint, movie_id, episode_id, current_time, duration } = req.body;

    const deviceHash = crypto.createHash('sha256').update(device_fingerprint).digest('hex');
    const device = deviceModel.findByFingerprint(deviceHash);

    if (!device) {
        return res.status(403).json({ error: 'Device not recognized' });
    }

    // Verify the device actually has access to this film
    const hasAccess = codeModel.checkAccess(device.id, movie_id, episode_id);
    if (!hasAccess) {
        return res.status(403).json({ error: 'No access to this content' });
    }

    progressModel.upsert({
        device_id: device.id,
        movie_id,
        episode_id,
        current_time,
        duration,
        is_completed: duration && current_time >= duration * 0.95 ? 1 : 0
    });

    res.json({ message: 'Progress saved' });
};

exports.getProgress = (req, res) => {
    const { device_fingerprint, movie_id, episode_id } = req.body;

    const deviceHash = crypto.createHash('sha256').update(device_fingerprint).digest('hex');
    const device = deviceModel.findByFingerprint(deviceHash);

    if (!device) {
        return res.json({ current_time: 0, is_completed: false });
    }

    const progress = progressModel.findByDeviceAndContent(device.id, movie_id, episode_id);
    res.json(progress || { current_time: 0, is_completed: false });
};
```

```sql
-- Upsert progress (save where user stopped)
INSERT INTO watch_progress (device_id, movie_id, episode_id, current_time, duration, is_completed, updated_at)
VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(device_id, movie_id, episode_id) DO UPDATE SET
    current_time = excluded.current_time,
    duration = excluded.duration,
    is_completed = excluded.is_completed,
    updated_at = CURRENT_TIMESTAMP;
```

> **Note:** Need a UNIQUE constraint on `(device_id, movie_id, episode_id)` for the ON CONFLICT to work. Add this index:
> ```sql
> CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_unique
> ON watch_progress(device_id, COALESCE(movie_id, 0), COALESCE(episode_id, 0));
> ```

### Frontend auto-save logic

```javascript
// FRONTEND — save progress every 10 seconds
setInterval(() => {
    if (!player.paused && player.currentTime > 0) {
        fetch('/api/watch/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_fingerprint: getDeviceFingerprint(),
                movie_id: MOVIE_ID,
                current_time: player.currentTime,
                duration: player.duration
            })
        });
    }
}, 10000); // every 10 seconds

// Also save on pause and before unload
player.on('pause', saveProgress);
window.addEventListener('beforeunload', saveProgress);
```

---

## 11. Modern Video Player

### Why Plyr?

| Feature | Plyr | Video.js | Native `<video>` |
|---|---|---|---|
| Bundle size | ~30KB | ~300KB+ | 0KB |
| Customizability | CSS variables | Complex themes | None |
| Accessibility | Built-in ARIA | Partial | None |
| API simplicity | Very clean | Moderate | Basic |
| Speed control | Built-in | Plugin needed | Native |
| PiP support | Built-in | Plugin needed | Native |
| Active maintenance | Yes | Yes | N/A |

### Setup

```html
<!-- Include Plyr CSS -->
<link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">

<!-- Video element -->
<video id="player" playsinline controls>
    <source src="/api/stream/inception" type="video/mp4">
</video>

<!-- Include Plyr JS -->
<script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
<script>
    const player = new Plyr('#player', {
        controls: [
            'play-large',      // Large play button in center
            'play',            // Play/pause
            'progress',        // Seek bar
            'current-time',    // Current time display
            'duration',        // Total duration
            'mute',            // Mute toggle
            'volume',          // Volume slider
            'settings',        // Settings menu (speed, quality)
            'pip',             // Picture-in-picture
            'airplay',         // AirPlay support
            'fullscreen'       // Fullscreen toggle
        ],
        settings: ['speed', 'quality'],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        ratio: '16:9',
        keyboard: { focused: true, global: true },
        tooltips: { controls: true, seek: true }
    });

    // Resume from saved position
    fetch('/api/watch/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_fingerprint: getDeviceFingerprint(),
            movie_id: MOVIE_ID
        })
    })
    .then(r => r.json())
    .then(data => {
        if (data.current_time > 0 && !data.is_completed) {
            player.currentTime = data.current_time;
        }
    });
</script>
```

### Streaming with Range Requests (Critical)

The server must support HTTP Range requests for video seeking to work:

```javascript
// src/services/streamingService.js

const fs = require('fs');
const path = require('path');

function streamVideo(req, res, filePath) {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        // Parse Range header
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const stream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4'
        });

        stream.pipe(res);
    } else {
        // No range — send entire file
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4'
        });
        fs.createReadStream(filePath).pipe(res);
    }
}
```

> **Security:** The streaming endpoint **must verify device access** before serving video. Never expose the raw file path. Use the slug to look up the path server-side.

---

## 12. Security & Anti-Hacking Measures

### Defense in Depth

| Layer | Measure | Implementation |
|---|---|---|
| **Transport** | HTTPS only (production) | Use reverse proxy (nginx) or `https` module |
| **Headers** | Helmet | `app.use(helmet())` — sets X-Content-Type-Options, X-Frame-Options, etc. |
| **CORS** | Strict origin policy | Only allow your frontend domain |
| **Rate Limiting** | Prevent brute force | 100 req/15min general, 5 req/min on auth & code redeem |
| **SQL Injection** | Parameterized queries | `better-sqlite3` uses `?` placeholders everywhere |
| **XSS** | httpOnly cookies + input sanitization | Never render user input as HTML |
| **CSRF** | SameSite cookies + token | `sameSite: 'strict'` on cookies |
| **File Upload** | Type validation + size limit | Multer fileFilter + 5GB limit |
| **Path Traversal** | No user-controlled paths | All paths built server-side from slug lookups |
| **Code Brute Force** | Rate limit + lockout | 5 failed attempts → 15min IP lockout |
| **Video Leeching** | Signed streaming URLs | Verify device access before serving any video byte |
| **Admin Auth** | bcrypt + JWT + httpOnly cookie | Password hashed with 10 rounds |
| **Device Binding** | SHA-256 fingerprint | Codes locked to one device forever |
| **Environment** | .env secrets | JWT_SECRET, ADMIN_PASSWORD in .env, never committed |

### Rate Limiting Configuration

```javascript
// src/middleware/rateLimiter.js

const rateLimit = require('express-rate-limit');

// General API rate limit
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 100,
    message: { error: 'Too many requests, try again later' }
});

// Strict limit for code redemption (prevent brute force)
const codeRedeemLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 5,
    message: { error: 'Too many code attempts. Try again in 15 minutes.' }
});

// Auth rate limit
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

module.exports = { apiLimiter, codeRedeemLimiter, authLimiter };
```

### Streaming Access Control (Anti-Leeching)

```javascript
// src/controllers/watchController.js — streamVideo

exports.streamVideo = (req, res) => {
    const { slug } = req.params;
    const deviceFingerprint = req.headers['x-device-fp'];

    // 1. Find movie by slug
    const movie = movieModel.findBySlug(slug);
    if (!movie) return res.status(404).json({ error: 'Film not found' });

    // 2. Verify device has access
    if (!deviceFingerprint) {
        return res.status(403).json({ error: 'Device identification required' });
    }

    const deviceHash = crypto.createHash('sha256').update(deviceFingerprint).digest('hex');
    const device = deviceModel.findByFingerprint(deviceHash);

    if (!device) {
        return res.status(403).json({ error: 'Device not recognized' });
    }

    const hasAccess = codeModel.checkAccess(device.id, movie.id, null);
    if (!hasAccess) {
        return res.status(403).json({ error: 'No active code for this film' });
    }

    // 3. Stream the video (with range support)
    streamingService.streamVideo(req, res, movie.video_path);
};
```

### .gitignore

```gitignore
node_modules/
database/*.db
uploads/*
!uploads/.gitkeep
public/posters/*
!public/posters/.gitkeep
logs/
.env
*.log
```

---

## 13. API Endpoints Reference

### Auth Routes (`/api/auth`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | None | Admin login |
| POST | `/api/auth/logout` | Admin | Admin logout |
| GET | `/api/auth/me` | Admin | Get current admin |

### Movie Routes (`/api/movies`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/movies` | Admin | List all films |
| GET | `/api/movies/:slug` | None | Get film info by slug |
| POST | `/api/movies` | Admin | Upload new film (file or URL) |
| PUT | `/api/movies/:id` | Admin | Update film info |
| DELETE | `/api/movies/:id` | Admin | Delete film + file |

### Series Routes (`/api/series`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/series` | Admin | List all series |
| GET | `/api/series/:slug` | None | Get series info + episodes |
| POST | `/api/series` | Admin | Create new series |
| POST | `/api/series/:id/episodes` | Admin | Add episode to series |
| DELETE | `/api/series/:id` | Admin | Delete series |
| DELETE | `/api/series/episodes/:id` | Admin | Delete episode |

### Code Routes (`/api/codes`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/codes/generate` | Admin | Generate codes for film/episode |
| GET | `/api/codes` | Admin | List all codes |
| POST | `/api/codes/redeem` | Device | Redeem a code (binds to device) |
| GET | `/api/codes/check/:movieId` | Device | Check if device has access to film |

### Watch Routes (`/api/watch`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/watch/stream/:slug` | Device | Stream video (range support) |
| POST | `/api/watch/progress` | Device | Save watch progress |
| POST | `/api/watch/progress/get` | Device | Get watch progress |

### Library Routes (`/api/library`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/library` | Device | Get user's unlocked films & episodes |

---

## 14. Environment Variables

### .env.example

```env
# ===== Server =====
PORT=3000
NODE_ENV=development

# ===== Database =====
DB_PATH=./database/cinema.db

# ===== JWT =====
JWT_SECRET=your-super-secret-key-change-this-to-random-64-chars
JWT_EXPIRES_IN=24h

# ===== Admin =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeMe123!

# ===== Upload =====
MAX_UPLOAD_SIZE=5GB
UPLOAD_DIR=./uploads
TEMP_DIR=./uploads/_temp

# ===== Compression =====
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
VIDEO_CRF=23
VIDEO_PRESET=medium
MAX_RESOLUTION=1080

# ===== Security =====
CORS_ORIGIN=http://localhost:3000
RATE_LIMIT_WINDOW=15
RATE_LIMIT_MAX=100
CODE_RATE_LIMIT_MAX=5

# ===== Player =====
PLYR_VERSION=3.7.8
```

---

## 15. Build Order (Step-by-Step)

Build in this order to ensure each layer works before the next depends on it.

### Phase 1: Foundation

- [ ] **1.1** Initialize `backend/` folder, run `npm init`, install all dependencies
- [ ] **1.2** Create `.env` and `.env.example`
- [ ] **1.3** Create `.gitignore`
- [ ] **1.4** Create `src/config/env.js` — load and validate environment variables
- [ ] **1.5** Create `src/config/paths.js` — centralized path constants
- [ ] **1.6** Create `src/config/database.js` — better-sqlite3 connection
- [ ] **1.7** Create `src/db/schema.sql` — run schema creation on startup
- [ ] **1.8** Create `src/db/init.js` — script to initialize DB + seed admin
- [ ] **1.9** Create `src/app.js` — Express app with helmet, cors, morgan, rate limiter
- [ ] **1.10** Create `server.js` — entry point that starts the server

### Phase 2: Admin Auth

- [ ] **2.1** Create `src/models/adminModel.js` — findByUsername, create, update
- [ ] **2.2** Create `src/controllers/authController.js` — login, logout, me
- [ ] **2.3** Create `src/middleware/authMiddleware.js` — JWT verification
- [ ] **2.4** Create `src/routes/authRoutes.js`
- [ ] **2.5** Test: login with default admin, get token, access protected route

### Phase 3: Upload System + Compression

- [ ] **3.1** Create `src/config/multer.js` — disk storage, file filter, size limit
- [ ] **3.2** Create `src/services/storageService.js` — path builder, file manager, URL downloader
- [ ] **3.3** Create `src/services/compressionService.js` — FFmpeg compress + thumbnail + duration
- [ ] **3.4** Create `src/controllers/uploadController.js` — handle file upload → compress → save
- [ ] **3.5** Create `src/routes/uploadRoutes.js`
- [ ] **3.6** Test: upload a video, verify it's compressed and stored in correct folder

### Phase 4: Movies & Series CRUD

- [ ] **4.1** Create `src/models/movieModel.js` — create, findBySlug, findAll, update, delete
- [ ] **4.2** Create `src/models/seriesModel.js` — create, findBySlug, findAll, update, delete
- [ ] **4.3** Create `src/controllers/movieController.js`
- [ ] **4.4** Create `src/controllers/seriesController.js`
- [ ] **4.5** Create `src/routes/movieRoutes.js`
- [ ] **4.6** Create `src/routes/seriesRoutes.js`
- [ ] **4.7** Test: create a film, get by slug, update, delete

### Phase 5: Code System

- [ ] **5.1** Create `src/services/codeService.js` — generate cryptographically secure codes
- [ ] **5.2** Create `src/models/codeModel.js` — create, findByCode, activate, checkAccess
- [ ] **5.3** Create `src/services/deviceService.js` — fingerprint hashing
- [ ] **5.4** Create `src/models/deviceModel.js` — findByFingerprint, create
- [ ] **5.5** Create `src/controllers/codeController.js` — generate, redeem, check
- [ ] **5.6** Create `src/routes/codeRoutes.js`
- [ ] **5.7** Test: generate codes, redeem on a device, verify one-time-one-device rule

### Phase 6: Streaming + Player

- [ ] **6.1** Create `src/services/streamingService.js` — range request video streaming
- [ ] **6.2** Create `src/controllers/watchController.js` — streamVideo with access check
- [ ] **6.3** Create `src/routes/watchRoutes.js`
- [ ] **6.4** Serve Plyr player HTML as a static page with embedded player
- [ ] **6.5** Test: stream video with range requests, seek, fullscreen

### Phase 7: Watch Progress + Library

- [ ] **7.1** Create `src/models/progressModel.js` — upsert, findByDeviceAndContent
- [ ] **7.2** Add progress save/get endpoints to `watchController.js`
- [ ] **7.3** Create `src/controllers/libraryController.js` — get unlocked films
- [ ] **7.4** Create `src/routes/libraryRoutes.js`
- [ ] **7.5** Test: save progress, resume, check library shows only unlocked films

### Phase 8: Security Hardening

- [ ] **8.1** Apply rate limiters to all sensitive routes
- [ ] **8.2** Add input validation with express-validator on all POST/PUT routes
- [ ] **8.3** Add `src/middleware/errorHandler.js` — centralized error handling
- [ ] **8.4** Verify all database queries use parameterized statements
- [ ] **8.5** Verify streaming endpoint checks device access before serving bytes
- [ ] **8.6** Test: attempt brute force code entry, verify lockout works

### Phase 9: Frontend Pages (Simple UI)

- [ ] **9.1** Film page — poster, info, code input, hidden player
- [ ] **9.2** Series page — series info, episode list (locked/unlocked states)
- [ ] **9.3** Library page — grid of unlocked films with posters
- [ ] **9.4** Admin panel — upload form, code generation, content management
- [ ] **9.5** Device fingerprint generation script (runs on all pages)

---

## Quick Start Commands

```powershell
# 1. Create the backend folder
mkdir backend
cd backend

# 2. Initialize and install
npm init -y
npm install express better-sqlite3 cors helmet morgan dotenv express-rate-limit express-validator jsonwebtoken bcryptjs cookie-parser multer fluent-ffmpeg axios fs-extra slugify
npm install --save-dev nodemon jest

# 3. Install FFmpeg (Windows)
winget install Gyan.FFmpeg

# 4. Create .env from template
cp .env.example .env
# Edit .env with your secrets

# 5. Initialize database
npm run init-db

# 6. Start dev server
npm run dev
```

---

## Key Design Decisions Summary

| Decision | Choice | Rationale |
|---|---|---|
| Database | SQLite (better-sqlite3) | Zero config, file-based, fast for single-server, no external DB needed |
| Video compression | FFmpeg CRF 23 | Best quality/size ratio, universally compatible H.264 |
| Player | Plyr 3.x | Modern, lightweight (30KB), customizable, zero-config, actively maintained |
| Auth | JWT in httpOnly cookie | XSS-safe, stateless, works with API + server-rendered pages |
| Code format | CHX-XXXX-XXXX | Cryptographically random, no ambiguous characters, easy to type |
| Device ID | SHA-256 of browser fingerprint | Persistent, privacy-preserving (only hash stored), hard to spoof |
| Streaming | HTTP Range requests | Native browser support, no special server needed, seek works |
| Progress save | Every 10s + on pause/exit | Balances server load with resume accuracy |

---

*This document is the single source of truth for the CinemaChatrix backend. Follow the build order in Phase 1-9 to implement step by step.*
