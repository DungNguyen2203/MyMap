// File: controllers/adminController.js
const userModel = require('../models/userModel.js');
const { ObjectId } = require('mongodb');

// Trang tổng quan của Admin
exports.getDashboard = async (req, res) => {
    try {
        const usersDb = req.app.locals.usersDb;
        const mindmapsDb = req.app.locals.mindmapsDb;

        // 1. Thống kê số lượng người dùng
        const totalUsers = await usersDb.collection('users').countDocuments();
        const lockedUsers = await usersDb.collection('users').countDocuments({ status: 'locked' });

        // 2. Thống kê số lượng tài liệu upload
        const totalDocs = await usersDb.collection('documents').countDocuments();

        // 3. Thống kê tổng số sơ đồ tư duy (tính tổng số documents trong các user collections)
        const collections = await mindmapsDb.listCollections().toArray();
        let totalMindmaps = 0;
        for (const col of collections) {
            // Không tính các collection system (nếu có)
            if (!col.name.startsWith('system.')) {
                const count = await mindmapsDb.collection(col.name).countDocuments({ deleted: { $ne: true } });
                totalMindmaps += count;
            }
        }

        res.render('admin-dashboard', {
            pageTitle: 'Admin Dashboard',
            user: req.session.user,
            stats: {
                totalUsers,
                lockedUsers,
                totalDocs,
                totalMindmaps
            }
        });
    } catch (error) {
        console.error('❌ Lỗi getDashboard Admin:', error);
        res.status(500).render('500', { pageTitle: 'Lỗi Server', user: req.session.user });
    }
};

// Trang Quản lý danh sách người dùng
exports.getUsersPage = async (req, res) => {
    try {
        const usersDb = req.app.locals.usersDb;
        const users = await userModel.findAllUsers(usersDb);

        res.render('admin-users', {
            pageTitle: 'Quản lý người dùng',
            user: req.session.user,
            users: users || []
        });
    } catch (error) {
        console.error('❌ Lỗi getUsersPage Admin:', error);
        res.status(500).render('500', { pageTitle: 'Lỗi Server', user: req.session.user });
    }
};

// Xử lý Khóa / Mở khóa tài khoản người dùng
exports.postToggleUserStatus = async (req, res) => {
    const { id } = req.params;
    const usersDb = req.app.locals.usersDb;

    try {
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'ID người dùng không hợp lệ.' });
        }

        const user = await userModel.findUserById(usersDb, id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
        }

        // Không cho phép tự khóa tài khoản của chính mình
        if (user._id.toString() === req.session.user._id.toString()) {
            return res.status(400).json({ success: false, message: 'Bạn không thể tự khóa tài khoản của chính mình!' });
        }

        const newStatus = (user.status || 'active') === 'active' ? 'locked' : 'active';
        await userModel.updateUserStatus(usersDb, id, newStatus);

        console.log(`👤 Admin ${req.session.user.username} đã đổi trạng thái user ${user.username} thành ${newStatus}`);
        res.json({ success: true, newStatus, message: `Đã chuyển trạng thái sang: ${newStatus === 'active' ? 'Hoạt động' : 'Bị khóa'}` });

    } catch (error) {
        console.error('❌ Lỗi postToggleUserStatus Admin:', error);
        res.status(500).json({ success: false, message: 'Lỗi server nội bộ.' });
    }
};

// Trang Kiểm duyệt tài liệu hệ thống
exports.getDocumentsPage = async (req, res) => {
    try {
        const usersDb = req.app.locals.usersDb;
        // Lấy tất cả tài liệu xếp từ mới nhất xuống
        const documents = await usersDb.collection('documents').find({}).sort({ createdAt: -1 }).toArray();

        res.render('admin-documents', {
            pageTitle: 'Kiểm duyệt tài liệu',
            user: req.session.user,
            documents: documents || []
        });
    } catch (error) {
        console.error('❌ Lỗi getDocumentsPage Admin:', error);
        res.status(500).render('500', { pageTitle: 'Lỗi Server', user: req.session.user });
    }
};

// Xử lý Xóa tài liệu vi phạm khỏi hệ thống
exports.postDeleteDocument = async (req, res) => {
    const { id } = req.params;
    const usersDb = req.app.locals.usersDb;

    try {
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'ID tài liệu không hợp lệ.' });
        }

        const result = await usersDb.collection('documents').deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy tài liệu cần xóa.' });
        }

        console.log(`📂 Admin ${req.session.user.username} đã xóa tài liệu có ID ${id}`);
        res.json({ success: true, message: 'Đã xóa tài liệu vi phạm thành công!' });

    } catch (error) {
        console.error('❌ Lỗi postDeleteDocument Admin:', error);
        res.status(500).json({ success: false, message: 'Lỗi server nội bộ.' });
    }
};
