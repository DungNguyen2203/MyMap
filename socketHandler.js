// File: socketHandler.js
const { ObjectId } = require('mongodb');
const logger = require('./utils/logger');

// Map để lưu trạng thái online: userId (string) -> socketId
const onlineUsers = new Map();

// Map để track users đang chỉnh sửa mindmap: mindmapId -> Set of {userId, username, socketId, cursor}
const mindmapRooms = new Map();

module.exports = (io, usersDb, chatDb) => {
    // Lấy các collection cần thiết
    const messagesCollection = chatDb.collection('messages');
    const friendsCollection = usersDb.collection('friends'); // Collection để lấy danh sách bạn bè

    // === Hàm helper lấy danh sách ID bạn bè ===
    async function getFriendsList(userId) {
        if (!userId) return []; // Trả về mảng rỗng nếu không có userId
        try {
            const friendships = await friendsCollection.find({
                status: 'accepted', // Chỉ lấy bạn bè đã chấp nhận
                $or: [{ senderId: userId }, { receiverId: userId }] // Tìm trong cả hai trường
            }).toArray();

            // Lấy ID của người bạn (không phải userId hiện tại)
            return friendships.map(f => {
                return f.senderId.equals(userId) ? f.receiverId : f.senderId;
            });
        } catch (error) {
            logger.error('Error fetching friends list', { userId: userId.toString(), error });
            return [];
        }
    }

    // === Xử lý khi có kết nối mới ===
    io.on('connection', async (socket) => {
        console.log(`🔌 User connected: ${socket.id}`);
        let currentUserId = null; // Biến lưu ObjectId của user cho socket này
        let currentUserIdString = null; // Biến lưu string ID của user

        // --- 1. Xác thực người dùng qua session ---
        try {
            // Kiểm tra session và user._id tồn tại
            if (socket.request.session?.user?._id) {
                currentUserId = new ObjectId(socket.request.session.user._id);
                currentUserIdString = currentUserId.toString();
                console.log(`🙋 User authenticated via session: ${currentUserIdString}`);
                // NOTE: Emit 'authenticated' SAU KHI đăng ký listeners để client không emit events quá sớm
            } else {
                throw new Error('Session or user ID missing.');
            }
        } catch (error) {
            logger.warn('Socket authentication error', { socketId: socket.id, error: error.message });
            socket.emit('chatError', 'Lỗi xác thực. Vui lòng đăng nhập lại.');
            socket.disconnect(true);
            return;
        }

        // --- 2. Xử lý trạng thái Online ---
        // Lưu trạng thái online
        onlineUsers.set(currentUserIdString, socket.id);
        console.log(`🟢 User online: ${currentUserIdString}. Total online: ${onlineUsers.size}`);

        // Lấy danh sách bạn bè của user này
        const friendObjectIds = await getFriendsList(currentUserId);
        const friendIds = friendObjectIds.map(id => id.toString()); // Chuyển sang string array

        // Thông báo cho bạn bè đang online biết user này online
        friendIds.forEach(friendId => {
            const friendSocketId = onlineUsers.get(friendId);
            if (friendSocketId) {
                io.to(friendSocketId).emit('user online', { userId: currentUserIdString });
                console.log(`   📢 Notified friend ${friendId} (socket ${friendSocketId}) that ${currentUserIdString} is online.`);
            }
        });

        // Gửi cho user này danh sách bạn bè đang online
        const onlineFriendIds = friendIds.filter(friendId => onlineUsers.has(friendId));
        socket.emit('friends status', { onlineFriendIds: onlineFriendIds });
        console.log(`   📡 Sent online status of ${onlineFriendIds.length} friends back to ${currentUserIdString}.`);

        // --- 3. XỬ LÝ COLLABORATIVE MINDMAP EDITING ---

        // Join một mindmap room
        socket.on('join-mindmap', async (data) => {
            console.log(`\n🎨 ========== SERVER RECEIVED JOIN REQUEST ==========`);
            console.log(`📩 Socket ${socket.id} wants to join`);
            console.log(`👤 User: ${currentUserIdString}`);
            console.log(`📦 Data:`, data);
            
            if (!currentUserId || !data || !data.mindmapId) {
                console.error('❌ Invalid data for join-mindmap');
                logger.warn('Invalid join-mindmap data', { userId: currentUserIdString, data });
                return;
            }

            const { mindmapId } = data;
            const username = socket.request.session?.user?.username || 'Anonymous';
            const avatar = socket.request.session?.user?.avatar || null;

            try {
                console.log(`🚪 Attempting to join room: mindmap:${mindmapId}`);
                
                // Join socket room
                await socket.join(`mindmap:${mindmapId}`);
                
                console.log(`✅ Socket successfully joined Socket.IO room`);

                // Thêm user vào mindmap room tracking
                if (!mindmapRooms.has(mindmapId)) {
                    console.log(`📝 Creating new room tracking for ${mindmapId}`);
                    mindmapRooms.set(mindmapId, new Map());
                }

                const roomUsers = mindmapRooms.get(mindmapId);
                roomUsers.set(currentUserIdString, {
                    userId: currentUserIdString,
                    username: username,
                    avatar: avatar,
                    socketId: socket.id,
                    cursor: null,
                    joinedAt: new Date()
                });

                // Lấy danh sách users đang online trong room
                const activeUsers = Array.from(roomUsers.values()).map(u => ({
                    userId: u.userId,
                    username: u.username,
                    avatar: u.avatar,
                    cursor: u.cursor
                }));

                console.log(`🎨 User ${username} joined mindmap ${mindmapId}`);
                console.log(`📊 Total users in room: ${activeUsers.length}`);
                console.log(`👥 User IDs:`, Array.from(roomUsers.keys()));

                // Verify with Socket.IO adapter
                const socketsInRoom = Array.from(io.sockets.adapter.rooms.get(`mindmap:${mindmapId}`) || []);
                console.log(`🔌 Socket IDs in room (Socket.IO):`, socketsInRoom);

                // Gửi xác nhận về client
                console.log(`📤 Sending join-mindmap-success to ${socket.id}`);
                socket.emit('join-mindmap-success', { mindmapId, activeUsers });
                console.log(`✅ ACK sent successfully`);
                console.log(`========================================\n`);

                // ✅ XÁC NHẬN join thành công cho client
                socket.emit('join-mindmap-success', { mindmapId, activeUsers });

                // Gửi danh sách users cho user mới join
                socket.emit('mindmap-users-list', { users: activeUsers });

                // Thông báo cho các users khác trong room
                socket.to(`mindmap:${mindmapId}`).emit('user-joined-mindmap', {
                    userId: currentUserIdString,
                    username: username,
                    avatar: avatar
                });

            } catch (error) {
                logger.error('Error joining mindmap', { userId: currentUserIdString, mindmapId, error });
                socket.emit('mindmap-error', 'Không thể join mindmap.');
            }
        });

        // Leave mindmap room
        socket.on('leave-mindmap', (data) => {
            if (!data || !data.mindmapId) return;
            const { mindmapId } = data;

            socket.leave(`mindmap:${mindmapId}`);

            if (mindmapRooms.has(mindmapId)) {
                const roomUsers = mindmapRooms.get(mindmapId);
                roomUsers.delete(currentUserIdString);

                if (roomUsers.size === 0) {
                    mindmapRooms.delete(mindmapId);
                }

                console.log(`🚪 User ${currentUserIdString} left mindmap ${mindmapId}`);

                // Thông báo cho users khác
                socket.to(`mindmap:${mindmapId}`).emit('user-left-mindmap', {
                    userId: currentUserIdString
                });
            }
        });

        // Broadcast mindmap changes (nodes/edges update)
        socket.on('mindmap-change', (data) => {
            if (!data || !data.mindmapId) return;

            const { mindmapId, changes, changeType } = data;

            // Broadcast đến tất cả users khác trong room (không gửi lại cho chính mình)
            socket.to(`mindmap:${mindmapId}`).emit('mindmap-update', {
                userId: currentUserIdString,
                changes: changes,
                changeType: changeType, // 'nodes' | 'edges' | 'both'
                timestamp: Date.now()
            });

            console.log(`📝 User ${currentUserIdString} made changes to mindmap ${mindmapId} (${changeType})`);
        });

        // Update cursor position
        socket.on('cursor-move', (data) => {
            if (!data || !data.mindmapId) return;

            const { mindmapId, cursor } = data; // cursor: { x, y }

            // Cập nhật cursor trong tracking
            if (mindmapRooms.has(mindmapId)) {
                const roomUsers = mindmapRooms.get(mindmapId);
                const userInfo = roomUsers.get(currentUserIdString);
                if (userInfo) {
                    userInfo.cursor = cursor;
                }
            }

            // Broadcast cursor position
            socket.to(`mindmap:${mindmapId}`).emit('cursor-update', {
                userId: currentUserIdString,
                username: socket.request.session?.user?.username || 'Anonymous',
                cursor: cursor
            });
        });

        // Node selection (để hiển thị ai đang select node nào)
        socket.on('node-select', (data) => {
            if (!data || !data.mindmapId) return;

            const { mindmapId, nodeIds } = data; // nodeIds: array of selected node IDs

            socket.to(`mindmap:${mindmapId}`).emit('node-selection-update', {
                userId: currentUserIdString,
                username: socket.request.session?.user?.username || 'Anonymous',
                nodeIds: nodeIds
            });
        });

        // ✅ QUAN TRỌNG: Emit 'authenticated' event SAU KHI đã đăng ký ALL listeners
        // Để client biết server đã sẵn sàng nhận events
        socket.emit('authenticated', { userId: currentUserIdString, username: socket.request.session?.user?.username });
        console.log(`✅ Emitted 'authenticated' to client ${socket.id}`);

        // --- 4. Lắng nghe các sự kiện chat từ client ---

        // Lấy lịch sử chat
        socket.on('getChatHistory', async (data) => {
            if (!currentUserId || !data || !data.receiverId) return;
            try {
                const receiverId = new ObjectId(data.receiverId);
                
                // CRITICAL: Kiểm tra xem hai người có phải bạn bè không
                const isFriend = await friendsCollection.findOne({
                    status: 'accepted',
                    $or: [
                        { senderId: currentUserId, receiverId: receiverId },
                        { senderId: receiverId, receiverId: currentUserId }
                    ]
                });

                if (!isFriend) {
                    logger.warn('Unauthorized chat history access', { 
                        requesterId: currentUserIdString, 
                        targetId: data.receiverId 
                    });
                    socket.emit('chatError', 'Bạn chỉ có thể xem tin nhắn với bạn bè.');
                    return;
                }

                const messages = await messagesCollection.find({
                    $or: [
                        { senderId: currentUserId, receiverId: receiverId },
                        { senderId: receiverId, receiverId: currentUserId }
                    ]
                }).sort({ createdAt: 1 }).toArray();

                socket.emit('chatHistory', {
                    receiverId: data.receiverId,
                    messages: messages,
                    currentUserId: currentUserIdString
                });
            } catch (error) {
                logger.error('Error fetching chat history', { 
                    userId: currentUserIdString, 
                    receiverId: data.receiverId, 
                    error 
                });
                socket.emit('chatError', 'Không thể tải lịch sử tin nhắn.');
            }
        });

        // Nhận và gửi tin nhắn
        socket.on('sendMessage', async (data) => {
            if (!currentUserId || !data || !data.receiverId || !data.content) {
                logger.warn('Invalid sendMessage data', { userId: currentUserIdString, data });
                return;
            }
            try {
                const receiverId = new ObjectId(data.receiverId);
                const message = {
                    senderId: currentUserId,
                    receiverId: receiverId,
                    content: data.content,
                    createdAt: new Date()
                };
                const result = await messagesCollection.insertOne(message);

                // Gửi lại tin nhắn đã lưu (có _id và createdAt) cho người gửi
                socket.emit('messageSent', { ...message, senderId: currentUserIdString, receiverId: data.receiverId }); // Gửi ID dạng string

                // Gửi tin nhắn cho người nhận nếu họ online
                const receiverSocketId = onlineUsers.get(data.receiverId);
                if (receiverSocketId) {
                    io.to(receiverSocketId).emit('receiveMessage', { ...message, senderId: currentUserIdString, receiverId: data.receiverId });
                }
            } catch (error) {
                logger.error('Error sending message', { 
                    senderId: currentUserIdString, 
                    receiverId: data.receiverId, 
                    error 
                });
                socket.emit('chatError', 'Gửi tin nhắn thất bại.');
            }
        });

        // Xử lý typing indicators (Giữ nguyên)
        socket.on('typingStart', (data) => {
            if (!currentUserId || !data || !data.receiverId) return;
            const receiverSocketId = onlineUsers.get(data.receiverId);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('typing', { userId: currentUserIdString, isTyping: true });
            }
        });

        socket.on('typingStop', (data) => {
             if (!currentUserId || !data || !data.receiverId) return;
            const receiverSocketId = onlineUsers.get(data.receiverId);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('typing', { userId: currentUserIdString, isTyping: false });
            }
        });

        // --- 4. Xử lý khi ngắt kết nối ---
        socket.on('disconnect', async (reason) => {
            console.log(`🔌 User disconnected: ${socket.id}. UserID: ${currentUserIdString}. Reason: ${reason}`);
            if (currentUserIdString) {
                // Xóa khỏi tất cả mindmap rooms
                mindmapRooms.forEach((roomUsers, mindmapId) => {
                    if (roomUsers.has(currentUserIdString)) {
                        roomUsers.delete(currentUserIdString);
                        
                        // Thông báo user rời khỏi room
                        io.to(`mindmap:${mindmapId}`).emit('user-left-mindmap', {
                            userId: currentUserIdString
                        });

                        console.log(`🚪 User ${currentUserIdString} auto-left mindmap ${mindmapId} on disconnect`);

                        // Xóa room nếu trống
                        if (roomUsers.size === 0) {
                            mindmapRooms.delete(mindmapId);
                        }
                    }
                });

                // Xóa trạng thái online
                onlineUsers.delete(currentUserIdString);
                console.log(`🔴 User offline: ${currentUserIdString}. Total online: ${onlineUsers.size}`);

                // Lấy lại danh sách bạn bè
                const friendObjectIdsOnDisconnect = await getFriendsList(currentUserId);
                const friendIdsOnDisconnect = friendObjectIdsOnDisconnect.map(id => id.toString());

                // Thông báo cho bạn bè đang online biết user này offline
                friendIdsOnDisconnect.forEach(friendId => {
                    const friendSocketId = onlineUsers.get(friendId);
                    if (friendSocketId) {
                        io.to(friendSocketId).emit('user offline', { userId: currentUserIdString });
                        console.log(`   📢 Notified friend ${friendId} (socket ${friendSocketId}) that ${currentUserIdString} is offline.`);
                    }
                });
            }
            // Dọn dẹp biến
            currentUserId = null;
            currentUserIdString = null;
        });

        // --- 5. EMIT 'authenticated' SAU KHI ĐÃ ĐĂNG KÝ TẤT CẢ LISTENERS ---
        // Điều này đảm bảo khi client nhận authenticated và bắt đầu emit events,
        // server đã sẵn sàng nhận
        console.log(`✅ All listeners registered, sending authenticated event`);
        socket.emit('authenticated', { userId: currentUserIdString });

    }); // Kết thúc io.on('connection')
}; // Kết thúc module.exports