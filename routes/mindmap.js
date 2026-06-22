const express = require('express');
const router = express.Router();
const mindmapController = require('../controllers/mindmapController.js');
const authMiddleware = require('../middlewares/middlewares.js');
const { ObjectId } = require('mongodb');

router.patch('/:id', authMiddleware.checkLoggedIn, mindmapController.updateMindmapTitleAPI);
router.post('/create', authMiddleware.checkLoggedIn, mindmapController.createMindmap);
router.delete('/:id', authMiddleware.checkLoggedIn, mindmapController.deleteMindmap);

router.get('/view', authMiddleware.checkLoggedIn, (req, res) => {
    res.render('mindmapView', { 
        title: 'Sơ đồ tư duy của bạn',
        user: req.session.user
    });
});

// === ROUTE /:id/json - LẤY MINDMAP CHO EDITOR ===
router.get('/:id/json', authMiddleware.checkLoggedIn, async (req, res) => {
    try {
        const db = req.app.locals.mindmapsDb;
        const mindmapId = req.params.id;
        
        // Validate ObjectId
        if (!ObjectId.isValid(mindmapId)) {
            return res.status(400).json({ success: false, error: 'ID không hợp lệ' });
        }
        
        const objectId = new ObjectId(mindmapId);
        const collectionName = req.session.user._id.toString();
        
        const mindmap = await db.collection(collectionName).findOne({ 
            _id: objectId, 
            deleted: { $ne: true } 
        });

        if (!mindmap) {
            return res.status(404).json({ success: false, error: 'Mindmap không tồn tại' });
        }

        res.json({
            success: true,
            data: {
                id: mindmap._id,
                title: mindmap.title,
                content: mindmap.content,
                mindmapJson: mindmap.mindmapJson || null,
                createdAt: mindmap.createdAt,
                // Trả về nodes/edges nếu chúng tồn tại trong DB, nếu không trả về mảng rỗng
                nodes: mindmap.nodes || [],
                edges: mindmap.edges || []
            }
        });

    } catch (error) {
        console.error('Error fetching mindmap JSON:', error);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

router.patch(
  '/:id/save', // Route mới: /mindmaps/:id/save
  authMiddleware.checkLoggedIn, // Đảm bảo người dùng đã đăng nhập
  mindmapController.updateMindmapData // Hàm controller mới sẽ xử lý
);

// === THÊM MỚI: Routes cho Real-time Collaboration (Shared Access) ===
// Cho phép user khác (collaborator) truy cập mindmap của owner qua link chia sẻ
router.get('/shared/:ownerId/:id/json', authMiddleware.checkLoggedIn, async (req, res) => {
    try {
        const db = req.app.locals.mindmapsDb;
        const mindmapId = req.params.id;
        const ownerId = req.params.ownerId; // ID của chủ sở hữu mindmap

        if (!ObjectId.isValid(mindmapId)) {
            return res.status(400).json({ success: false, error: 'ID không hợp lệ' });
        }

        const objectId = new ObjectId(mindmapId);
        // Truy cập collection của OWNER (không phải của user hiện tại)
        const collectionName = ownerId;

        const mindmap = await db.collection(collectionName).findOne({
            _id: objectId,
            deleted: { $ne: true }
        });

        if (!mindmap) {
            return res.status(404).json({ success: false, error: 'Mindmap không tồn tại hoặc đã bị xóa' });
        }

        res.json({
            success: true,
            data: {
                id: mindmap._id,
                title: mindmap.title,
                content: mindmap.content,
                mindmapJson: mindmap.mindmapJson || null,
                createdAt: mindmap.createdAt,
                nodes: mindmap.nodes || [],
                edges: mindmap.edges || [],
                ownerId: ownerId
            }
        });

    } catch (error) {
        console.error('Error fetching shared mindmap JSON:', error);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// Cho phép collaborator lưu thay đổi vào mindmap của owner
router.patch('/shared/:ownerId/:id/save', authMiddleware.checkLoggedIn, async (req, res) => {
    try {
        const db = req.app.locals.mindmapsDb;
        const mindmapId = req.params.id;
        const ownerId = req.params.ownerId;

        if (!ObjectId.isValid(mindmapId)) {
            return res.status(400).json({ success: false, message: 'ID mindmap không hợp lệ.' });
        }

        const mindmapObjectId = new ObjectId(mindmapId);
        const collectionName = ownerId;
        const { nodes, edges } = req.body;

        if (!Array.isArray(nodes) || !Array.isArray(edges)) {
            return res.status(400).json({ success: false, message: 'Dữ liệu không đúng định dạng.' });
        }

        const result = await db.collection(collectionName).updateOne(
            { _id: mindmapObjectId, deleted: { $ne: true } },
            { $set: { nodes, edges, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: 'Mindmap không tồn tại.' });
        }

        res.json({ success: true, message: 'Đã lưu thay đổi collaboration!' });
    } catch (error) {
        console.error('Error saving shared mindmap:', error);
        res.status(500).json({ success: false, message: 'Lỗi server.' });
    }
});

router.get('/:id', authMiddleware.checkLoggedIn, mindmapController.getMindmapPage);
module.exports = router;