// File: routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController.js');
const authMiddleware = require('../middlewares/middlewares.js');

// Áp dụng middleware kiểm tra đăng nhập và kiểm tra admin cho toàn bộ các route
router.use(authMiddleware.checkLoggedIn);
router.use(authMiddleware.checkAdmin);

// Các route quản trị
router.get('/dashboard', adminController.getDashboard);
router.get('/users', adminController.getUsersPage);
router.post('/users/:id/toggle-status', adminController.postToggleUserStatus);
router.get('/documents', adminController.getDocumentsPage);
router.get('/documents/:id', adminController.getDocumentDetails);
router.post('/documents/:id/delete', adminController.postDeleteDocument);

module.exports = router;
