# 🌳 MindTree — Web Vẽ Sơ Đồ Tư Duy Hỗ Trợ Học Tập

> Nền tảng học tập thế hệ mới: Tự động tạo sơ đồ tư duy từ tài liệu bằng AI, cộng tác thời gian thực qua Socket.IO, và kết nối bạn bè qua hệ thống chat.

**Môn:** Nhập môn Công nghệ phần mềm | **Lớp:** SE104.Q29 - Nhóm 12

| Thành viên | MSSV | Vai trò chính |
|---|---|---|
| Trần Đình Duy | 24520398 | Frontend React Editor & Socket.IO Collaboration |
| Trương Đình Việt Dũng | 24520352 | Backend, Auth, Database Design, Báo cáo |
| Nguyễn Trung Dũng | 24520343 | AI Engine, Admin Panel, Friends & Chat |

---

## 🏗️ Kiến trúc tổng thể

```
MindTree (Hybrid Monolith)
├── Backend: Node.js + Express 5 + MongoDB (SSR với Pug)
├── Frontend: React 19 SPA (ReactFlow) — phục vụ tại /editor/:id
└── Real-time: Socket.IO (chạy chung cổng với Express)
```

Hệ thống sử dụng kiến trúc **Hybrid Monolith**: các trang quản lý (dashboard, login, admin…) được render phía server bằng **Pug** để tối ưu tốc độ và bảo mật; trong khi trình soạn thảo sơ đồ tư duy là một **React SPA** độc lập được bundle và nhúng vào.

---

## 📁 Cấu trúc thư mục & Các file quan trọng

### 📌 Root — Khởi động & Điều phối

---

#### `index.js` — **Entry point chính của toàn bộ server**
File khởi động và điều phối mọi thứ:
- Kết nối **MongoDB Atlas** và khởi tạo 3 database: `users_identity`, `mindmaps`, `chat_storage`.
- Tạo server **HTTP + Socket.IO** dùng chung một cổng.
- Đăng ký **session middleware** (lưu phiên trên MongoDB qua `connect-mongo`).
- **Mount toàn bộ Router** theo thứ tự ưu tiên đúng: Admin → Dashboard → Profile → Upload → Mindmaps → Auth → React SPA.
- Khởi động **Cron Job** tự động dọn thùng rác mỗi 24 giờ.

---

#### `socketHandler.js` — **Toàn bộ logic thời gian thực**
File quan trọng nhất của phần Real-time, xử lý:
- **Xác thực người dùng** kết nối Socket dựa trên Session chung với Express (không cần token riêng).
- **Trạng thái Online/Offline**: Dùng `Map<userId, socketId>` trong RAM để theo dõi và phát sự kiện `user online/offline` đến bạn bè.
- **Mindmap Collaboration**: Quản lý các "phòng vẽ" (`mindmapRooms`), đồng bộ `nodes`, `edges`, và tọa độ con trỏ chuột của từng cộng tác viên.
- **Chat thời gian thực**: Lưu tin nhắn vào MongoDB, phát sự kiện `receiveMessage` đến người nhận nếu đang online, tự động tải lịch sử khi người dùng mở khung chat.

---

### 📌 `routes/` — Định nghĩa các API Endpoint

---

#### `routes/document.js` — **Lõi xử lý AI Engine (file lớn nhất, ~1500 dòng)**
File phức tạp và quan trọng nhất của hệ thống, chứa toàn bộ pipeline phân tích tài liệu bằng AI:

