// File: controllers/authController.js
const userModel = require('../models/userModel.js');
const { ObjectId } = require('mongodb');
const crypto = require('crypto'); 
const sendEmail = require('../utils/sendEmail.js');
const { incrementFail, resetAttempts } = require('../middlewares/loginRateLimiter');
const bcrypt = require('bcrypt');
// Hiển thị trang đăng ký
exports.getRegisterPage = (req, res) => {
    res.render('register', { pageTitle: 'Đăng ký' });
};

// Hiển thị trang đăng nhập
exports.getLoginPage = (req, res) => {
    res.render('login', { pageTitle: 'Đăng nhập' });
};

// Xử lý đăng ký
exports.postRegister = async (req, res) => {
    try {
        const { email, password, username } = req.body;
        // === THAY ĐỔI: Lấy 2 db từ app.locals ===
        const usersDb = req.app.locals.usersDb;
        const mindmapsDb = req.app.locals.mindmapsDb;
        // =======================================

        if (!email || !password || !username) {
            req.flash('error_msg', 'Vui lòng điền đầy đủ thông tin!');
            return res.redirect('/register');
        }

        // Tìm user trong usersDb
        const existingUser = await userModel.findUserByEmailOrUsername(usersDb, email, username);
        if (existingUser) {
            req.flash('error_msg', 'Email hoặc Username đã tồn tại!');
            return res.redirect('/register');
        }

        // Hash password với bcrypt
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const newUser = {
            email: email.toLowerCase().trim(),
            username: username.toLowerCase().trim(),
            password: hashedPassword,
            avatar: "https://mediamart.vn/images/uploads/2022/713193b6-a8b3-471d-ab04-c38dae2c1da4.jpg",
            createdAt: new Date(),
            updatedAt: new Date()
        };

        // Tạo user trong usersDb
        const result = await userModel.createUser(usersDb, newUser);
        const newUserIdString = result.insertedId.toString();
        
        // === LOGIC MỚI: Tạo collection mindmap cho user ===
        try {
            // Dùng _id của user làm tên collection mới
            await mindmapsDb.createCollection(newUserIdString);
            console.log(`✅ Đã tạo collection mindmap mới: ${newUserIdString}`);
        } catch (dbError) {
            console.error(`❌ Lỗi khi tạo collection mindmap cho user ${newUserIdString}:`, dbError);
            // Cần xử lý lỗi này, ví dụ: xóa user vừa tạo để đồng bộ
        }
        // ================================================

        req.session.user = {
            _id: result.insertedId,
            name: newUser.username,
            username: newUser.username,
            email: newUser.email,
            avatar: null
        };

        req.flash('success_msg', 'Đăng ký thành công!');
        res.redirect('/dashboard');

    } catch (err) {
        console.error('❌ Lỗi đăng ký:', err);
        req.flash('error_msg', 'Đã xảy ra lỗi khi đăng ký!');
        res.redirect('/register');
    }
};
// Xử lý đăng nhập
exports.postLogin = async (req, res) => {
  const { email, password } = req.body;
  try {
    const usersDb = req.app.locals.usersDb;

    if (!email || !password) {
      req.flash('error_msg', 'Vui lòng điền đầy đủ email và mật khẩu!');
      return res.redirect('/login');
    }

    const user = await userModel.findUserByEmail(usersDb, email);

    if (!user) {
      try {
        await incrementFail(email);
      } catch (e) {
        console.error('❌ Lỗi tăng bộ đếm login sai:', e);
      }
      req.flash('error_msg', 'Email hoặc mật khẩu không chính xác!');
      return res.redirect('/login');
    }

    // Kiểm tra password: hỗ trợ cả plaintext (legacy) và hashed
    let isPasswordValid = false;
    let needsMigration = false;

    // Kiểm tra xem password đã được hash chưa (bcrypt hash bắt đầu bằng $2a$, $2b$, $2y$)
    const isHashed = /^\$2[aby]\$/.test(user.password);

    if (isHashed) {
      // Password đã hash, dùng bcrypt.compare
      isPasswordValid = await bcrypt.compare(password, user.password);
    } else {
      // Password còn plaintext (user cũ), so sánh trực tiếp
      isPasswordValid = (user.password === password);
      needsMigration = isPasswordValid; // Nếu đúng thì cần migrate
    }

    if (!isPasswordValid) {
      try {
        await incrementFail(email);
      } catch (e) {
        console.error('❌ Lỗi tăng bộ đếm login sai:', e);
      }
      req.flash('error_msg', 'Email hoặc mật khẩu không chính xác!');
      return res.redirect('/login');
    }

    // Nếu password đúng nhưng chưa hash, tự động migrate
    if (needsMigration) {
      try {
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        await usersDb.collection('users').updateOne(
          { _id: user._id },
          { 
            $set: { 
              password: hashedPassword,
              updatedAt: new Date()
            } 
          }
        );
        console.log(`🔄 Đã tự động migrate password cho user: ${user.email}`);
      } catch (migrateErr) {
        console.error('⚠️ Lỗi khi migrate password:', migrateErr);
        // Không chặn login nếu migrate thất bại
      }
    }
        
    try {
      await resetAttempts(email);
    } catch (e) {
      console.error('❌ Lỗi reset bộ đếm login sai:', e);
    }

    req.session.user = {
      _id: user._id,
      email: user.email,
      username: user.username,
      name: user.name || user.username,
      avatar: user.avatar || null
    };

    res.redirect('/dashboard');

  } catch (err) {
    console.error('❌ Lỗi đăng nhập:', err);
    req.flash('error_msg', 'Đã xảy ra lỗi khi đăng nhập!');
    res.redirect('/login');
  }
};

