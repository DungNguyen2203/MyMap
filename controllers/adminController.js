// File: controllers/adminController.js

// Import module userModel (chứa các hàm tương tác với collection users)
const userModel = require('../models/userModel.js');
// Import ObjectId từ MongoDB để xử lý ID
const { ObjectId } = require('mongodb');
// Import cache tiện ích dùng chung
const { documentCache, CACHE_PREFIX } = require('../utils/documentCache.js');

// === 1. HÀM HIỂN THỊ TRANG TỔNG QUAN ADMIN ===
exports.getDashboard = async (req, res) => {
    try {
        // Lấy database users và mindmaps từ app.locals (được gán từ file app.js)
        const usersDb = req.app.locals.usersDb;
        const mindmapsDb = req.app.locals.mindmapsDb;

        // Đếm tổng số người dùng trong collection 'users'
        const totalUsers = await usersDb.collection('users').countDocuments();
        // Đếm số người dùng có trạng thái 'locked' (bị khóa)
        const lockedUsers = await usersDb.collection('users').countDocuments({ status: 'locked' });

        // Đếm tổng số tài liệu đã upload (collection 'documents')
        const totalDocs = await usersDb.collection('documents').countDocuments();

        // Đếm tổng số sơ đồ tư duy (mindmap) trong toàn bộ hệ thống
        // Mỗi user có một collection riêng trong mindmapsDb (tên collection = userId)
        const collections = await mindmapsDb.listCollections().toArray();
        let totalMindmaps = 0;
        for (const col of collections) {
            // Bỏ qua các collection hệ thống (bắt đầu bằng 'system.')
            if (!col.name.startsWith('system.')) {
                // Đếm số document trong collection của user, không tính các document bị xóa mềm (deleted: true)
                const count = await mindmapsDb.collection(col.name).countDocuments({ deleted: { $ne: true } });
                totalMindmaps += count;
            }
        }

        // Render trang admin-dashboard với các thống kê
        res.render('admin-dashboard', {
            pageTitle: 'Admin Dashboard',
            user: req.session.user,          // Thông tin admin từ session
            stats: {
                totalUsers, // tổng số lượng người dùng
                lockedUsers, // số người dùng bị khóa 
                totalDocs, // tổng số tài liệu đã upload
                totalMindmaps // tổng số sơ đồ tư duy
            }
        });
    } catch (error) {
        // Nếu có lỗi, log và render trang 500
        console.error('❌ Lỗi getDashboard Admin:', error);
        res.status(500).render('500', { pageTitle: 'Lỗi Server', user: req.session.user });
    }
};

// === 2. HÀM HIỂN THỊ TRANG QUẢN LÝ NGƯỜI DÙNG ===
exports.getUsersPage = async (req, res) => {
    try {
        const usersDb = req.app.locals.usersDb;
        // Lấy danh sách tất cả người dùng (gọi hàm từ userModel)
        const users = await userModel.findAllUsers(usersDb);

        // Render trang admin-users, truyền danh sách users
        res.render('admin-users', {
            pageTitle: 'Quản lý người dùng',
            user: req.session.user,
            users: users || [] // Nếu không có thì mảng rỗng
        });
    } catch (error) {
        console.error('❌ Lỗi getUsersPage Admin:', error);
        res.status(500).render('500', { pageTitle: 'Lỗi Server', user: req.session.user });
    }
};

