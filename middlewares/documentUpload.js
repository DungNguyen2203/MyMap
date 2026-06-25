// File cấu hình thư viện multer để chặn các file không đúng định dạng (chỉ cho phép PDF, DOCX, TXT, Hình ảnh) hoặc dung lượng vượt 50MB.
const multer = require('multer');

// Lấy giới hạn dung lượng tải lên từ file cấu hình .env (mặc định là 50MB nếu không cấu hình)
const maxUploadMB = parseFloat(process.env.MAX_DOCUMENT_UPLOAD_MB || '50');
const fileSizeLimit = maxUploadMB * 1024 * 1024;

// Bộ nhớ tạm thời trong RAM (vì ta sẽ đẩy trực tiếp lên MongoDB)
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: fileSizeLimit }, // Giới hạn động theo cấu hình .env
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Chỉ chấp nhận file PDF hoặc DOCX'));
    }
    cb(null, true);
  }
});

module.exports = upload;
