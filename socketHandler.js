// File: socketHandler.js
// Đây là file xử lý toàn bộ các kết nối thời gian thực (Real-time) sử dụng thư viện Socket.IO.
// File này quản lý trạng thái online/offline của người dùng, chat trực tiếp giữa bạn bè,
// và tính năng đồng chỉnh sửa sơ đồ tư duy (Mindmap Real-time Collaboration).

const { ObjectId } = require('mongodb'); // Import ObjectId từ thư viện MongoDB để làm việc với các ID dạng Object trong database.

// Map để lưu trạng thái online của người dùng: key là userId (dạng chuỗi/string) -> value là socketId tương ứng.
// Map giúp chúng ta tra cứu cực nhanh xem một user cụ thể có đang online hay không và socketId của họ là gì để gửi tin nhắn.
const onlineUsers = new Map();

// Map để lưu trạng thái của các phòng chỉnh sửa mindmap (mindmap rooms).
// Cấu trúc: mindmapId (string) -> Map<userId (string), { id: string, name: string, socketId: string, cursor: {x, y} | null }>
// Map này dùng để theo dõi xem mỗi mindmap đang có những ai cùng tham gia chỉnh sửa và vị trí con trỏ chuột của họ.
const mindmapRooms = new Map();

/**
 * Module exports nhận các tham số để khởi tạo kết nối socket:
 * @param {object} io - Đối tượng Server Socket.IO dùng để lắng nghe và phát các sự kiện.
 * @param {object} usersDb - Database chứa thông tin người dùng và mối quan hệ bạn bè.
 * @param {object} chatDb - Database chứa lịch sử tin nhắn chat.
 */
