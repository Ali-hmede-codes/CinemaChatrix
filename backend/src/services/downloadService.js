/**
 * Download service — high-throughput segmented file downloader.
 *
 * Why this exists: many file hosts / CDNs throttle the SPEED OF EACH
 * CONNECTION (krakencloud, DoodStream-style hosts, ...). A single stream then
 * crawls no matter how fast your line is. The trick download managers (IDM,
 * aria2c) use is to open many connections at once AND keep every one of them
 * busy for the whole transfer, so the aggregate speed saturates the real link
 * ("full wifi speed") instead of one throttled socket.
 *
 * This module does that with a WORK-QUEUE, not fixed chunks:
 *   - the file is cut into many small equal segments (a queue),
 *   - a pool of N workers each pull the NEXT free segment, download its byte
 *     range, write it at its offset, then immediately grab another.
 * Because finished workers keep pulling new work, there is no "straggler tail"
 * where fast connections idle while one slow chunk finishes — which is exactly
 * what capped the old fixed-split downloader near the end of every transfer.
 *
 * Each segment has its own small retry budget, so one transient blip can't
 * throw away a multi-GB download. Callers pass an already-validated final URL —
 * redirect following and the SSRF / anti-sinkhole checks live in storageService.
 */

const axios = require('axios');
const fs = require('fs-extra');

// Larger write buffer → fewer syscalls → better throughput on big files.
const WRITE_BUFFER = 1024 * 1024;

/**
 * Download a file over a pool of parallel HTTP range requests fed by a shared
 * work-queue. Every connection stays busy until the whole file is fetched.
 *
 * @param {object} args
 * @param {string} args.url          - final, already-validated URL
 * @param {string} args.destPath     - absolute destination path
 * @param {object} args.headers      - request headers (UA / Referer / ...)
 * @param {number} args.totalSize    - full file size in bytes (must be known)
 * @param {number} args.connections  - how many requests to run at once
 * @param {number} args.chunkSize    - work-queue segment size in bytes
 * @param {number} args.timeoutMs    - per-request stall timeout
 * @param {number} [args.maxRetries=4] - retry attempts per segment
 * @returns {Promise<void>}
 */
async function downloadSegmented({
    url,
    destPath,
    headers,
    totalSize,
    connections,
    chunkSize,
    timeoutMs,
    maxRetries = 4,
}) {
    // Pre-size the file so every worker can write straight to its byte offset.
    await fs.ensureFile(destPath);
    await fs.truncate(destPath, totalSize);

    // Build the work-queue: many small [start, end] segments.
    const segments = [];
    for (let start = 0; start < totalSize; start += chunkSize) {
        segments.push({ start, end: Math.min(start + chunkSize - 1, totalSize - 1) });
    }

    let cursor = 0; // index of the next segment to hand out
    let aborted = null; // first fatal error, if any

    const worker = async () => {
        while (cursor < segments.length && !aborted) {
            const segment = segments[cursor++];
            try {
                await fetchSegmentWithRetry(url, destPath, headers, segment, timeoutMs, maxRetries);
            } catch (err) {
                aborted = aborted || err; // record it; let peers wind down
                return;
            }
        }
    };

    const poolSize = Math.min(connections, segments.length);
    await Promise.all(Array.from({ length: poolSize }, worker));

    if (aborted) throw aborted;
}

/**
 * Fetch one byte range with a small retry budget. A transient network/CDN blip
 * on a single segment shouldn't abort a multi-GB download, so we retry that
 * segment a few times with a short backoff before giving up.
 * @returns {Promise<void>}
 */
async function fetchSegmentWithRetry(url, destPath, headers, segment, timeoutMs, maxRetries) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await fetchSegment(url, destPath, headers, segment, timeoutMs);
            return;
        } catch (err) {
            lastErr = err;
            if (attempt < maxRetries) {
                await delay(Math.min(500 * (attempt + 1), 2000));
            }
        }
    }
    throw lastErr;
}

/**
 * Fetch a single byte range and write it at its offset in the destination.
 * Rejects unless the server answers 206 Partial Content — a plain 200 means it
 * ignored the Range and is streaming the whole file, which must not be spliced
 * into one region of the output.
 * @param {string} url
 * @param {string} destPath
 * @param {object} headers
 * @param {{start:number, end:number}} range
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function fetchSegment(url, destPath, headers, { start, end }, timeoutMs) {
    return new Promise((resolve, reject) => {
        axios({
            method: 'GET',
            url,
            responseType: 'stream',
            timeout: timeoutMs,
            maxRedirects: 0,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: { ...headers, Range: `bytes=${start}-${end}` },
            validateStatus: () => true,
        })
            .then((response) => {
                if (response.status !== 206) {
                    response.data.destroy();
                    reject(new Error(`range request returned HTTP ${response.status}`));
                    return;
                }
                // 'r+' writes at the offset without truncating the other parts.
                const writer = fs.createWriteStream(destPath, {
                    flags: 'r+',
                    start,
                    highWaterMark: WRITE_BUFFER,
                });
                const fail = (err) => {
                    response.data.destroy();
                    writer.destroy();
                    reject(err);
                };
                writer.on('finish', resolve);
                writer.on('error', fail);
                response.data.on('error', fail);
                response.data.pipe(writer);
            })
            .catch(reject);
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    downloadSegmented,
};
