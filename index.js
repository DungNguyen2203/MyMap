// File: index.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const { MongoClient } = require('mongodb');
const MongoStore = require('connect-mongo');
const http = require('http');
const { Server } = require("socket.io");
// const cors = require('cors'); // Bạn có thể xóa nếu không cần CORS cho Express khi chạy chung cổng
const path = require('path'); // Đảm bảo 'path' được require ở đầu

// ====== Routes ======
const authRoutes = require('./routes/authRoutes.js');
const documentRoutes = require('./routes/document');
const dashboardRoutes = require('./routes/dashboardRoutes.js');
const profileRoutes = require('./routes/profileRoutes.js');
const mindmapRoutes = require('./routes/mindmap');
const friendRoutes = require('./routes/friendRoutes.js');

// ====== Utils ======
const { startTrashCleanupJob } = require('./utils/trashCleanup.js');

const reactBuildDir = path.join(__dirname, 'front-end', 'build');
const reactIndexFile = path.join(reactBuildDir, 'index.html');

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("❌ Lỗi: MONGO_URI chưa được thiết lập trong file .env");
  process.exit(1);
}

const client = new MongoClient(uri);

async function startServer() {
  try {
    await client.connect();
    console.log("✅ Successfully connected to MongoDB Atlas!");
    console.log("✅ DB Connected!"); // Log 1

    // === KHỞI TẠO DATABASE ===
    const usersDb = client.db('users_identity');
    const mindmapsDb = client.db('mindmaps');
    const chatDb = client.db('chat_storage');

    const app = express();
    app.set('trust proxy', 1);
    // === BỎ HOẶC SỬA CORS CHO PHÙ HỢP KHI CHẠY 1 CỔNG ===
    // app.use(cors({
    //   origin: 'http://localhost:3001', // Không cần thiết khi chạy cùng cổng
    //   credentials: true,
    //   methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    //   allowedHeaders: ['Content-Type', 'Authorization']
    // }));

    const PORT = process.env.PORT || 3000;
    const server = http.createServer(app);

    // === SOCKET.IO VẪN CẦN CORS ===
    const io = new Server(server, {
      cors: {
        origin: "*", // Hoặc "http://localhost:3000" khi deploy
        methods: ["GET", "POST"]
      }
    });

    // === LƯU DATABASE VÀO APP.LOCALS ===
    app.locals.usersDb = usersDb;
    app.locals.mindmapsDb = mindmapsDb;
    app.locals.chatDb = chatDb;
    console.log("✅ App & Locals Initialized!"); // Log 2

    // === Cấu hình middleware cơ bản ===
    app.set('view engine', 'pug');
    app.set('views', 'views');
    // Phục vụ file tĩnh (CSS, JS) cho các trang Pug TRƯỚC TIÊN
    app.use(express.static('public'));
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ limit: '50mb', extended: true }));
    console.log("✅ Basic Middleware Set!"); // Log 3

    // === Cấu hình Session Middleware ===
    const sessionMiddleware = session({
      secret: process.env.SESSION_SECRET || 'my_session_secret',
      resave: false, // Bắt buộc
      saveUninitialized: false, // Bắt buộc
      store: MongoStore.create({
        client: client,
        dbName: 'users_identity',
        collectionName: 'sessions',
        ttl: 30 * 24 * 60 * 60 // 30 days
      }),
      cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
      }
    });
    app.use(sessionMiddleware);
    io.engine.use(sessionMiddleware); // Chia sẻ session cho Socket.IO

    app.use(flash()); // Middleware cho flash messages

    // === Middleware truyền DB và locals ===
    app.use((req, res, next) => {
      req.usersDb = req.app.locals.usersDb;
      req.mindmapsDb = req.app.locals.mindmapsDb;
      req.chatDb = req.app.locals.chatDb;
      res.locals.user = req.session.user;
      res.locals.success_msg = req.flash('success_msg');
      res.locals.error_msg = req.flash('error_msg');
      next();
    });
    console.log("✅ Session & Flash Middleware Set!"); // Log 4

    // === KHỞI TẠO SOCKET HANDLER ===
    require('./socketHandler.js')(io, usersDb, chatDb);
    console.log('✅ Socket Handler Initialized!'); // Log 5

    // === KHỞI ĐỘNG CRON JOB TỰ ĐỘNG DỌN THÙNG RÁC ===
    startTrashCleanupJob(mindmapsDb);
    console.log('✅ Trash Cleanup Job Scheduled!');

    // ==========================================================
    // === ✨ THỨ TỰ ROUTE MỚI ĐỂ ƯU TIÊN PUG ✨ ===
    // ==========================================================

    // === ƯU TIÊN 1: Đăng ký các API Routes và Pug Routes (dashboard, profile...) ===
    // Express sẽ kiểm tra các route này trước tiên
    const adminRoutes = require('./routes/adminRoutes.js');
    app.use('/admin', adminRoutes);
    app.use('/friends', friendRoutes(usersDb));
    app.use('/dashboard', dashboardRoutes); // Xử lý các route bắt đầu bằng /dashboard
    app.use('/profile', profileRoutes);
    app.use('/upload', documentRoutes);
    app.use('/mindmaps', mindmapRoutes); // API endpoints cho mindmap (vd: /mindmaps/json/:id)
    app.use('/', authRoutes);          // Xử lý /login, /register, /home (nếu có), /logout...
    console.log("✅ API & Pug Routes Registered!"); // Log 6

    // === ƯU TIÊN 2: Route chính '/', chuyển hướng dựa trên đăng nhập ===
    // Phải đặt SAU `authRoutes` để không ghi đè /login, /register...
    app.get('/', (req, res) => {
      if (req.session.user) {
        console.log("➡️ User logged in, redirecting to /dashboard");
        res.redirect('/dashboard');
      } else {
        // Giả sử authRoutes xử lý '/login' hoặc '/home' khi chưa đăng nhập
        // Hoặc bạn có thể render trang chủ Pug trực tiếp ở đây nếu muốn
        console.log("➡️ User not logged in, redirecting to /login");
        res.redirect('/login');
      }
    });

    // === ƯU TIÊN 3: Route đặc biệt để phục vụ React App ===
    // Phục vụ các route React Router bằng cùng file index.html
    app.get(['/import/:id', '/editor/:id', '/editor/:id/:ownerId', '/cyto/:id'], (req, res, next) => {
      console.log(`➡️ Serving React App for ${req.originalUrl}`);
      res.sendFile(reactIndexFile, (err) => {
        if (err) {
          return next(err);
        }
      });
    });
    console.log("✅ React Specific Route Set!"); // Log 7a

    // === ƯU TIÊN 4: Phục vụ các file tĩnh (CSS, JS) từ thư mục build của React ===
    // Chỉ xử lý nếu request không khớp các route trên VÀ là file trong thư mục build
    app.use(express.static(reactBuildDir));
    console.log("✅ React Static Files Serving Set!"); // Log 7b


    // === ƯU TIÊN 5: Xử lý lỗi 404 (đặt gần cuối) ===
    // Route này sẽ bắt tất cả các request không khớp với bất kỳ route nào ở trên
    app.use((req, res, next) => {
        // Tùy chọn: Nếu bạn muốn React xử lý các route khác (vd: client-side routing)
        // bạn có thể thêm logic kiểm tra ở đây và gửi index.html của React
        // if (req.method === 'GET' && !req.originalUrl.startsWith('/api') && !req.path.includes('.')) {
        //   console.log(`➡️ Serving React App index.html as fallback for ${req.originalUrl}`);
        //   return res.sendFile(reactIndexFile);
        // }

        // Nếu không, trả về trang 404 Pug
        console.log(`⚠️ 404 Not Found: ${req.method} ${req.originalUrl}`);
        res.status(404).render('404', {
            pageTitle: 'Lỗi 404',
            user: req.session.user
        });
    });
    console.log("✅ Final Routes & Error Handlers Set!"); // Log 8


    // === Xử lý lỗi 500 (đặt cuối cùng) ===
    app.use((error, req, res, next) => {
      console.error('Server Error:', error);
      if (res.headersSent) {
        return next(error);
      }

      const errorMessage = process.env.NODE_ENV === 'production'
        ? null
        : (error && error.message ? error.message : 'Unknown server error');

      res.status(500);
      try {
        return res.render('500', {
          pageTitle: 'Lỗi Server',
          user: req.session.user,
          errorMessage,
        });
      } catch (renderError) {
        console.error('Render 500 view failed:', renderError);
        if (req.originalUrl && req.originalUrl.startsWith('/api')) {
          return res.json({ success: false, error: 'Lỗi server nội bộ.' });
        }
        return res.send('Internal Server Error');
      }
    });

    // === Khởi động server ===
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is listening on port ${PORT}`); 
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
});

  } catch (error) {
    console.error("❌ Failed to connect to the database or start server.", error);
    process.exit(1);
  }
}

startServer();