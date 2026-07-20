/**
 * Watch routes — /api/watch  (device-bound playback)
 *
 *   POST /api/watch/authorize      → short-lived stream ticket (after access check)
 *   GET  /api/watch/stream/:type/:slug?token=...   → byte-range video stream
 *   POST /api/watch/progress       → save resume position
 *   POST /api/watch/progress/get   → read resume position
 *
 * `type` is 'film' or 'episode'. The stream endpoint is guarded by the signed
 * ticket issued by /authorize — never by anything the client stores itself.
 */

const express = require('express');
const watchController = require('../controllers/watchController');

const router = express.Router();

router.post('/authorize', watchController.authorize);
router.get('/stream/:type/:slug', watchController.stream);
router.post('/progress', watchController.saveProgress);
router.post('/progress/get', watchController.getProgress);

module.exports = router;
