/**
 * User routes — /api/users  (admin account management)
 *
 *   GET    /api/users              (admin) list admin accounts
 *   POST   /api/users              (admin) create an admin account
 *   PUT    /api/users/:id/password (admin) change an account's password
 *   PUT    /api/users/:id          (admin) update username / role
 *   DELETE /api/users/:id          (admin) delete an admin account
 *
 * Every route requires an authenticated admin. The password route is declared
 * before the generic /:id route so it always wins the match.
 */

const express = require('express');
const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/', userController.list);
router.post('/', userController.create);
router.put('/:id/password', userController.changePassword);
router.put('/:id', userController.update);
router.delete('/:id', userController.remove);

module.exports = router;
