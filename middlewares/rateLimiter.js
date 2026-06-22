// File: middlewares/rateLimiter.js
// Middleware rate limiting đơn giản dùng in-memory store
// Giới hạn số lần gọi dựa trên IP để chống brute-force

/**
 * Tạo một rate limiter middleware.
 * @param {object} options
 * @param {number} options.windowMs   - Khoảng thời gian tính (ms). Mặc định: 15 phút.
 * @param {number} options.max        - Số request tối đa trong windowMs. Mặc định: 10.
 * @param {string} options.message    - Thông báo lỗi khi bị giới hạn.
 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 10, message = 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.' } = {}) {
    // Map lưu: IP -> { count, resetTime }
    const requests = new Map();

    // Dọn dẹp các entry hết hạn định kỳ (mỗi phút)
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [ip, data] of requests.entries()) {
            if (now > data.resetTime) {
                requests.delete(ip);
            }
        }
    }, 60 * 1000);

    // Đảm bảo cleanup không giữ process sống nếu app tắt
    cleanupInterval.unref();

    return function rateLimiterMiddleware(req, res, next) {
        // Lấy IP thực (hỗ trợ proxy/load balancer)
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();

        const record = requests.get(ip);

        if (!record || now > record.resetTime) {
            // Tạo mới hoặc reset sau khi hết window
            requests.set(ip, { count: 1, resetTime: now + windowMs });
            return next();
        }

        record.count += 1;

        if (record.count > max) {
            const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);
            res.set('Retry-After', retryAfterSeconds);

            // Trả về lỗi theo dạng phù hợp (JSON hoặc redirect flash)
            if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                return res.status(429).json({
                    success: false,
                    message: message,
                    retryAfter: retryAfterSeconds
                });
            }

            req.flash('error_msg', `${message} (Thử lại sau ${Math.ceil(retryAfterSeconds / 60)} phút)`);
            return res.redirect('back');
        }

        next();
    };
}

// Rate limiter cho trang đăng nhập: tối đa 10 lần / 15 phút
const loginRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 phút
    max: 10,
    message: 'Quá nhiều lần đăng nhập thất bại.'
});

// Rate limiter cho quên mật khẩu: tối đa 5 lần / 15 phút
const forgotPasswordRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 phút
    max: 5,
    message: 'Quá nhiều yêu cầu đặt lại mật khẩu.'
});

module.exports = { loginRateLimiter, forgotPasswordRateLimiter };