module.exports = (io, usersDb, chatDb) => {
    // Truy xuất collection 'messages' từ chatDb để lưu trữ và đọc lịch sử tin nhắn.
    const messagesCollection = chatDb.collection('messages');

    // Truy xuất collection 'friends' từ usersDb để kiểm tra danh sách bạn bè của người dùng.
    const friendsCollection = usersDb.collection('friends');

    /**
     * Hàm trợ giúp (helper) để lấy danh sách ID của tất cả bạn bè đã kết bạn của một user.
     * @param {ObjectId} userId - ID của người dùng cần lấy danh sách bạn bè.
     * @returns {Promise<Array<ObjectId>>} - Danh sách ObjectId của những người bạn.
     */
    async function getFriendsList(userId) {
        if (!userId) return []; // Trả về mảng rỗng ngay lập tức nếu không có ID người dùng.
        try {
            // Tìm kiếm các mối quan hệ bạn bè trong collection 'friends'
            const friendships = await friendsCollection.find({
                status: 'accepted', // Chỉ lấy các mối quan hệ bạn bè đã được chấp nhận (accepted), bỏ qua các lời mời đang chờ (pending).
                $or: [
                    { senderId: userId },   // Trường hợp user hiện tại là người gửi lời mời kết bạn.
                    { receiverId: userId }  // Trường hợp user hiện tại là người nhận lời mời kết bạn.
                ]
            }).toArray(); // Chuyển kết quả truy vấn thành mảng các Object.

            // Duyệt qua từng bản ghi bạn bè để lấy ra ID của đối phương (người bạn kia).
            return friendships.map(f => {
                // Nếu senderId trùng với userId của mình, thì ID bạn bè là receiverId. Ngược lại thì là senderId.
                return f.senderId.equals(userId) ? f.receiverId : f.senderId;
            });
        } catch (error) {
            // Ghi log lỗi nếu quá trình truy vấn danh sách bạn bè gặp sự cố database.
            console.error(`❌ Error fetching friends list for user ${userId}:`, error);
            return []; // Trả về mảng rỗng để đảm bảo ứng dụng không bị crash.
        }
    }

    // === Xử lý khi có một kết nối Socket.IO mới từ client ===
    io.on('connection', async (socket) => {
        // Log thông tin định danh của socket kết nối mới (mỗi tab/trình duyệt mở trang sẽ là một socket.id khác nhau).
        console.log(`🔌 User connected: ${socket.id}`);

        let currentUserId = null; // Biến dùng để lưu ObjectId của người dùng sau khi xác thực thành công.
        let currentUserIdString = null; // Biến dùng để lưu ID người dùng dưới dạng chuỗi (String) để dễ thao tác với Map/Socket.

        // --- 1. Xác thực người dùng qua Session dùng chung với Express ---
        try {
            // Kiểm tra xem socket kết nối có đính kèm thông tin session của Express và thông tin user đã đăng nhập hay không.
            if (socket.request.session?.user?._id) {
                // Ép kiểu ID từ chuỗi string trong session sang kiểu ObjectId của MongoDB.
                currentUserId = new ObjectId(socket.request.session.user._id);
                // Lưu ID dạng chuỗi để làm key so sánh.
                currentUserIdString = currentUserId.toString();
                console.log(`🙋 User authenticated via session: ${currentUserIdString}`);

                // Gửi sự kiện 'authenticated' kèm theo userId về phía client để client biết xác thực thành công.
                socket.emit('authenticated', { userId: currentUserIdString });
            } else {
                // Nếu session không chứa user._id, chứng tỏ người dùng chưa đăng nhập. Ném ra lỗi để xử lý ở khối catch.
                throw new Error('Session or user ID missing.');
            }
        } catch (error) {
            // Ghi log cảnh báo người dùng kết nối không hợp lệ/chưa đăng nhập.
            console.warn(`🔒 Authentication error for socket ${socket.id}: ${error.message}. Disconnecting.`);
            // Gửi thông báo lỗi cho client biết.
            socket.emit('chatError', 'Lỗi xác thực. Vui lòng đăng nhập lại.');
            // Ngắt kết nối socket này ngay lập tức để bảo mật hệ thống.
            socket.disconnect(true);
            return; // Dừng chạy các logic tiếp theo đối với kết nối không hợp lệ này.
        }

        // --- 2. Xử lý trạng thái Online của người dùng ---
        // Lưu trữ thông tin socket hiện tại của người dùng vào Map `onlineUsers`.
        // Nếu người dùng mở nhiều tab, tab mới nhất sẽ được cập nhật socket ID tương ứng.
        onlineUsers.set(currentUserIdString, socket.id);
        console.log(`🟢 User online: ${currentUserIdString}. Total online: ${onlineUsers.size}`);

        // Lấy danh sách ObjectId bạn bè của người dùng hiện tại từ DB.
        const friendObjectIds = await getFriendsList(currentUserId);
        // Chuyển đổi toàn bộ danh sách ObjectId bạn bè sang dạng chuỗi (String) để tiện tra cứu trên Map.
        const friendIds = friendObjectIds.map(id => id.toString());

        // Phát tín hiệu thông báo cho tất cả bạn bè của user này nếu họ đang online.
        friendIds.forEach(friendId => {
            // Tra cứu xem bạn bè có trong Map onlineUsers không.
            const friendSocketId = onlineUsers.get(friendId);
            if (friendSocketId) {
                // Gửi sự kiện 'user online' đến socket của người bạn đó để cập nhật trạng thái chấm xanh online trên giao diện chat.
                io.to(friendSocketId).emit('user online', { userId: currentUserIdString });
                console.log(`   📢 Notified friend ${friendId} (socket ${friendSocketId}) that ${currentUserIdString} is online.`);
            }
        });

        // Tìm xem những ai trong danh sách bạn bè của user này đang online tại thời điểm hiện tại.
        const onlineFriendIds = friendIds.filter(friendId => onlineUsers.has(friendId));
        // Gửi danh sách các ID bạn bè đang online về cho client vừa kết nối này.
        socket.emit('friends status', { onlineFriendIds: onlineFriendIds });
        console.log(`   📡 Sent online status of ${onlineFriendIds.length} friends back to ${currentUserIdString}.`);

        // --- 3. Lắng nghe các sự kiện chat trực tiếp từ client ---

        // Lắng nghe yêu cầu lấy lịch sử chat giữa người dùng hiện tại và bạn bè (receiverId)
        socket.on('getChatHistory', async (data) => {
            // Kiểm tra tính hợp lệ của người dùng và dữ liệu truyền lên (phải có đối tượng nhận receiverId).
            if (!currentUserId || !data || !data.receiverId) return;
            console.log(`📜 Request chat history between ${currentUserIdString} and ${data.receiverId}`);

            try {
                // Chuyển đổi receiverId dạng chuỗi sang ObjectId của MongoDB.
                const receiverId = new ObjectId(data.receiverId);

                // Truy vấn lịch sử tin nhắn trong collection 'messages'
                const messages = await messagesCollection.find({
                    // Tìm tin nhắn thoả mãn 1 trong 2 điều kiện:
                    // Hoặc là mình gửi cho bạn, hoặc là bạn gửi cho mình.
                    $or: [
                        { senderId: currentUserId, receiverId: receiverId },
                        { senderId: receiverId, receiverId: currentUserId }
                    ]
                }).sort({ createdAt: 1 }).toArray(); // Sắp xếp theo thời gian tạo tăng dần (từ cũ nhất đến mới nhất).

                // Gửi danh sách tin nhắn lịch sử về cho client yêu cầu.
                socket.emit('chatHistory', {
                    receiverId: data.receiverId,
                    messages: messages,
                    currentUserId: currentUserIdString // Truyền thêm ID của mình để client phân biệt tin nhắn gửi đi/nhận về.
                });
            } catch (error) {
                // Log lỗi và gửi thông báo lỗi về client nếu truy vấn DB thất bại.
                console.error(`❌ Error fetching chat history for ${currentUserIdString} and ${data.receiverId}:`, error);
                socket.emit('chatError', 'Không thể tải lịch sử tin nhắn.');
            }
        });

        // Lắng nghe sự kiện gửi tin nhắn mới từ client
        socket.on('sendMessage', async (data) => {
            // Kiểm tra các trường dữ liệu bắt buộc (người nhận và nội dung tin nhắn không được để trống).
            if (!currentUserId || !data || !data.receiverId || !data.content) {
                console.warn("Invalid sendMessage data:", data);
                return;
            }
            console.log(`💬 Message from ${currentUserIdString} to ${data.receiverId}: ${data.content}`);

            try {
                const receiverId = new ObjectId(data.receiverId);

                // Cấu trúc tài liệu tin nhắn để lưu vào MongoDB
                const message = {
                    senderId: currentUserId,   // ID người gửi (dạng ObjectId)
                    receiverId: receiverId,   // ID người nhận (dạng ObjectId)
                    content: data.content,     // Nội dung tin nhắn chat
                    createdAt: new Date()      // Thời gian gửi tin nhắn (ngày giờ hiện tại)
                };

                // Thực hiện chèn tin nhắn mới vào collection 'messages'
                const result = await messagesCollection.insertOne(message);

                // Gửi phản hồi lại cho chính người gửi (để hiển thị tin nhắn ngay lên khung chat của họ)
                // Chuyển đổi ID sang dạng string trong phản hồi để client dễ so sánh và xử lý.
                socket.emit('messageSent', { ...message, senderId: currentUserIdString, receiverId: data.receiverId });

                // Tra cứu socketId của người nhận xem họ có đang online không
                const receiverSocketId = onlineUsers.get(data.receiverId);
                if (receiverSocketId) {
                    // Nếu online, phát sự kiện 'receiveMessage' trực tiếp đến socket của người nhận để hiển thị thời gian thực.
                    io.to(receiverSocketId).emit('receiveMessage', { ...message, senderId: currentUserIdString, receiverId: data.receiverId });
                    console.log(`   📨 Sent message to receiver ${data.receiverId} (socket ${receiverSocketId})`);
                } else {
                    // Nếu người nhận đang offline, tin nhắn vẫn đã được lưu trong DB, họ sẽ đọc được khi online trở lại.
                    console.log(`   📪 Receiver ${data.receiverId} is offline. Message saved.`);
                }
            } catch (error) {
                // Xử lý lỗi hệ thống/DB khi lưu tin nhắn thất bại.
                console.error(`❌ Error sending message from ${currentUserIdString} to ${data.receiverId}:`, error);
                socket.emit('chatError', 'Gửi tin nhắn thất bại.');
            }
        });

        // Lắng nghe tín hiệu thông báo người dùng bắt đầu nhập tin nhắn (Typing...)
        socket.on('typingStart', (data) => {
            if (!currentUserId || !data || !data.receiverId) return;
            // Tìm socket của người nhận
            const receiverSocketId = onlineUsers.get(data.receiverId);
            if (receiverSocketId) {
                // Phát tin báo người nhận biết đối phương đang gõ chữ.
                io.to(receiverSocketId).emit('typing', { userId: currentUserIdString, isTyping: true });
            }
        });

        // Lắng nghe tín hiệu thông báo người dùng dừng nhập tin nhắn (Dừng Typing...)
        socket.on('typingStop', (data) => {
            if (!currentUserId || !data || !data.receiverId) return;
            // Tìm socket của người nhận
            const receiverSocketId = onlineUsers.get(data.receiverId);
            if (receiverSocketId) {
                // Phát tin báo người nhận ẩn dòng chữ "đang gõ..."
                io.to(receiverSocketId).emit('typing', { userId: currentUserIdString, isTyping: false });
            }
        });

        // =============================================================
        // === 🗺️ ĐỒNG CHỈNH SỬA SƠ ĐỒ TƯ DUY THỜI GIAN THỰC (MINDMAP COLLABORATION) ===
        // =============================================================

        // Lấy tên hiển thị của user từ session (tên hiển thị -> tên tài khoản -> email -> ID mặc định) để hiển thị tên con trỏ chuột
        const currentUserName = socket.request.session?.user?.name
            || socket.request.session?.user?.username
            || socket.request.session?.user?.email
            || `User ${currentUserIdString?.slice(-4) || 'Unknown'}`;

        // Lắng nghe khi một user mở trang mindmap và tham gia (Join) vào phòng chỉnh sửa mindmap đó
        socket.on('joinMindmap', (data) => {
            if (!currentUserIdString || !data?.mindmapId) return;
            const { mindmapId } = data;
            const roomName = `mindmap:${mindmapId}`; // Tên room duy nhất cho mindmap này

            // Cho socket hiện tại gia nhập vào Room của Socket.IO
            socket.join(roomName);
            console.log(`🗺️ User ${currentUserIdString} joined mindmap room: ${roomName}`);

            // Khởi tạo phòng chỉnh sửa trong bộ nhớ RAM (Map `mindmapRooms`) nếu chưa tồn tại phòng này
            if (!mindmapRooms.has(mindmapId)) {
                mindmapRooms.set(mindmapId, new Map());
            }

            // Lưu trữ/Cập nhật thông tin của user hiện tại vào danh sách đang chỉnh sửa mindmap này
            mindmapRooms.get(mindmapId).set(currentUserIdString, {
                id: currentUserIdString,
                name: currentUserName,
                socketId: socket.id,
                cursor: null, // Ban đầu vị trí chuột trên canvas là null (chưa di chuyển chuột)
            });

            // Đánh dấu các mindmap mà socket này đã tham gia để dọn dẹp khi mất kết nối đột ngột
            if (!socket._joinedMindmaps) socket._joinedMindmaps = new Set();
            socket._joinedMindmaps.add(mindmapId);

            // Chuyển đổi danh sách collaborators đang ở trong phòng thành một mảng và gửi cho tất cả người dùng trong phòng
            const usersInRoom = Array.from(mindmapRooms.get(mindmapId).values());
            io.to(roomName).emit('mindmapCollaborators', { users: usersInRoom });
        });

        // Lắng nghe sự kiện chủ động rời khỏi trang chỉnh sửa mindmap (Leave) từ client
        socket.on('leaveMindmap', (data) => {
            if (!currentUserIdString || !data?.mindmapId) return;
            const { mindmapId } = data;
            const roomName = `mindmap:${mindmapId}`;

            // Cho socket rời khỏi Room Socket.IO
            socket.leave(roomName);
            console.log(`🗺️ User ${currentUserIdString} left mindmap room: ${roomName}`);

            // Xóa thông tin user này khỏi danh sách cộng tác viên của mindmap trong RAM
            if (mindmapRooms.has(mindmapId)) {
                mindmapRooms.get(mindmapId).delete(currentUserIdString);

                // Nếu phòng trống hoàn toàn (không còn ai chỉnh sửa), xoá phòng khỏi RAM để giải phóng bộ nhớ
                if (mindmapRooms.get(mindmapId).size === 0) {
                    mindmapRooms.delete(mindmapId);
                } else {
                    // Nếu vẫn còn người khác, gửi danh sách cộng tác viên mới cập nhật cho các thành viên còn lại
                    const usersInRoom = Array.from(mindmapRooms.get(mindmapId).values());
                    io.to(roomName).emit('mindmapCollaborators', { users: usersInRoom });
                }
            }

            // Xoá thông tin theo dõi phòng trên đối tượng socket hiện tại
            if (socket._joinedMindmaps) socket._joinedMindmaps.delete(mindmapId);
        });

        // Lắng nghe sự kiện cập nhật/thay đổi danh sách Nodes (các nút nội dung sơ đồ tư duy)
        socket.on('mindmapNodesChange', (data) => {
            if (!currentUserIdString || !data?.mindmapId || !Array.isArray(data.nodes)) return;
            const roomName = `mindmap:${data.mindmapId}`;

            // Gửi cấu trúc Nodes mới đến toàn bộ những người dùng khác trong phòng chỉnh sửa (loại trừ người gửi)
            socket.to(roomName).emit('mindmapNodesChanged', {
                userId: currentUserIdString,
                userName: currentUserName,
                nodes: data.nodes,
            });
        });

        // Lắng nghe sự kiện cập nhật/thay đổi danh sách Edges (các đường liên kết kết nối giữa các nút sơ đồ)
        socket.on('mindmapEdgesChange', (data) => {
            if (!currentUserIdString || !data?.mindmapId || !Array.isArray(data.edges)) return;
            const roomName = `mindmap:${data.mindmapId}`;

            // Gửi cấu trúc Edges mới đến toàn bộ những người dùng khác trong phòng chỉnh sửa (loại trừ người gửi)
            socket.to(roomName).emit('mindmapEdgesChanged', {
                userId: currentUserIdString,
                userName: currentUserName,
                edges: data.edges,
            });
        });

        // Lắng nghe chuyển động di chuột trên Canvas vẽ mindmap của một cộng tác viên
        socket.on('mindmapCursorMove', (data) => {
            if (!currentUserIdString || !data?.mindmapId || !data?.cursor) return;
            const roomName = `mindmap:${data.mindmapId}`;

            // Cập nhật vị trí toạ độ chuột x, y mới của user này vào RAM
            if (mindmapRooms.has(data.mindmapId)) {
                const userInfo = mindmapRooms.get(data.mindmapId).get(currentUserIdString);
                if (userInfo) userInfo.cursor = data.cursor; // cursor: { x, y }
            }

            // Phát vị trí chuột mới cho những người khác vẽ con trỏ chuột ảo tương ứng trên màn hình của họ
            socket.to(roomName).emit('mindmapCursorMoved', {
                userId: currentUserIdString,
                userName: currentUserName,
                cursor: data.cursor,
            });
        });

        // --- 4. Xử lý khi người dùng mất kết nối hoặc đóng trình duyệt ---
        socket.on('disconnect', async (reason) => {
            console.log(`🔌 User disconnected: ${socket.id}. UserID: ${currentUserIdString}. Reason: ${reason}`);

            if (currentUserIdString) {
                // Xóa trạng thái online của user khỏi Map `onlineUsers`
                onlineUsers.delete(currentUserIdString);
                console.log(`🔴 User offline: ${currentUserIdString}. Total online: ${onlineUsers.size}`);

                // === CLEANUP PHÒNG MINDMAP ===
                // Nếu người dùng đóng trình duyệt đột ngột khi đang chỉnh sửa mindmap:
                if (socket._joinedMindmaps) {
                    for (const mindmapId of socket._joinedMindmaps) {
                        const roomName = `mindmap:${mindmapId}`;

                        if (mindmapRooms.has(mindmapId)) {
                            // Xóa user khỏi phòng mindmap
                            mindmapRooms.get(mindmapId).delete(currentUserIdString);

                            // Nếu phòng không còn ai, xoá khỏi RAM
                            if (mindmapRooms.get(mindmapId).size === 0) {
                                mindmapRooms.delete(mindmapId);
                            } else {
                                // Gửi danh sách collaborators mới cập nhật cho những người còn lại
                                const usersInRoom = Array.from(mindmapRooms.get(mindmapId).values());
                                io.to(roomName).emit('mindmapCollaborators', { users: usersInRoom });
                            }
                        }
                    }
                    // Giải phóng tập hợp phòng đã tham gia trên socket
                    socket._joinedMindmaps.clear();
                }

                // Lấy danh sách bạn bè của user này để báo cho họ biết người này đã offline
                const friendObjectIdsOnDisconnect = await getFriendsList(currentUserId);
                const friendIdsOnDisconnect = friendObjectIdsOnDisconnect.map(id => id.toString());

                // Gửi sự kiện 'user offline' đến tất cả bạn bè đang online
                friendIdsOnDisconnect.forEach(friendId => {
                    const friendSocketId = onlineUsers.get(friendId);
                    if (friendSocketId) {
                        io.to(friendSocketId).emit('user offline', { userId: currentUserIdString });
                        console.log(`   📢 Notified friend ${friendId} (socket ${friendSocketId}) that ${currentUserIdString} is offline.`);
                    }
                });
            }

            // Giải phóng bộ nhớ biến cục bộ
            currentUserId = null;
            currentUserIdString = null;
        });

    }); // Kết thúc sự kiện io.on('connection')
}; // Kết thúc xuất module handler