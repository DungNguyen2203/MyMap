// Chỉ cho phép người dùng đã đăng nhập đi tiếp
exports.checkLoggedIn = async (req, res, next) => {
    if (req.session.user) {
        try {
            const usersDb = req.app.locals.usersDb;
            const { ObjectId } = require('mongodb');
            if (ObjectId.isValid(req.session.user._id)) {
                const user = await usersDb.collection('users').findOne({ _id: new ObjectId(req.session.user._id) });
                if (user) {
                    // Đồng bộ trạng thái thực tế từ database vào session
                    req.session.user.status = user.status || 'active';
                    req.session.user.role = user.role || 'student';
                    
                    if (user.status === 'locked') {
                        // Nếu bị khóa tài khoản mà truy cập các trang khác ngoài trang báo khóa & logout
                        if (req.path !== '/account-locked' && req.path !== '/logout') {
                            return res.redirect('/account-locked');
                        }
                    } else {
                        // Nếu tài khoản bình thường mà truy cập nhầm vào trang báo khóa
                        if (req.path === '/account-locked') {
                            return res.redirect('/dashboard');
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Lỗi trong middleware checkLoggedIn:", e);
        }
        next();
    } else {
        // Chưa đăng nhập mà vào trang /account-locked
        if (req.path === '/account-locked') {
            return res.redirect('/login');
        }
        res.redirect('/');
    }
};
// Nếu người dùng đã đăng nhập rồi, chuyển họ về trang cá nhân
exports.bypassLogin = (req, res, next) => {
    if (!req.session.user) {
        next();
    } else {
        res.redirect('/dashboard');
    }
};

// Chỉ cho phép admin đi tiếp
exports.checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        next();
    } else {
        req.flash('error_msg', 'Bạn không có quyền truy cập trang quản trị!');
        res.status(403).render('404', { 
            pageTitle: 'Lỗi 403', 
            subtitle: 'Truy cập bị từ chối',
            user: req.session.user,
            errorMessage: 'Bạn không có quyền truy cập trang quản trị.'
        });
    }
};