- **Cascade API 4 tầng dự phòng:** Tầng 1 (Vercel AI SDK + Gemini Flash) → Tầng 2 (Gemini File API Vision) → Tầng 3 (Groq + Llama) → Tầng 4 (OpenRouter với Gemini Flash Lite / Qwen / DeepSeek).
- **Structured Output với Zod:** Định nghĩa `MindmapDocumentSchema` ép buộc AI trả về JSON đúng cấu trúc cây `{mainTopic, summary, subTopics[]}`.
- **SSE Streaming:** Mở luồng `text/event-stream`, phát tiến trình và từng phần JSON về client theo thời gian thực. Client nhận bằng `ReadableStream API`.
- **Cache 3 tầng:** Tính hash SHA-256 của file → kiểm tra **Redis/Upstash** (nhanh nhất) → **MongoDB** (bền vững) → **Memory Map** (in-process). Nếu cache hit, trả về kết quả ngay lập tức.
- **Concurrency Control:** Dùng `p-limit` để giới hạn tối đa 3 tác vụ AI chạy song song, chống quá tải.
- **Xử lý đa định dạng:** PDF (pdf-parse), DOCX (mammoth), TXT, Hình ảnh (Gemini Vision API).

> **Route chính:** `POST /upload/summarize-stream`

---

#### `routes/mindmap.js` — **API thao tác với sơ đồ tư duy**
Cung cấp các REST API cốt lõi:
- `GET /:id/json` — Tải toàn bộ `nodes` và `edges` của một sơ đồ từ MongoDB.
- `PATCH /:id/save` — Lưu tự động (được gọi sau debounce 1.5s từ Editor).
- `GET /shared/:ownerId/:id/json` — Cho phép cộng tác viên truy cập sơ đồ của người khác qua link chia sẻ.
- `POST /create` — Tạo sơ đồ rỗng mới, trả về `mindmapId` để điều hướng vào Editor.

---

#### `routes/authRoutes.js` — **Xác thực người dùng**
Điều phối đăng ký, đăng nhập, đăng xuất và luồng đặt lại mật khẩu qua email.

#### `routes/dashboardRoutes.js` — **Quản lý Dashboard & Thư mục**
Xử lý các trang SSR (Pug) và API cho thư mục, thùng rác, tìm kiếm và phân trang.

#### `routes/friendRoutes.js` — **Hệ thống bạn bè**
Gửi/chấp nhận/từ chối/hủy lời mời kết bạn, lấy danh sách bạn bè.

#### `routes/adminRoutes.js` — **Phân hệ quản trị**
Mount các route Admin (yêu cầu quyền `admin`): xem thống kê, khóa/mở tài khoản, kiểm duyệt tài liệu.

---

### 📌 `controllers/` — Logic xử lý nghiệp vụ

---

#### `controllers/dashboardController.js` — **Controller lớn nhất phía SSR**
Xử lý toàn bộ nghiệp vụ Dashboard: phân trang sơ đồ, xóa mềm (soft delete), khôi phục, dọn thùng rác, tạo/đổi tên/xóa thư mục, di chuyển sơ đồ vào thư mục, tìm kiếm gợi ý.

#### `controllers/authController.js` — **Xác thực & Mật khẩu**
Đăng ký (hash bcrypt), đăng nhập (so sánh hash), quên mật khẩu (tạo resetToken có hạn 10 phút, gửi email qua Nodemailer), đặt lại mật khẩu.

#### `controllers/mindmapController.js` — **Nghiệp vụ Mindmap**
Tạo mindmap mới, lưu tự động (debounce), cập nhật tiêu đề, xóa mềm mindmap, tạo thumbnail preview SVG để hiển thị trên Dashboard.

#### `controllers/adminController.js` — **Nghiệp vụ Admin**
Thống kê tổng người dùng / mindmaps / tài liệu, render danh sách người dùng, khóa/mở khóa tài khoản (xóa session ngay lập tức), xóa tài liệu vi phạm.

#### `controllers/profileController.js` — **Hồ sơ cá nhân**
Hiển thị thông tin hồ sơ, cập nhật thông tin, upload và cập nhật ảnh đại diện lên Cloudinary, đổi mật khẩu.

---

### 📌 `middlewares/` — Middleware bảo mật & tiện ích

---

#### `middlewares/middlewares.js` — **Middleware xác thực chính**
Hàm `checkLoggedIn`: kiểm tra session, tra cứu user trong DB, xác nhận trạng thái `active` (không bị khóa). Bảo vệ tất cả route yêu cầu đăng nhập.

