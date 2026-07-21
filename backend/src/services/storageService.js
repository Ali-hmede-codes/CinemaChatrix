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
const dns = require('dns').promises;
const net = require('net');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  Download from URL                                                  */
/* ------------------------------------------------------------------ */

// Pose as a real browser — many CDNs reject the default "axios/x.y.z" agent.
const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_REDIRECTS = 5;

/**
 * True for loopback / private / link-local / unspecified addresses. Used to
 * refuse redirects that point "inward" — both as SSRF protection and to catch
 * anti-download sinkholes (DoodStream-style links redirect their final host to
 * 127.0.0.1 so servers can't fetch the file).
 * @param {string|null} ip
 * @returns {boolean}
 */
function isBlockedAddress(ip) {
    if (!ip) return true;
    if (net.isIPv4(ip)) {
        const o = ip.split('.').map(Number);
        if (o[0] === 0 || o[0] === 127) return true;                 // unspecified / loopback
        if (o[0] === 10) return true;                                // 10.0.0.0/8
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;   // 172.16.0.0/12
        if (o[0] === 192 && o[1] === 168) return true;               // 192.168.0.0/16
        if (o[0] === 169 && o[1] === 254) return true;               // 169.254.0.0/16
        return false;
    }
    const v = ip.toLowerCase();
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/** Build a 422, user-safe error (its message is shown even in production). */
function importError(message) {
    const e = new Error(message);
    e.expose = true;
    e.status = 422;
    return e;
}

/**
 * Stream a remote file to disk.
 *
 * Redirects are followed manually so every hop can be validated: we reject any
 * hop that resolves to a private/localhost IP (anti-download sinkhole / SSRF)
 * and any final response that isn't a real file (e.g. an HTML error page).
 *
 * @param {string} url
 * @param {string} destPath - absolute destination path
 * @param {object} [opts]
 * @param {string} [opts.referer]   - Referer to send (Origin is derived from it)
 * @param {string} [opts.userAgent] - override the User-Agent
 * @returns {Promise<string>} destPath
 */
async function downloadFromUrl(url, destPath, opts = {}) {
    await fs.ensureDir(path.dirname(destPath));

    const headers = {
        'User-Agent': opts.userAgent || BROWSER_UA,
        Accept: '*/*',
    };
    if (opts.referer) {
        headers.Referer = opts.referer;
        try {
            headers.Origin = new URL(opts.referer).origin;
        } catch {
            /* ignore a malformed referer */
        }
    }

    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const host = new URL(currentUrl).hostname;

        // Guard: never connect to an inward-pointing address.
        const resolved = await dns.lookup(host).catch(() => ({ address: null }));
        if (isBlockedAddress(resolved.address)) {
            throw importError(
                `Refusing to download from "${host}" — it resolves to a private/localhost ` +
                `address (${resolved.address}). This host uses anti-download protection ` +
                "(common with DoodStream-style links), so it can't be fetched server-side. " +
                'Download it in a browser and upload the file instead.'
            );
        }

        const response = await axios({
            method: 'GET',
            url: currentUrl,
            responseType: 'stream',
            timeout: 300000, // fires only when the socket stalls
            maxRedirects: 0, // we follow manually to validate each hop
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers,
            validateStatus: () => true,
        });

        // Follow a redirect (validated on the next loop iteration).
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
            response.data.destroy();
            currentUrl = new URL(response.headers.location, currentUrl).toString();
            continue;
        }

        if (response.status < 200 || response.status >= 300) {
            response.data.destroy();
            throw importError(
                `Download failed: HTTP ${response.status} from ${host}. ` +
                'The link may have expired or be access-restricted.'
            );
        }

        // A video source must not hand us an HTML page.
        const ctype = String(response.headers['content-type'] || '').toLowerCase();
        if (ctype.startsWith('text/html')) {
            response.data.destroy();
            throw importError(
                `The link returned an HTML page, not a video file (content-type: ${ctype}). ` +
                'It probably needs a login/click-through or has expired.'
            );
        }

        // Larger buffer → fewer syscalls → better throughput on big files.
        const writer = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 });
        response.data.pipe(writer);

        return await new Promise((resolve, reject) => {
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

    throw importError(`Too many redirects (>${MAX_REDIRECTS}) while downloading.`);
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
