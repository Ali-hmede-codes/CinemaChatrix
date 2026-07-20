/**
 * Multer upload configuration.
 *
 * Stores incoming files in uploads/_temp with a unique name. The upload
 * controller then compresses (if FFmpeg is available) and moves the file
 * to its final structured path.
 *
 * Two named fields are accepted:
 *   - "video"  → the film/episode video (video mimetypes only)
 *   - "poster" → an optional poster image (image mimetypes only)
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { DIRS } = require('./paths');

/* ------------------------------------------------------------------ */
/*  Storage                                                            */
/* ------------------------------------------------------------------ */

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.ensureDirSync(DIRS.uploadsTemp);
        cb(null, DIRS.uploadsTemp);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    },
});

/* ------------------------------------------------------------------ */
/*  Filter                                                             */
/* ------------------------------------------------------------------ */

const VIDEO_TYPES = [
    'video/mp4',
    'video/x-matroska',   // .mkv
    'video/avi',
    'video/x-msvideo',    // .avi
    'video/quicktime',    // .mov
    'video/webm',
];

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const fileFilter = (req, file, cb) => {
    if (file.fieldname === 'video') {
        if (VIDEO_TYPES.includes(file.mimetype)) return cb(null, true);
        return cb(new Error('Invalid video type. Allowed: mp4, mkv, avi, mov, webm.'), false);
    }
    if (file.fieldname === 'poster') {
        if (IMAGE_TYPES.includes(file.mimetype)) return cb(null, true);
        return cb(new Error('Invalid poster type. Allowed: jpg, png, webp.'), false);
    }
    return cb(new Error(`Unexpected upload field: ${file.fieldname}`), false);
};

/* ------------------------------------------------------------------ */
/*  Export configured multer instance                                  */
/* ------------------------------------------------------------------ */

module.exports = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 * 1024, // 5 GB (before compression)
    },
});
