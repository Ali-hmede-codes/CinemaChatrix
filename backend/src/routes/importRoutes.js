/**
 * Import routes — /api/imports
 *
 *   GET /api/imports/:id  (admin)  poll a bulk remote-import job's progress
 */

const express = require('express');
const importController = require('../controllers/importController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/:id', authMiddleware, importController.status);

module.exports = router;
