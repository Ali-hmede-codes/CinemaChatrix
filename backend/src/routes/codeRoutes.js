/**
 * Code routes — /api/codes
 *
 *   POST   /api/codes/generate   (admin)             generate codes for a film/episode
 *   GET    /api/codes            (admin)             list codes (+ filters)
 *   DELETE /api/codes/:id        (admin)             delete a code
 *   POST   /api/codes/redeem     (device, limited)   redeem a code → bind to device
 *   POST   /api/codes/check      (device)            check if a device has access
 *
 * The code-redeem endpoint is rate-limited to blunt brute-force guessing.
 */

const express = require('express');
const codeController = require('../controllers/codeController');
const authMiddleware = require('../middleware/authMiddleware');
const { codeRedeemLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/* ---- Admin (JWT) ---- */
router.post('/generate', authMiddleware, codeController.generate);
router.get('/', authMiddleware, codeController.list);

/* ---- Public (device) ---- */
router.post('/redeem', codeRedeemLimiter, codeController.redeem);
router.post('/check', codeController.check);

/* ---- Admin delete (declared after static paths) ---- */
router.delete('/:id', authMiddleware, codeController.remove);

module.exports = router;
