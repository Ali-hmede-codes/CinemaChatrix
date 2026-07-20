/**
 * Streaming service — serves a video file over HTTP with Range support.
 *
 * Range requests are what let the browser seek and start playback before the
 * whole file is downloaded. The caller is responsible for verifying the device
 * has access BEFORE invoking this — see watchController. This function only
 * ever receives a server-resolved absolute path, never anything user-supplied.
 */

const fs = require('fs');
const path = require('path');

const MIME_BY_EXT = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.ts': 'video/mp2t',
};

function contentType(filePath) {
    return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Stream `filePath` to the response, honouring a Range header when present.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} filePath - absolute path to the video on disk
 */
function streamFile(req, res, filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).json({ success: false, error: 'Video file not found' });
        return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const type = contentType(filePath);
    const range = req.headers.range;

    if (range) {
        // e.g. "bytes=32324-" or "bytes=32324-99999"
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        let start = match && match[1] ? parseInt(match[1], 10) : 0;
        let end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;

        // Clamp to a valid window; reject nonsense ranges.
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;
        if (start > end || start >= fileSize) {
            res.writeHead(416, {
                'Content-Range': `bytes */${fileSize}`,
            });
            return res.end();
        }

        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': type,
            'Cache-Control': 'private, no-store',
        });
        stream.on('error', () => res.end());
        stream.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': type,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-store',
        });
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => res.end());
        stream.pipe(res);
    }
}

module.exports = { streamFile };
