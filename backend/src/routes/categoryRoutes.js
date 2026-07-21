/**
 * Category routes — /api/categories
 *
 *   GET    /api/categories      (public) full category tree
 *   POST   /api/categories      (admin)  create a main / sub category
 *   PUT    /api/categories/:id  (admin)  rename / reorder a category
 *   DELETE /api/categories/:id  (admin)  delete a category (+ its sub-categories)
 *
 * The tree is public so both the admin panel and the user app can read it;
 * all mutations require an authenticated admin.
 */

const express = require('express');
const categoryController = require('../controllers/categoryController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', categoryController.tree);
router.post('/', authMiddleware, categoryController.create);
router.put('/:id', authMiddleware, categoryController.update);
router.delete('/:id', authMiddleware, categoryController.remove);

module.exports = router;
