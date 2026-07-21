#!/usr/bin/env node
/**
 * HLS stream tester — checks whether an .m3u8 link is actually playable
 * from *this* machine (e.g. your VPS), not just reachable.
 *
 * What it does, in order:
 *   1. Fetches the playlist you give it.
 *   2. If it's a MASTER playlist (quality variants), picks the best one and
 *      fetches that media playlist.
 *   3. Parses the MEDIA playlist for segments (.ts/.m4s) and any AES-128 key.
 *   4. Downloads the first few segments to prove the CDN really serves bytes
 *      (this is what actually decides "can it be watched").
 *   5. Prints a clear PASS / FAIL verdict with status codes, timings and
 *      throughput.
 *
 * Zero dependencies — uses only Node's built-in modules, so you can copy this
 * single file to any VPS and run it with `node test-hls.js` (no npm install).
 *
 * Usage:
 *   node test-hls.js "<m3u8-url>"
 *   node test-hls.js "<url>" --segments 3 --timeout 15000
 *   node test-hls.js "<url>" --referer https://uqload.is/ --insecure
 *
 * Options:
 *   --segments <n>    How many leading segments to download   (default 2)
 *   --timeout <ms>    Per-request timeout in milliseconds      (default 15000)
 *   --max-bytes <n>   Cap bytes downloaded per segment         (default 1500000)
 *   --referer <url>   Send a Referer header (some CDNs need it)
 *   --user-agent <s>  Override the User-Agent
 *   --insecure        Ignore TLS certificate errors
 *
 * Exit code is 0 on PASS and 1 on FAIL — handy for cron / uptime checks.
 */

'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

// Runs with no arguments against this link. Pass your own URL to override.
const DEFAULT_URL =
    'https://strm10.uqload.is/hls2/04/05260/0zhqaaas6wc5_l/index-v1-a1.m3u8?t=IsPlRsAefYjXf-xtwFY9Hp1rRhlOPiNldri2lmQiBbg&s=1784621009&e=43200&v=902680&i=0.3&sp=0';

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/*  Tiny formatting helpers                                            */
/* ------------------------------------------------------------------ */

function humanBytes(n) {
    if (!Number.isFinite(n)) return '?';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function throughput(bytes, ms) {
    if (!ms) return '?';
    const bitsPerSec = (bytes * 8) / (ms / 1000);
    return `${(bitsPerSec / 1e6).toFixed(2)} Mbps`;
}

const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};
const ok = (s) => `${c.green}${s}${c.reset}`;
const bad = (s) => `${c.red}${s}${c.reset}`;
const warn = (s) => `${c.yellow}${s}${c.reset}`;
const info = (s) => `${c.cyan}${s}${c.reset}`;

/* ------------------------------------------------------------------ */
/*  HTTP(S) request with redirects, decompression and byte cap        */
/* ------------------------------------------------------------------ */

/**
 * Perform a GET and buffer the response body (optionally capped).
 * Follows redirects, transparently decompresses gzip/deflate/br.
 *
 * @returns {Promise<{status:number, headers:object, body:Buffer, bytes:number,
 *   finalUrl:string, ms:number, truncated:boolean}>}
 */