#### `middlewares/rateLimiter.js` — **Chống brute-force**
Giới hạn số lần gọi API đăng nhập / quên mật khẩu trong một khoảng thời gian, bảo vệ khỏi tấn công dò mật khẩu.

#### `middlewares/documentUpload.js` — **Xử lý upload file tài liệu**
Cấu hình Multer: lưu file tạm vào `temp/uploads/`, giới hạn dung lượng (cấu hình qua `.env`), lọc loại MIME được phép.

#### `middlewares/avatarUpload.js` — **Xử lý upload ảnh đại diện**
Cấu hình Multer + Cloudinary Storage để upload ảnh đại diện thẳng lên cloud.

#### `middlewares/noCache.js` — **Vô hiệu hóa cache trình duyệt**
Gắn header `Cache-Control: no-store` cho các trang dashboard động, tránh trình duyệt hiển thị dữ liệu cũ khi nhấn nút Back.

---

### 📌 `utils/` — Các hàm tiện ích dùng chung

---

#### `utils/documentCache.js` — **Khởi tạo & Export đối tượng Cache**
Khởi tạo kết nối Redis/Upstash (hoặc fallback về in-memory nếu không có Redis), export `documentCache` và các hằng số `CACHE_PREFIX`, `CACHE_TTL_SECONDS` để `document.js` sử dụng.

#### `utils/mindmapPreview.js` — **Tạo ảnh thumbnail SVG**
Phân tích cấu trúc `nodes`/`edges` của sơ đồ để vẽ một hình ảnh SVG mini, hiển thị trên thẻ sơ đồ ở Dashboard mà không cần load toàn bộ ReactFlow.

#### `utils/trashCleanup.js` — **Cron Job tự dọn thùng rác**
Chạy định kỳ mỗi 24 giờ, quét toàn bộ collection của mỗi người dùng và `deleteMany` những sơ đồ đã ở thùng rác quá 30 ngày.

#### `utils/sendEmail.js` — **Gửi email**
Wrapper dùng Nodemailer để gửi email khôi phục mật khẩu (với resetToken được nhúng trong URL).

---

### 📌 `models/` — Giao tiếp với MongoDB

---

#### `models/userModel.js` — **Model người dùng chính**
Tập hợp các hàm truy vấn MongoDB native cho collection `users`: tìm theo email/username/ID/resetToken, tạo user mới, cập nhật avatar, cập nhật trạng thái khóa/mở, cập nhật vai trò.

---

### 📌 `front-end/src/` — React SPA (Trình soạn thảo)

---

#### `front-end/src/App.jsx` — **Root Component của React SPA**
Điểm vào của toàn bộ giao diện Editor. Khởi tạo ReactFlow canvas, xử lý kéo thả, kết nối debounce save, điều phối các toolbar và chế độ vẽ tự do.

#### `front-end/src/store/store.js` — **Zustand Global Store**
Trung tâm quản lý toàn bộ trạng thái của Editor: `nodes`, `edges`, lịch sử Undo/Redo (tích hợp middleware `zundo`), danh sách node được chọn, chế độ vẽ tay, Dark Mode.

#### `front-end/src/components/CustomNode.jsx` — **Component nút sơ đồ tư duy**
Giao diện của mỗi node trên canvas: hiển thị tiêu đề và nội dung (AI summary), cho phép **double-click để chỉnh sửa** cả tiêu đề lẫn nội dung (dùng `textarea` với class `nodrag` để tránh xung đột với ReactFlow).

#### `front-end/src/components/CustomNodeToolbar.jsx` — **Thanh công cụ nổi (Floating Toolbar)**
Toolbar hiện ra khi chọn một node: thêm node con, xóa, đổi màu nền, đổi font, đổi màu viền, sao chép định dạng (Format Painter).

#### `front-end/src/components/VerticalToolbar.jsx` — **Thanh công cụ dọc bên trái**
Các nút toàn cục: Lưu vào DB, Xuất PNG, Thêm node gốc, Undo/Redo, Copy link chia sẻ cộng tác.

