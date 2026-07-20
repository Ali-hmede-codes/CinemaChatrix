/**
 * Movie routes — /api/movies
 *
 *   GET    /api/movies        (admin)  list all films
 *   GET    /api/movies/:slug  (public) get film info by slug
 *   POST   /api/movies        (admin)  upload new film (multipart)
 *   PUT    /api/movies/:id     (admin)  update film info (JSON)
 *   DELETE /api/movies/:id     (admin)  delete film + files
 */

const express = require('express');
const movieController = require('../controllers/movieController');
const authMiddleware = require('../middleware/authMiddleware');
const upload = require('../config/multer');

const router = express.Router();

const uploadFields = upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'poster', maxCount: 1 },
]);

const posterOnly = upload.fields([{ name: 'poster', maxCount: 1 }]);

router.get('/', authMiddleware, movieController.list);
router.post('/bulk', authMiddleware, movieController.bulkCreate);
router.get('/:slug', movieController.getBySlug);
router.post('/', authMiddleware, uploadFields, movieController.create);
router.put('/:id', authMiddleware, posterOnly, movieController.update);
router.delete('/:id', authMiddleware, movieController.remove);

module.exports = router;
