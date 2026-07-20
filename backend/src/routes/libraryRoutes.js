/**
 * Library routes — /api/library  (device-bound)
 *
 *   POST /api/library   body: { device_fingerprint }  → unlocked content
 *
 * POST (not GET) so the device fingerprint travels in the request body rather
 * than the URL, keeping it out of access logs and browser history.
 */

const express = require('express');
const libraryController = require('../controllers/libraryController');

const router = express.Router();

router.post('/', libraryController.getLibrary);

module.exports = router;
