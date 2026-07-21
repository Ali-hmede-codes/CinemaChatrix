/**
 * PM2 process configuration — CinemaChatrix backend.
 *
 * Tuned for a server with 8 vCPUs and 24 GB RAM.
 *
 *   - Cluster mode across every CPU core → uses all 8 vCPUs and load-balances
 *     incoming connections (ideal for many concurrent video streams).
 *   - SQLite runs in WAL mode (see src/config/database.js), which safely
 *     supports multiple worker processes: concurrent readers + a serialized
 *     writer with a 5s busy timeout. No shared-nothing state lives in memory.
 *   - Memory ceilings are generous but deliberately leave a large slice of RAM
 *     free for the OS page cache — that cache is what actually accelerates
 *     repeated video reads off disk.
 *
 * Start (production):    npm run pm2:start
 * Zero-downtime reload:  npm run pm2:reload
 * Stop / remove:         npm run pm2:stop   /  npm run pm2:delete
 * Logs / status / live:  npm run pm2:logs   /  npm run pm2:status  /  npm run pm2:monit
 *
 * IMPORTANT: `npm run pm2:start` runs the DB init once BEFORE the cluster boots
 * so schema migrations happen in a single process (avoids 8 workers racing to
 * migrate the same tables on first upgrade).
 */

// Worker count. Defaults to one process per CPU core ('max' → 8 on an 8-vCPU
// box). Set WEB_CONCURRENCY to leave headroom for FFmpeg compression during
// admin uploads/imports, e.g. WEB_CONCURRENCY=6.
const instances = process.env.WEB_CONCURRENCY
    ? parseInt(process.env.WEB_CONCURRENCY, 10)
    : 'max';

module.exports = {
    apps: [
        {
            name: 'cinemachatrix',
            script: 'server.js',
            cwd: __dirname,

            /* ---- Cluster: use all vCPUs, load-balanced ---- */
            exec_mode: 'cluster',
            instances,

            /* ---- Memory (24 GB box) ----
             * Per-worker V8 heap capped at 1.5 GB; PM2 restarts a worker if its
             * resident memory passes 2 GB (a safety valve against leaks).
             * 8 workers × 2 GB = 16 GB ceiling, leaving ~8 GB for the OS page
             * cache + FFmpeg. In practice each worker sits well under 300 MB. */
            node_args: '--max-old-space-size=1536',
            max_memory_restart: '2G',

            /* ---- Restart policy ---- */
            autorestart: true,
            min_uptime: '30s',
            max_restarts: 10,
            exp_backoff_restart_delay: 200,

            /* ---- Graceful shutdown ----
             * server.js traps SIGINT/SIGTERM, closes the HTTP server + SQLite,
             * and self-exits within 10s. Give PM2 slightly more than that before
             * it force-kills, so in-flight requests finish cleanly on reload. */
            kill_timeout: 11000,
            listen_timeout: 10000,

            /* ---- Environment ----
             * NODE_ENV=production enables the hardened error handler and the
             * production Content-Security-Policy (see src/app.js). dotenv does
             * not override these, so PM2's values win over backend/.env. */
            env: {
                NODE_ENV: 'production',
                PORT: 3001,
            },
            env_production: {
                NODE_ENV: 'production',
                PORT: 3001,
            },

            /* ---- Logs (written under backend/logs) ----
             * merge_logs keeps all cluster workers in a single file each rather
             * than one file per worker id. Winston still writes app.log/error.log
             * separately (see src/utils/logger.js). */
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            out_file: './logs/pm2-out.log',
            error_file: './logs/pm2-error.log',
        },
    ],
};
