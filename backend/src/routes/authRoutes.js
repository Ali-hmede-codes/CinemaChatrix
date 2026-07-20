/**
 * Auth routes — /api/auth
 *
 *   POST /api/auth/login   (public, rate-limited)  → admin login
 *   POST /api/auth/logout  (admin)                 → clear auth cookie
 *   GET  /api/auth/me      (admin)                 → current admin info
 */

const express = require('express');
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.post('/login', authLimiter, authController.login);
router.post('/logout', authMiddleware, authController.logout);
router.get('/me', authMiddleware, authController.me);

module.exports = router;
