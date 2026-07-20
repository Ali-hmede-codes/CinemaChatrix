/**
 * Series routes — /api/series
 *
 *   GET    /api/series               (admin)  list all series
 *   GET    /api/series/:slug         (public) series info + episodes
 *   POST   /api/series               (admin)  create series (multipart, poster optional)
 *   POST   /api/series/:id/episodes  (admin)  add episode (multipart)
 *   DELETE /api/series/episodes/:id  (admin)  delete a single episode
 *   DELETE /api/series/:id           (admin)  delete series + episodes
 */

const express = require('express');
const seriesController = require('../controllers/seriesController');
const authMiddleware = require('../middleware/authMiddleware');
const upload = require('../config/multer');

const router = express.Router();

const posterOnly = upload.fields([{ name: 'poster', maxCount: 1 }]);
const episodeUpload = upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'poster', maxCount: 1 },
]);

router.get('/', authMiddleware, seriesController.list);
router.get('/:slug', seriesController.getBySlug);
router.post('/', authMiddleware, posterOnly, seriesController.create);
router.post('/:id/episodes/bulk', authMiddleware, seriesController.bulkAddEpisodes);
router.post('/:id/episodes', authMiddleware, episodeUpload, seriesController.addEpisode);

// Specific episode routes must be declared before the generic "/:id"
router.put('/episodes/:id', authMiddleware, posterOnly, seriesController.updateEpisode);
router.delete('/episodes/:id', authMiddleware, seriesController.removeEpisode);
router.put('/:id', authMiddleware, posterOnly, seriesController.update);
router.delete('/:id', authMiddleware, seriesController.remove);

module.exports = router;