function request(rawUrl, opts = {}) {
    const {
        headers = {},
        timeout = 15000,
        maxRedirects = 5,
        maxBytes = Infinity,
        insecure = false,
    } = opts;

    return new Promise((resolve, reject) => {
        let redirects = 0;
        const started = Date.now();
        let done = false;
        const settle = (v) => {
            if (!done) {
                done = true;
                resolve(v);
            }
        };
        const fail = (e) => {
            if (!done) {
                done = true;
                reject(e);
            }
        };

        const doRequest = (urlStr) => {
            let u;
            try {
                u = new URL(urlStr);
            } catch {
                return fail(new Error(`Invalid URL: ${urlStr}`));
            }

            const lib = u.protocol === 'http:' ? http : https;
            const reqHeaders = {
                'User-Agent': DEFAULT_UA,
                Accept: '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                Connection: 'keep-alive',
                ...headers,
            };

            const req = lib.request(
                u,
                { method: 'GET', headers: reqHeaders, rejectUnauthorized: !insecure },
                (res) => {
                    const status = res.statusCode;

                    // Follow redirects.
                    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                        res.resume();
                        if (redirects++ >= maxRedirects) {
                            return fail(new Error(`Too many redirects (>${maxRedirects})`));
                        }
                        return doRequest(new URL(res.headers.location, u).toString());
                    }

                    // Transparently decompress.
                    let stream = res;
                    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
                    if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
                    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
                    else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

                    const chunks = [];
                    let bytes = 0;
                    let truncated = false;

                    stream.on('data', (chunk) => {
                        if (truncated) return;
                        bytes += chunk.length;
                        chunks.push(chunk);
                        if (bytes >= maxBytes) {
                            truncated = true;
                            settle({
                                status,
                                headers: res.headers,
                                body: Buffer.concat(chunks),
                                bytes,
                                finalUrl: u.toString(),
                                ms: Date.now() - started,
                                truncated: true,
                            });
                            req.destroy(); // stop pulling bytes we don't need
                        }
                    });
                    stream.on('end', () =>
                        settle({
                            status,
                            headers: res.headers,
                            body: Buffer.concat(chunks),
                            bytes,
                            finalUrl: u.toString(),
                            ms: Date.now() - started,
                            truncated: false,
                        })
                    );
                    stream.on('error', (err) => fail(err));
                }
            );

            req.on('error', (err) => fail(err));
            req.setTimeout(timeout, () => {
                req.destroy(new Error(`Request timed out after ${timeout} ms`));
            });
            req.end();
        };

        doRequest(rawUrl);
    });
}

/* ------------------------------------------------------------------ */
/*  M3U8 parsing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Parse an HLS attribute list, respecting quoted values that contain commas
 * (e.g. CODECS="avc1.4d401f,mp4a.40.2").
 */
function parseAttrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
        let v = m[2];
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        out[m[1]] = v;
    }
    return out;
}

/**
 * Split a playlist into what we care about: variants (master), segments
 * (media), and an optional encryption key.
 */
function parsePlaylist(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const isHls = lines.some((l) => l.startsWith('#EXTM3U'));

    const variants = []; // { bandwidth, resolution, codecs, uri }
    const segments = []; // uri strings
    let key = null; // { method, uri, iv }
    let targetDuration = null;
    let pendingVariant = null;

    for (const line of lines) {
        if (!line) continue;

        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const a = parseAttrs(line.slice(line.indexOf(':') + 1));
            pendingVariant = {
                bandwidth: Number(a.BANDWIDTH) || Number(a['AVERAGE-BANDWIDTH']) || 0,
                resolution: a.RESOLUTION || null,
                codecs: a.CODECS || null,
            };
        } else if (line.startsWith('#EXT-X-KEY:')) {
            const a = parseAttrs(line.slice(line.indexOf(':') + 1));
            if (a.METHOD && a.METHOD !== 'NONE') {
                key = { method: a.METHOD, uri: a.URI || null, iv: a.IV || null };
            }
        } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = Number(line.split(':')[1]) || null;
        } else if (!line.startsWith('#')) {
            // A bare URI line: either a variant target or a media segment.
            if (pendingVariant) {
                variants.push({ ...pendingVariant, uri: line });
                pendingVariant = null;
            } else {
                segments.push(line);
            }
        }
    }

    return { isHls, variants, segments, key, targetDuration };
}

/** Resolve a possibly-relative playlist/segment URI against its playlist URL. */
function resolveUrl(uri, baseUrl) {
    return new URL(uri, baseUrl).toString();
}

/* ------------------------------------------------------------------ */
/*  CLI parsing                                                        */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
    const out = {
        url: DEFAULT_URL,
        segments: 2,
        timeout: 15000,
        maxBytes: 1_500_000,
        referer: null,
        userAgent: null,
        insecure: false,
    };
    const rest = argv.slice(2);
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--segments') out.segments = Number(rest[++i]) || out.segments;
        else if (a === '--timeout') out.timeout = Number(rest[++i]) || out.timeout;
        else if (a === '--max-bytes') out.maxBytes = Number(rest[++i]) || out.maxBytes;
        else if (a === '--referer') out.referer = rest[++i];
        else if (a === '--user-agent') out.userAgent = rest[++i];
        else if (a === '--insecure') out.insecure = true;
        else if (!a.startsWith('--')) out.url = a; // first bare arg = the URL
    }
    return out;
}

