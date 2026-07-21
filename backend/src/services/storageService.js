/**
 * Storage service — low-level file operations.
 *
 * Handles moving files from the temp directory to their final location,
 * downloading videos/posters from a URL, reading file sizes, and safely
 * deleting files. Path building lives in config/paths.js; this service
 * only performs the filesystem work.
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Download from URL                                                  */
/* ------------------------------------------------------------------ */

/**
 * Stream a remote file to disk.
 * @param {string} url
 * @param {string} destPath - absolute destination path
 * @returns {Promise<string>} destPath
 */
async function downloadFromUrl(url, destPath) {
    await fs.ensureDir(path.dirname(destPath));

    const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        timeout: 300000, // 5 min idle timeout (fires only when the socket stalls)
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    // Larger buffer → fewer syscalls → better throughput on big files.
    const writer = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 });
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        const fail = (err) => {
            response.data.destroy();
            writer.destroy();
            fs.remove(destPath).catch(() => {}); // drop the partial file
            reject(err);
        };
        writer.on('finish', () => resolve(destPath));
        writer.on('error', fail);
        response.data.on('error', fail);
    });
}

/* ------------------------------------------------------------------ */
/*  File operations                                                    */
/* ------------------------------------------------------------------ */

/**
 * Move a file to a destination (creates parent dirs, overwrites).
 * @param {string} src - absolute source path
 * @param {string} dest - absolute destination path
 * @returns {Promise<string>} dest
 */
async function moveFile(src, dest) {
    await fs.ensureDir(require('path').dirname(dest));
    await fs.move(src, dest, { overwrite: true });
    return dest;
}

/**
 * Return file size in bytes (0 if missing).
 * @param {string} absPath
 * @returns {number}
 */
function getFileSize(absPath) {
    try {
        return fs.statSync(absPath).size;
    } catch {
        return 0;
    }
}

/**
 * Safely remove a file — never throws.
 * @param {string} absPath
 */
async function remove(absPath) {
    if (!absPath) return;
    try {
        await fs.remove(absPath);
    } catch (err) {
        logger.warn(`[storage] Failed to remove ${absPath}: ${err.message}`);
    }
}

/**
 * Remove the parent directory of a file if it is now empty — never throws.
 * Used after deleting a video so the auto-created per-title folder doesn't
 * linger empty. @param {string} fileAbsPath
 */
async function removeEmptyDir(fileAbsPath) {
    if (!fileAbsPath) return;
    try {
        const dir = path.dirname(fileAbsPath);
        const entries = await fs.readdir(dir);
        if (entries.length === 0) {
            await fs.rmdir(dir);
        }
    } catch {
        /* directory missing or not empty — ignore */
    }
}

module.exports = {
    downloadFromUrl,
    moveFile,
    getFileSize,
    remove,
    removeEmptyDir,
};