// === 3. HÀM XỬ LÝ KHÓA / MỞ KHÓA TÀI KHOẢN ===
exports.postToggleUserStatus = async (req, res) => {
    const { id } = req.params;        // Lấy userId từ URL parameter
    const usersDb = req.app.locals.usersDb;

    try {
        // Kiểm tra id có phải ObjectId hợp lệ không
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'ID người dùng không hợp lệ.' });
        }

        // Tìm người dùng theo id (gọi từ userModel)
        const user = await userModel.findUserById(usersDb, id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
        }

        // Không cho phép admin tự khóa chính mình
        if (user._id.toString() === req.session.user._id.toString()) {
            return res.status(400).json({ success: false, message: 'Bạn không thể tự khóa tài khoản của chính mình!' });
        }

        // Xác định trạng thái mới: nếu hiện tại là 'active' thì chuyển thành 'locked', ngược lại thành 'active'
        const newStatus = (user.status || 'active') === 'active' ? 'locked' : 'active';
        // Cập nhật trạng thái trong DB
        await userModel.updateUserStatus(usersDb, id, newStatus);

        // Log hành động
        console.log(`👤 Admin ${req.session.user.username} đã đổi trạng thái user ${user.username} thành ${newStatus}`);
        // Trả về JSON thành công
        res.json({ success: true, newStatus, message: `Đã chuyển trạng thái sang: ${newStatus === 'active' ? 'Hoạt động' : 'Bị khóa'}` });

    } catch (error) {
        console.error('❌ Lỗi postToggleUserStatus Admin:', error);
        res.status(500).json({ success: false, message: 'Lỗi server nội bộ.' });
    }
};

// === 4. HÀM HIỂN THỊ TRANG KIỂM DUYỆT TÀI LIỆU ===
exports.getDocumentsPage = async (req, res) => {
    try {
        const usersDb = req.app.locals.usersDb;
        // Lấy tất cả tài liệu trong collection 'documents', sắp xếp theo thời gian tạo giảm dần (mới nhất trước)
        const documents = await usersDb.collection('documents').find({}).sort({ createdAt: -1 }).toArray();

        // Render trang admin-documents
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

// === 5. HÀM XÓA TÀI LIỆU VI PHẠM ===
exports.postDeleteDocument = async (req, res) => {
    const { id } = req.params;      // Lấy documentId từ URL
    const usersDb = req.app.locals.usersDb;

    try {
        // Kiểm tra id hợp lệ
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'ID tài liệu không hợp lệ.' });
        }

        // Xóa document trong collection 'documents' theo _id
        const result = await usersDb.collection('documents').deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy tài liệu cần xóa.' });
        }

        console.log(`📄 Admin ${req.session.user.username} đã xóa tài liệu ${id} khỏi hệ thống.`);
        res.json({ success: true, message: 'Đã xóa tài liệu khỏi hệ thống.' });
    } catch (error) {
        console.error('❌ Lỗi postDeleteDocument Admin:', error);
        res.status(500).json({ success: false, message: 'Lỗi server nội bộ.' });
    }
};

// === 6. HÀM LẤY CHI TIẾT TÀI LIỆU VÀ NỘI DUNG CACHE ===
exports.getDocumentDetails = async (req, res) => {
    const { id } = req.params;
    const usersDb = req.app.locals.usersDb;

    try {
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'ID tài liệu không hợp lệ.' });
        }

        // Tìm tài liệu trong DB
        const doc = await usersDb.collection('documents').findOne({ _id: new ObjectId(id) });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy thông tin tài liệu.' });
        }

        // Lấy thông tin từ cache theo hash
        let cachedContent = null;
        if (doc.hash) {
            const key = `${CACHE_PREFIX}${doc.hash}`;
            cachedContent = await documentCache.get(key);
        }

        res.json({
            success: true,
            document: {
                _id: doc._id,
                title: doc.title,
                fileType: doc.fileType,
                size: doc.size,
                username: doc.username,
                hash: doc.hash,
                createdAt: doc.createdAt,
                // Trả về thêm bản tóm tắt và Markdown từ cache
                summary: cachedContent?.mindmap?.summary || 'Không có bản tóm tắt nào lưu trong cache (đã quá 7 ngày hoặc chưa được tạo).',
                markdown: cachedContent?.markdown || 'Không có nội dung sơ đồ tư duy nào lưu trong cache.'
            }
        });
    } catch (error) {
        console.error('❌ Lỗi getDocumentDetails Admin:', error);
        res.status(500).json({ success: false, message: 'Lỗi server nội bộ khi lấy chi tiết tài liệu.' });
    }
};