/* ------------------------------------------------------------------ */
/*  Reporting helpers                                                  */
/* ------------------------------------------------------------------ */

function printResponseMeta(res) {
    const h = res.headers;
    const pick = ['content-type', 'content-length', 'server', 'via', 'x-cache', 'access-control-allow-origin'];
    for (const k of pick) {
        if (h[k]) console.log(`    ${c.dim}${k}:${c.reset} ${h[k]}`);
    }
}

function hintForStatus(status) {
    if (status === 403 || status === 401) {
        return 'Access denied. The token in the URL (t=/s=/e=) is time-limited and has likely expired, or the CDN requires a matching Referer. Try re-copying a fresh link, or add --referer <embed-page-url>.';
    }
    if (status === 410) return 'Gone. The signed link has expired — grab a fresh one.';
    if (status === 404) return 'Not found. The playlist path is wrong or was removed.';
    if (status === 429) return 'Rate limited by the CDN. Wait and retry.';
    if (status >= 500) return 'Server-side error at the CDN. Not something on your VPS.';
    return null;
}

/* ------------------------------------------------------------------ */
/*  Main flow                                                          */
/* ------------------------------------------------------------------ */

async function main() {
    const args = parseArgs(process.argv);

    const baseHeaders = {};
    if (args.referer) {
        baseHeaders.Referer = args.referer;
        try {
            baseHeaders.Origin = new URL(args.referer).origin;
        } catch {
            /* ignore bad referer */
        }
    }
    if (args.userAgent) baseHeaders['User-Agent'] = args.userAgent;

    const reqOpts = {
        headers: baseHeaders,
        timeout: args.timeout,
        insecure: args.insecure,
    };

    console.log(`${c.bold}HLS stream test${c.reset}`);
    console.log(`${c.dim}${new Date().toISOString()}${c.reset}`);
    console.log(`URL: ${args.url}\n`);

    /* -- Step 1: fetch the playlist the user gave us ---------------- */
    console.log(`${c.bold}[1/3] Fetching playlist...${c.reset}`);
    let playlistRes;
    try {
        playlistRes = await request(args.url, reqOpts);
    } catch (err) {
        console.log(bad(`  ✗ Could not connect: ${err.message}`));
        console.log(
            warn(
                '  This is a network/DNS/TLS problem on this machine — the CDN was never reached.'
            )
        );
        return finish(false);
    }

    console.log(`  status: ${playlistRes.status} · ${playlistRes.ms} ms`);
    printResponseMeta(playlistRes);

    if (playlistRes.status !== 200) {
        console.log(bad(`  ✗ Playlist request failed (HTTP ${playlistRes.status}).`));
        const hint = hintForStatus(playlistRes.status);
        if (hint) console.log(warn(`  → ${hint}`));
        return finish(false);
    }

    const text = playlistRes.body.toString('utf8');
    let parsed = parsePlaylist(text);
    if (!parsed.isHls) {
        console.log(bad('  ✗ Response is not an HLS playlist (missing #EXTM3U).'));
        console.log(`${c.dim}  First bytes: ${JSON.stringify(text.slice(0, 120))}${c.reset}`);
        return finish(false);
    }
    console.log(ok('  ✓ Valid HLS playlist.'));

    /* -- Step 2: resolve master -> media playlist ------------------- */
    let mediaUrl = playlistRes.finalUrl;

    if (parsed.variants.length && !parsed.segments.length) {
        // Master playlist: pick the highest-bandwidth variant.
        const best = parsed.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
        console.log(`\n${c.bold}[2/3] Master playlist — ${parsed.variants.length} variant(s):${c.reset}`);
        for (const v of parsed.variants) {
            const tag = v === best ? info(' (selected)') : '';
            console.log(
                `    ${v.resolution || '?'} · ${(v.bandwidth / 1e6).toFixed(2)} Mbps · ${v.codecs || '?'}${tag}`
            );
        }

        mediaUrl = resolveUrl(best.uri, playlistRes.finalUrl);
        let mediaRes;
        try {
            mediaRes = await request(mediaUrl, reqOpts);
        } catch (err) {
            console.log(bad(`  ✗ Could not fetch the selected variant: ${err.message}`));
            return finish(false);
        }
        if (mediaRes.status !== 200) {
            console.log(bad(`  ✗ Variant playlist failed (HTTP ${mediaRes.status}).`));
            const hint = hintForStatus(mediaRes.status);
            if (hint) console.log(warn(`  → ${hint}`));
            return finish(false);
        }
        parsed = parsePlaylist(mediaRes.body.toString('utf8'));
    } else {
        console.log(`\n${c.bold}[2/3] Media playlist (direct, no variants).${c.reset}`);
    }

    if (parsed.key) {
        console.log(
            warn(
                `  • Encrypted stream: METHOD=${parsed.key.method}` +
                    (parsed.key.uri ? ` (key present)` : '')
            )
        );
        console.log(
            `${c.dim}    That's fine — real players decrypt AES-128 automatically. It won't play as a raw file download.${c.reset}`
        );
    }

    if (!parsed.segments.length) {
        console.log(bad('  ✗ No media segments found in the playlist — nothing to play.'));
        return finish(false);
    }
    console.log(
        ok(`  ✓ ${parsed.segments.length} segment(s) listed`) +
            (parsed.targetDuration ? ` · ~${parsed.targetDuration}s each` : '')
    );

    /* -- Step 3: actually download the first few segments ----------- */
    const count = Math.min(args.segments, parsed.segments.length);
    console.log(`\n${c.bold}[3/3] Downloading first ${count} segment(s)...${c.reset}`);

    let totalBytes = 0;
    let totalMs = 0;
    let anyFailed = false;

    for (let i = 0; i < count; i++) {
        const segUrl = resolveUrl(parsed.segments[i], mediaUrl);
        try {
            const segRes = await request(segUrl, {
                ...reqOpts,
                maxBytes: args.maxBytes,
                headers: { ...baseHeaders, Range: `bytes=0-${args.maxBytes - 1}` },
            });

            const good = (segRes.status === 200 || segRes.status === 206) && segRes.bytes > 0;
            totalBytes += segRes.bytes;
            totalMs += segRes.ms;

            const label = `  segment #${i + 1}: HTTP ${segRes.status}`;
            if (good) {
                console.log(
                    `${label} · ${humanBytes(segRes.bytes)}${segRes.truncated ? '+' : ''} · ` +
                        `${segRes.ms} ms · ${throughput(segRes.bytes, segRes.ms)} ${ok('✓')}`
                );
            } else {
                anyFailed = true;
                console.log(`${label} · ${humanBytes(segRes.bytes)} ${bad('✗')}`);
                const hint = hintForStatus(segRes.status);
                if (hint) console.log(warn(`    → ${hint}`));
            }
        } catch (err) {
            anyFailed = true;
            console.log(`  segment #${i + 1}: ${bad(`✗ ${err.message}`)}`);
        }
    }

    /* -- Verdict ---------------------------------------------------- */
    const passed = totalBytes > 0 && !anyFailed;
    console.log('');
    if (passed) {
        console.log(
            ok(`${c.bold}PASS${c.reset}`) +
                ` — stream is reachable and serving video from this machine.`
        );
        console.log(
            `${c.dim}Pulled ${humanBytes(totalBytes)} in ${totalMs} ms ` +
                `(avg ${throughput(totalBytes, totalMs)}).${c.reset}`
        );
    } else if (totalBytes > 0) {
        console.log(
            warn(`${c.bold}PARTIAL${c.reset}`) +
                ` — playlist works but at least one segment failed. Playback may stutter.`
        );
    } else {
        console.log(bad(`${c.bold}FAIL${c.reset}`) + ` — could not download any video data.`);
    }

    return finish(passed);
}

function finish(passed) {
    process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
    console.error(bad(`Unexpected error: ${err.stack || err.message}`));
    process.exitCode = 1;
});