// Đăng xuất
exports.logout = (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('❌ Lỗi khi đăng xuất:', err);
        }
        res.redirect('/');
    });
};

// [GET] /forgot-password
exports.getForgotPasswordPage = (req, res) => {
  res.render('forgot-password', { pageTitle: 'Quên mật khẩu' });
};

// [POST] /forgot-password
exports.postForgotPassword = async (req, res) => {
  const { email } = req.body;
  const usersDb = req.app.locals.usersDb;

  try {
    const user = await userModel.findUserByEmail(usersDb, email);

    // [QUAN TRỌNG] Ngay cả khi không tìm thấy user,
    // chúng ta vẫn báo thành công để tránh kẻ xấu dò email.
    if (!user) {
      req.flash('success_msg', 'Nếu email tồn tại, một liên kết khôi phục đã được gửi.');
      return res.redirect('/forgot-password');
    }

    // 1. Tạo token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    
    // 2. Đặt thời gian hết hạn (ví dụ: 10 phút)
    const resetPasswordExpires = new Date(Date.now() + 10 * 60 * 1000);

    // 3. Lưu token và thời hạn vào DB
    await usersDb.collection('users').updateOne(
      { _id: user._id },
      {
        $set: {
          resetPasswordToken: resetPasswordToken,
          resetPasswordExpires: resetPasswordExpires,
        },
      }
    );

    // 4. Gửi email cho người dùng
    const resetUrl = `${process.env.APP_URL}/reset-password/${resetPasswordToken}`;
    
    const htmlMessage = `
      <p>Bạn nhận được email này vì bạn (hoặc ai đó) đã yêu cầu đặt lại mật khẩu cho tài khoản của bạn.</p>
      <p>Vui lòng nhấp vào liên kết sau hoặc sao chép và dán vào trình duyệt của bạn để hoàn tất quá trình (liên kết chỉ có hiệu lực trong 10 phút):</p>
      <a href="${resetUrl}" target="_blank">${resetUrl}</a>
      <p>Nếu bạn không yêu cầu điều này, vui lòng bỏ qua email này.</p>
    `;

    await sendEmail({
      email: user.email,
      subject: 'Yêu cầu đặt lại mật khẩu MindTree',
      html: htmlMessage,
    });

    req.flash('success_msg', 'Một liên kết khôi phục đã được gửi đến email của bạn.');
    res.redirect('/forgot-password');

  } catch (err) {
    console.error('❌ Lỗi postForgotPassword:', err);
    req.flash('error_msg', 'Đã xảy ra lỗi khi gửi email.');
    res.redirect('/forgot-password');
  }
};

// [GET] /reset-password/:token
exports.getResetPasswordPage = async (req, res) => {
  const { token } = req.params;
  const usersDb = req.app.locals.usersDb;

  try {
    // Tìm user bằng token và token CÒN HẠN
    const user = await userModel.findUserByResetToken(usersDb, token);

    if (!user) {
      req.flash('error_msg', 'Token không hợp lệ hoặc đã hết hạn.');
      return res.redirect('/forgot-password');
    }

    // Token hợp lệ, hiển thị trang reset
    res.render('reset-password', {
      pageTitle: 'Đặt lại mật khẩu',
      token: token,
    });

  } catch (err) {
    console.error('❌ Lỗi getResetPasswordPage:', err);
    req.flash('error_msg', 'Đã xảy ra lỗi.');
    res.redirect('/forgot-password');
  }
};

// [POST] /reset-password/:token
exports.postResetPassword = async (req, res) => {
  const { token } = req.params;
  const { password, confirmPassword } = req.body;
  const usersDb = req.app.locals.usersDb;

  if (password !== confirmPassword) {
    req.flash('error_msg', 'Mật khẩu xác nhận không khớp.');
    return res.redirect(`/reset-password/${token}`);
  }

  try {
    // 1. Tìm lại user (để chắc chắn)
    const user = await userModel.findUserByResetToken(usersDb, token);

    if (!user) {
      req.flash('error_msg', 'Token không hợp lệ hoặc đã hết hạn.');
      return res.redirect('/forgot-password');
    }

    // 2. Hash mật khẩu mới với bcrypt
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 3. Cập nhật mật khẩu mới và xóa token
    await usersDb.collection('users').updateOne(
      { _id: user._id },
      {
        $set: {
          password: hashedPassword,
          resetPasswordToken: undefined, // Xóa token
          resetPasswordExpires: undefined, // Xóa thời hạn
          updatedAt: new Date(),
        },
      }
    );

    req.flash('success_msg', 'Mật khẩu đã được cập nhật thành công! Vui lòng đăng nhập.');
    res.redirect('/login');

  } catch (err) {
    console.error('❌ Lỗi postResetPassword:', err);
    req.flash('error_msg', 'Đã xảy ra lỗi khi cập nhật mật khẩu.');
    res.redirect(`/reset-password/${token}`);
  }
};