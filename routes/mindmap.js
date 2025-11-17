const express = require('express');
const router = express.Router();
const mindmapController = require('../controllers/mindmapController.js');
const authMiddleware = require('../middlewares/middlewares.js');
const { ObjectId } = require('mongodb');

router.patch('/:id', authMiddleware.checkLoggedIn, mindmapController.updateMindmapTitleAPI);
router.post('/create', authMiddleware.checkLoggedIn, mindmapController.createMindmap);
router.post('/', authMiddleware.checkLoggedIn, mindmapController.createMindmap); // Alias cho /create
router.delete('/:id', authMiddleware.checkLoggedIn, mindmapController.deleteMindmap);


router.get('/view', authMiddleware.checkLoggedIn, (req, res) => {
    res.render('mindmapView', { 
        title: 'Sơ đồ tư duy của bạn',
        user: req.session.user
    });
});

// GET mindmap JSON data (chỉ định nghĩa 1 lần)
router.get('/:id/json', authMiddleware.checkLoggedIn, async (req, res) => {
    try {
        const db = req.app.locals.mindmapsDb;
        const usersDb = req.app.locals.usersDb;
        const mindmapId = req.params.id;
        
        // Validate ObjectId
        if (!ObjectId.isValid(mindmapId)) {
            return res.status(400).json({ success: false, error: 'ID không hợp lệ' });
        }
        
        const objectId = new ObjectId(mindmapId);
        const currentUserId = req.session.user._id.toString();
        
        // Bước 1: Thử tìm trong collection của current user trước
        let mindmap = await db.collection(currentUserId).findOne({ 
            _id: objectId, 
            deleted: { $ne: true } 
        });

        // Bước 2: Nếu không tìm thấy, tìm trong tất cả collections (shared mindmap)
        if (!mindmap) {
            console.log('🔍 Mindmap không thuộc user hiện tại, tìm trong các collections khác...');
            
            // Lấy danh sách tất cả users
            const allUsers = await usersDb.collection('users').find({}, { projection: { _id: 1 } }).toArray();
            
            // Tìm mindmap trong từng collection
            for (const user of allUsers) {
                const userId = user._id.toString();
                if (userId === currentUserId) continue; // Skip current user (đã check rồi)
                
                try {
                    mindmap = await db.collection(userId).findOne({ 
                        _id: objectId,
                        deleted: { $ne: true }
                    });
                    
                    if (mindmap) {
                        console.log(`✅ Tìm thấy mindmap trong collection của user: ${userId}`);
                        break; // Tìm thấy rồi thì dừng
                    }
                } catch (err) {
                    // Collection không tồn tại, bỏ qua
                    continue;
                }
            }
        }

        if (!mindmap) {
            return res.status(404).json({ success: false, error: 'Mindmap không tồn tại hoặc bạn không có quyền truy cập' });
        }

        // Log để debug
        console.log('📤 Returning mindmap data:', {
            id: mindmap._id,
            hasNodes: !!mindmap.nodes,
            nodesCount: mindmap.nodes?.length || 0,
            hasContent: !!mindmap.content
        });

        res.json({
            success: true,
            data: {
                id: mindmap._id,
                title: mindmap.title,
                content: mindmap.content || '',
                createdAt: mindmap.createdAt,
                nodes: mindmap.nodes || [],
                edges: mindmap.edges || []
            }
        });

    } catch (error) {
        console.error('❌ Error fetching mindmap JSON:', error);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// PATCH save mindmap nodes/edges
router.patch(
  '/:id/save',
  authMiddleware.checkLoggedIn,
  mindmapController.updateMindmapData
);


router.get('/:id', authMiddleware.checkLoggedIn, mindmapController.getMindmapPage);
module.exports = router;