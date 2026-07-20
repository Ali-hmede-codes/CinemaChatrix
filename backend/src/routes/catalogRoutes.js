/**
 * Catalog routes — /api/catalog  (PUBLIC, browse-only)
 *
 *   GET /api/catalog/home          films + series + newly-added feed
 *   GET /api/catalog/films         published films
 *   GET /api/catalog/series        published series
 *   GET /api/catalog/film/:slug    single film detail
 *   GET /api/catalog/series/:slug  single series detail + episodes
 *
 * These endpoints are read-only and never expose private video paths or
 * ownership. They are covered by the general apiLimiter mounted on /api.
 */

const express = require('express');
const catalogController = require('../controllers/catalogController');

const router = express.Router();

router.get('/home', catalogController.home);
router.get('/films', catalogController.films);
router.get('/series', catalogController.series);
router.get('/film/:slug', catalogController.filmDetail);
router.get('/series/:slug', catalogController.seriesDetail);

module.exports = router;