#### `front-end/src/hooks/useCollaboration.js` — **Hook cộng tác thời gian thực**
Quản lý toàn bộ vòng đời kết nối Socket.IO cho tính năng collaboration: tham gia/rời phòng, phát và nhận sự kiện thay đổi nodes/edges, cập nhật vị trí con trỏ chuột của người khác lên canvas.

#### `front-end/src/utils/markdownToMindmap.js` — **Chuyển đổi JSON AI → ReactFlow**
Nhận kết quả JSON từ AI Engine (dạng cây `{mainTopic, subTopics, children}`), chuyển đổi thành mảng `nodes` và `edges` theo định dạng của ReactFlow, đồng thời tính toán tọa độ layout tự động (tất cả nhánh mở rộng sang **bên phải**).

#### `front-end/src/services/socket.js` — **Singleton kết nối Socket.IO**
Tạo và export một instance Socket.IO client duy nhất được tái sử dụng xuyên suốt toàn bộ ứng dụng React.

#### `front-end/src/components/DrawAreaNode.jsx` & `DrawAreaToolbar.jsx`
Tính năng **vẽ tay tự do (Freehand Drawing)** trên canvas: theo dõi sự kiện chuột để vẽ các đường nét và lưu lại dưới dạng SVG path.

#### `front-end/src/App.scss` — **Toàn bộ CSS của Editor**
File style duy nhất cho React SPA: định nghĩa giao diện Dark Mode, style cho `CustomNode`, Toolbar, animation và các hiệu ứng tương tác.

---

### 📌 File cấu hình quan trọng

---

#### `.env` — **Biến môi trường (KHÔNG commit)**
Chứa tất cả thông tin nhạy cảm: `MONGO_URI`, `GEMINI_API_KEYS` (nhiều key cách nhau bằng dấu phẩy), `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `REDIS_URL`, `SESSION_SECRET`, `CLOUDINARY_*`.

#### `package.json` (Backend) — **Dependencies chính đáng chú ý**
- `@google/genai` + `ai` + `@ai-sdk/google` — Gemini AI SDK
- `zod` — Schema validation cho output của AI
- `p-limit` — Giới hạn concurrency
- `redis` — Kết nối cache
- `socket.io` — WebSocket
- `express` `^5.1.0` — Tự động bắt lỗi async/await
- `mammoth`, `pdf-parse` — Đọc DOCX và PDF

#### `package.json` (Frontend) — **Dependencies chính đáng chú ý**
- `@xyflow/react` — ReactFlow (canvas vẽ sơ đồ)
- `zustand` + `zundo` — State management + Undo/Redo
- `socket.io-client` — Kết nối real-time
- `html-to-image` — Xuất sơ đồ sang PNG

---

## 🚀 Khởi động dự án

```bash
# 1. Cài dependencies Backend
npm install

# 2. Cài dependencies Frontend
cd front-end && npm install && cd ..

# 3. Build Frontend (tạo thư mục front-end/build)
cd front-end && npm run build && cd ..

# 4. Tạo file .env và điền đầy đủ các biến môi trường

# 5. Khởi động server
npm run dev       # Development (nodemon)
npm start         # Production
```

Server mặc định chạy tại: `http://localhost:3000`

---

## 🗄️ Thiết kế Database (MongoDB)

| Database | Collection | Mô tả |
|---|---|---|
| `users_identity` | `users` | Thông tin tài khoản, mật khẩu bcrypt, avatar, role, status |
| `users_identity` | `friends` | Quan hệ kết bạn (pending / accepted) |
| `users_identity` | `documents` | Lịch sử tài liệu đã upload (cho Admin kiểm duyệt) |
| `users_identity` | `sessions` | Session người dùng (connect-mongo) |
| `mindmaps` | `folders` | Thư mục của người dùng |
| `mindmaps` | `[user_id]` | Mỗi user có một collection riêng lưu các sơ đồ tư duy |
| `chat_storage` | `messages` | Lịch sử tin nhắn chat giữa các người dùng |
