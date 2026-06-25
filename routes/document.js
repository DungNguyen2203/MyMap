// routes/document.js

// === I. PHẦN KHAI BÁO VÀ CẤU HÌNH BAN ĐẦU ===
const express = require('express'); // Import Express và tạo router.
const router = express.Router();
const multer = require('multer'); // multer – middleware xử lý upload file.
const { v4: uuidv4 } = require('uuid'); // uuidv4 – tạo ID ngẫu nhiên cho tên file.
const crypto = require('crypto'); // crypto – dùng để băm file (SHA-256) nhằm tạo cache key.
const fs = require('fs'); // fs, path – làm việc với file system và đường dẫn.
const path = require('path');
const axios = require('axios'); // axios – gọi API HTTP (dùng cho Groq, OpenRouter).
const { createClient } = require('redis'); // createClient – kết nối Redis (cache).
const { z } = require('zod'); // z – thư viện Zod để validate schema JSON.
const { GoogleGenAI, createPartFromUri, Type, FileState } = require('@google/genai'); // @google/genai – SDK chính thức của Gemini để upload file và gọi AI.
const authMiddleware = require('../middlewares/middlewares.js'); // authMiddleware – Middleware xác thực người dùng đã đăng nhập.
const documentController = require('../controllers/documentController.js'); // documentController – Điều khiển các trang giao diện liên quan đến tài liệu.
const { PDFParse } = require('pdf-parse'); // PDFParse – parse PDF lấy text.
const mammoth = require('mammoth'); // mammoth – đọc file DOCX.
const AdmZip = require('adm-zip'); // AdmZip – đọc metadata từ file DOCX (đếm số trang).

// Đọc các biến môi trường cấu hình API key cho Gemini (có thể nhiều key, ngăn cách bằng dấu phẩy), Groq, OpenRouter. Nếu không có, gán giá trị mặc định.
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';

// Import cache dùng chung
const { documentCache, CACHE_PREFIX, CACHE_TTL_SECONDS } = require('../utils/documentCache.js');

// Các hằng số cấu hình: số luồng AI song song, thời gian cache (7 ngày), giới hạn dung lượng upload (5MB), số ký tự tối đa khi fallback text, thư mục tạm để lưu file upload, prefix cho cache key.
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY || process.env.GLOBAL_AI_CONCURRENCY || '3', 10);
const MAX_UPLOAD_MB = parseFloat(process.env.MAX_DOCUMENT_UPLOAD_MB || '5');
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);
const MAX_FALLBACK_TEXT_CHARS = parseInt(process.env.MAX_FALLBACK_TEXT_CHARS || '500000', 10);
const TEMP_UPLOAD_DIR = path.join(__dirname, '..', 'temp', 'uploads');

// Tạo thư mục tạm lưu file upload nếu chưa tồn tại.
fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

// Cảnh báo nếu thiếu API key.
if (GEMINI_KEYS.length === 0) console.warn('Gemini API key is not configured. Gemini File API calls will fail.');
if (!GROQ_API_KEY) console.warn('GROQ_API_KEY is not configured. Groq fallback is disabled.');
if (!OPENROUTER_API_KEY) console.warn('OPENROUTER_API_KEY is not configured. OpenRouter fallback is disabled.');

// Hàm runWithAiLimit: sử dụng thư viện p-limit để giới hạn số lượng tác vụ AI chạy đồng thời (concurrency). Nếu chưa khởi tạo, import động và tạo instance với số lượng luồng từ cấu hình.
let pLimitInstance = null;
async function runWithAiLimit(task) {
  if (!pLimitInstance) {
    const { default: pLimit } = await import('p-limit');
    pLimitInstance = pLimit(Math.max(1, AI_CONCURRENCY));
  }
  return pLimitInstance(task);
}

// Quản lý vòng tròn các API key Gemini. Khi gọi next(), nó trả về key tiếp theo để phân phối tải (load balancing) và tránh quá hạn mức của một key.
const keyManager = {
  keys: GEMINI_KEYS,
  index: 0,
  next() {
    if (!this.keys.length) return null;
    const key = this.keys[this.index];
    this.index = (this.index + 1) % this.keys.length;
    return key;
  },
};

// Danh sách loại MIME được phép upload. Ở đây hỗ trợ PDF, DOCX, TXT, và ảnh.
const allowedMimeTypes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/gif',
]);

// === II. CẤU HÌNH MULTER (UPLOAD FILE) ===
// Cấu hình Multer: storage lưu file vào thư mục tạm, đặt tên file bằng UUID + đuôi mở rộng gốc, limits giới hạn dung lượng file, fileFilter chỉ chấp nhận các MIME type được phép.
const upload = multer({
  // Tạo middleware upload với các tùy chỉnh
  storage: multer.diskStorage({
    // Cấu hình lưu file vào ổ đĩa thay vì bộ nhớ (memory)
    destination: (req, file, cb) => cb(null, TEMP_UPLOAD_DIR),
    // Hàm xác định thư mục lưu file: luôn lưu vào TEMP_UPLOAD_DIR (đã khai báo ở trên)
    // req: đối tượng request, file: thông tin file, cb: callback để trả về đường dẫn
    // cb(null, TEMP_UPLOAD_DIR) nghĩa là không lỗi và thư mục đích là TEMP_UPLOAD_DIR

    filename: (req, file, cb) => {
      // Hàm xác định tên file khi lưu trên server
      const ext = path.extname(file.originalname || '').toLowerCase();
      // Lấy phần mở rộng của tên file gốc (ví dụ ".pdf"), chuyển về chữ thường
      cb(null, `${uuidv4()}${ext}`);
      // Tạo tên file mới: UUID ngẫu nhiên + đuôi mở rộng
      // Ví dụ: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf"
      // Giúp tránh trùng tên và bảo mật (không lộ tên gốc)
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  // Giới hạn kích thước file tối đa (tính bằng bytes) – lấy từ biến môi trường hoặc mặc định 5MB
  fileFilter: (req, file, cb) => {
    // Hàm kiểm tra loại file (MIME type)
    if (!allowedMimeTypes.has(file.mimetype)) {
      // Nếu loại file không nằm trong danh sách cho phép
      return cb(new Error('Chỉ chấp nhận PDF, DOCX, TXT, JPG, PNG hoặc GIF.'));
      // Gọi callback với lỗi -> multer từ chối file và trả về lỗi này
    }
    cb(null, true);
    // Nếu hợp lệ, gọi callback thành công (không lỗi, cho phép upload)
  },
});

// Middleware wrapper xử lý upload: nếu có lỗi (quá lớn, sai định dạng), nó xóa file đã upload (nếu có) và trả về lỗi 400. Nếu không lỗi, tiếp tục sang middleware tiếp theo.
function handleDocumentUpload(req, res, next) {
  // Định nghĩa middleware xử lý upload file
  // req: đối tượng request, res: đối tượng response, next: hàm chuyển tiếp sang middleware/controller tiếp theo

  upload.single('documentFile')(req, res, (err) => {
    // Gọi middleware upload.single('documentFile') để xử lý một file upload từ field có tên 'documentFile'
    // Khi upload hoàn tất (hoặc có lỗi), callback được gọi với tham số err (lỗi nếu có)

    if (!err) return next();
    // Nếu không có lỗi (err là null/undefined) -> chuyển sang middleware/controller tiếp theo và dừng xử lý tại đây

    if (req.file?.path) {
      // Nếu có lỗi và file đã được lưu một phần (tồn tại đường dẫn trong req.file.path)
      // -> gọi cleanupLocalUpload để xóa file tạm đã tạo
      cleanupLocalUpload(req.file.path).catch((cleanupError) => {
        // Xóa file bất đồng bộ, bắt lỗi nếu xóa thất bại
        console.warn('[handleDocumentUpload] Failed to cleanup rejected upload:', cleanupError.message);
        // In cảnh báo ra console nhưng không ảnh hưởng đến response
      });
    }

    const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
      // Nếu lỗi thuộc loại MulterError và có mã LIMIT_FILE_SIZE (file vượt quá kích thước cho phép)
      ? `File quá lớn. Giới hạn hiện tại là ${MAX_UPLOAD_MB}MB.`
      // -> tạo thông báo với dung lượng giới hạn
      : err.message || 'Lỗi tải file.';
      // Ngược lại: dùng err.message, hoặc thông báo chung nếu err.message rỗng

    return res.status(400).json({ error: message });
    // Trả về response với mã 400 (Bad Request) và thông báo lỗi dạng JSON
  });
}

// === III. ĐỊNH NGHĨA SCHEMA CHO MINDMAP (ZOD VÀ GEMINI SCHEMA) ===
// Định nghĩa schema(cấu trúc của file và các ràng buộc đi kèm) đệ quy cho một node con bằng Zod: có title (bắt buộc), points (mảng chuỗi, mặc định rỗng), children (mảng các node con, đệ quy) , validate dữ liệu nhận từ AI
const MindmapNodeSchema = z.lazy(() => z.object({
  // z.lazy() cho phép định nghĩa schema đệ quy (self-referential)
  // Vì bên trong có children: z.array(MindmapNodeSchema) tham chiếu đến chính nó
  // Nếu không có lazy, JavaScript sẽ báo lỗi vì MindmapNodeSchema chưa được định nghĩa khi đang khởi tạo
  
  title: z.string().trim().min(1),
  // title: bắt buộc, phải là chuỗi (string)
  // .trim(): tự động xóa khoảng trắng đầu và cuối trước khi validate
  // .min(1): yêu cầu chuỗi có ít nhất 1 ký tự sau khi trim (không được rỗng)
  
  points: z.array(z.string().trim().min(1)).optional().default([]),
  // points: mảng các chuỗi, mỗi chuỗi được trim và có ít nhất 1 ký tự
  // .optional(): trường này không bắt buộc (có thể không có trong dữ liệu đầu vào)
  // .default([]): nếu không có hoặc bị thiếu, Zod sẽ gán mảng rỗng làm giá trị mặc định
  
  children: z.array(MindmapNodeSchema).optional().default([]),
  // children: mảng các node con (có cùng cấu trúc MindmapNodeSchema) → đệ quy
  // .optional() và .default([]) tương tự như trên
  // Nhờ có z.lazy(), schema có thể tự tham chiếu đến chính nó để tạo cây lồng nhau
}));

// Định nghĩa schema tổng thể cho Mindmap bằng Zod: mainTopic, summary, và subTopics (mảng ít nhất 1 phần tử), mỗi subTopic có chapterTitle, points, và children.
const MindmapDocumentSchema = z.object({
  // Định nghĩa schema cho toàn bộ mindmap (tài liệu đầu ra)
  // Đây là một object với các trường bắt buộc/tùy chọn, dùng để validate dữ liệu từ AI

  mainTopic: z.string().trim().min(1),
  // mainTopic: bắt buộc, kiểu chuỗi, không được rỗng
  // .trim(): tự động loại bỏ khoảng trắng thừa ở đầu và cuối
  // .min(1): sau khi trim, chuỗi phải có ít nhất 1 ký tự

  summary: z.string().trim().optional().default(''),
  // summary: tùy chọn (optional), kiểu chuỗi
  // .trim(): loại bỏ khoảng trắng đầu cuối
  // .default(''): nếu không có giá trị, mặc định là chuỗi rỗng
  // Dùng cho tóm tắt tổng quan của toàn bộ mindmap

  subTopics: z.array(
    // subTopics: mảng bắt buộc (không có optional) nhưng phải có ít nhất 1 phần tử nhờ .min(1)
    z.object({
      // Mỗi phần tử trong mảng là một object mô tả một chủ đề con (chapter)
      chapterTitle: z.string().trim().min(1),
      // chapterTitle: bắt buộc, chuỗi, không rỗng – tên của chương/mục lớn

      points: z.array(z.string().trim().min(1)).optional().default([]),
      // points: mảng các chuỗi (tóm tắt ý chính của chương), mỗi chuỗi được trim và tối thiểu 1 ký tự
      // .optional().default([]): không bắt buộc, nếu thiếu thì mặc định mảng rỗng

      children: z.array(MindmapNodeSchema).optional().default([]),
      // children: mảng các node con (cấu trúc đệ quy), dùng để phân nhánh sâu hơn
      // Tham chiếu đến schema MindmapNodeSchema đã định nghĩa trước đó
      // .optional().default([]): tương tự, không bắt buộc, mặc định rỗng
    })
  ).min(1),
  // .min(1): yêu cầu mảng subTopics phải có ít nhất 1 phần tử
  // Đảm bảo mindmap luôn có ít nhất một chủ đề con, tránh trường hợp rỗng
});

// Hàm đệ quy tạo schema phản hồi cho node con của Gemini, giới hạn độ sâu lồng nhau để tối ưu hóa.
function childResponseSchema(depth = 0) {
  // Hàm này tạo schema cho Gemini API (định dạng của Google GenAI)
  // depth: độ sâu hiện tại của node, mặc định 0 (gốc)

  const schema = {
    type: Type.OBJECT,
    // Định nghĩa đây là một object

    properties: {
      title: { type: Type.STRING },
      // title: bắt buộc, kiểu chuỗi

      points: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      // points: mảng các chuỗi (các điểm tóm tắt)
    },

    required: ['title', 'points'],
    // Cả title và points đều bắt buộc (phải có)

    propertyOrdering: ['title', 'points'],
    // Thứ tự ưu tiên xuất hiện trong output
  };

  // Nếu chưa đạt đến độ sâu tối đa (10)
  if (depth < 10) {
    // Thêm thuộc tính children để tạo cấu trúc đệ quy
    schema.properties.children = {
      type: Type.ARRAY,
      items: childResponseSchema(depth + 1),
      // Mỗi phần tử của mảng children cũng là một node con
      // Gọi đệ quy, tăng depth lên 1
    };
    // Bổ sung children vào danh sách required và propertyOrdering
    schema.required.push('children');
    schema.propertyOrdering.push('children');
  }
  // Nếu depth >= 10, không thêm children -> đây là node lá

  return schema;
  // Trả về schema object cho Gemini API
}

// Định nghĩa schema cấu trúc Mindmap hoàn chỉnh cho Gemini API.
const GEMINI_MINDMAP_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    mainTopic: { type: Type.STRING },
    summary: { type: Type.STRING },
    subTopics: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          chapterTitle: { type: Type.STRING },
          points: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          children: {
            type: Type.ARRAY,
            items: childResponseSchema(),
          },
        },
        required: ['chapterTitle', 'points', 'children'],
        propertyOrdering: ['chapterTitle', 'points', 'children'],
      },
    },
  },
  required: ['mainTopic', 'summary', 'subTopics'],
  propertyOrdering: ['mainTopic', 'summary', 'subTopics'],
};

// === IV. CÁC HÀM TIỆN ÍCH (UTILITY) ===
const inFlightDocuments = new Map(); // Map lưu các tài liệu đang xử lý nhằm tránh trùng lặp.

// Tạo cache key hoàn chỉnh từ hash file.
function cacheKey(hash) {
  return `${CACHE_PREFIX}${hash}`;
}

// Gửi sự kiện Server-Sent Events (SSE) để stream dữ liệu về client theo thời gian thực.
function sendSSE(res, event, data) {
  if (!res || res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Thiết lập HTTP headers cho kết nối SSE.
function writeSSEHeaders(res) {
  // Hàm thiết lập các HTTP headers cần thiết cho Server-Sent Events (SSE)
  // Mục đích: thông báo cho trình duyệt và các tầng trung gian (proxy, load balancer)
  // biết rằng đây là một luồng sự kiện (event stream), cần xử lý đặc biệt

  res.writeHead(200, {
    // Ghi mã trạng thái HTTP 200 (OK) và các header vào response
    // writeHead gửi header ngay lập tức, không cần đợi gọi res.end()

    'Content-Type': 'text/event-stream',
    // Báo cho client biết nội dung trả về là luồng sự kiện (SSE)
    // Trình duyệt khi thấy header này sẽ tự động tạo đối tượng EventSource
    // và xử lý các dòng "event: ..." và "data: ..."

    'Cache-Control': 'no-cache',
    // Ngăn không cho trình duyệt hoặc các proxy lưu cache nội dung
    // Vì SSE là dữ liệu thời gian thực, nếu bị cache sẽ gây ra hiển thị sai
    // Đảm bảo client luôn nhận được dữ liệu mới nhất

    Connection: 'keep-alive',
    // Yêu cầu giữ kết nối HTTP mở sau khi gửi header
    // Thay vì đóng kết nối ngay (mặc định HTTP/1.0 là close)
    // Giữ kết nối mở để có thể gửi nhiều sự kiện trong cùng một kết nối

    'X-Accel-Buffering': 'no',
    // Header đặc biệt dành cho Nginx (web server phổ biến)
    // Mặc định Nginx thường buffer (tạm lưu) response để tối ưu hiệu năng
    // Tuy nhiên với SSE, nếu buffer, dữ liệu sẽ bị giữ lại và chỉ gửi khi đầy buffer
    // Gây trễ, không real-time. Header này bảo Nginx tắt buffer cho response này
    // Đảm bảo mỗi sự kiện được gửi tới client ngay lập tức
  });
}

// Gửi sự kiện cập nhật tiến trình phân tích thông qua SSE.
function progress(res, message, percent, extra = {}) {
  sendSSE(res, 'progress', { message, percent, ...extra });
}

// Kiểm tra bảo mật: Đảm bảo đường dẫn con nằm trong thư mục cha (tránh tấn công Directory Traversal).
function isPathInside(childPath, parentPath) {
  // Hàm kiểm tra xem đường dẫn childPath có nằm bên trong thư mục parentPath không
  // Mục đích: ngăn chặn tấn công Directory Traversal (Path Traversal)
  // Bằng cách chuẩn hóa đường dẫn và kiểm tra vị trí tương đối

  const resolvedChild = path.resolve(childPath);
  // Chuyển childPath thành đường dẫn tuyệt đối, chuẩn hóa các ký tự ., ..
  // Ví dụ: path.resolve('temp/uploads/../etc/passwd') -> '/app/etc/passwd'
  // (loại bỏ các thành phần không hợp lệ)

  const resolvedParent = path.resolve(parentPath);
  // Tương tự, chuẩn hóa parentPath thành đường dẫn tuyệt đối
  // Ví dụ: path.resolve('temp/uploads') -> '/app/temp/uploads'

  const relative = path.relative(resolvedParent, resolvedChild);
  // Tính đường dẫn tương đối từ resolvedParent đến resolvedChild
  // Ví dụ: child = '/app/temp/uploads/image.jpg', parent = '/app/temp/uploads'
  // -> relative = 'image.jpg'
  // Nếu child nằm ngoài parent: child = '/etc/passwd', parent = '/app/temp/uploads'
  // -> relative = '../../../../etc/passwd' (bắt đầu bằng ..)

  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  // Trả về true nếu tất cả điều kiện đúng:
  // 1. relative khác rỗng (child không trùng với parent)
  // 2. relative không bắt đầu bằng '..' (child không nằm ngoài parent)
  // 3. relative không phải đường dẫn tuyệt đối (đảm bảo là tương đối)
  // Nếu đúng, childPath nằm trong parentPath -> an toàn
}

// Xóa file tạm cục bộ sau khi xử lý xong, chỉ thực hiện nếu file nằm trong thư mục tạm được chỉ định.
async function cleanupLocalUpload(filePath) {
  // Đây là hàm bất đồng bộ (async) để xóa file tạm sau khi xử lý
  // Mục đích: dọn dẹp file upload để tránh đầy ổ đĩa và đảm bảo an toàn bảo mật

  if (!filePath) return;
  // Nếu filePath không có giá trị (null, undefined, chuỗi rỗng) thì thoát luôn
  // Không làm gì cả, tránh lỗi khi truyền đường dẫn không hợp lệ

  if (!isPathInside(filePath, TEMP_UPLOAD_DIR)) {
    // Gọi hàm isPathInside để kiểm tra xem filePath có nằm trong thư mục tạm TEMP_UPLOAD_DIR không
    // Nếu không (tức là filePath đang cố gắng thoát ra ngoài, hoặc là đường dẫn tuyệt đối ngoài phạm vi)
    console.warn(`[cleanupLocalUpload] Refusing to delete outside temp upload dir: ${filePath}`);
    // In cảnh báo ra console (log) để admin biết có ai đó đang cố xóa file ngoài thư mục cho phép
    return;
    // Dừng hàm, không xóa file -> bảo vệ hệ thống khỏi tấn công Directory Traversal
  }

  await fs.promises.unlink(filePath).catch((error) => {
    // Nếu kiểm tra an toàn thành công, tiến hành xóa file bằng fs.promises.unlink (bất đồng bộ)
    // await chờ cho đến khi xóa xong
    // .catch() bắt lỗi nếu việc xóa thất bại (ví dụ file không tồn tại, hoặc lỗi quyền truy cập)

    if (error.code !== 'ENOENT') {
      // ENOENT là mã lỗi "Error NO ENTry" – file hoặc thư mục không tồn tại
      // Trong trường hợp này, file đã bị xóa hoặc chưa được tạo, không cần lo lắng
      // Nếu lỗi không phải ENOENT (ví dụ lỗi quyền, ổ đĩa đầy,...), mới log cảnh báo để kiểm tra
      console.warn(`[cleanupLocalUpload] Failed to delete ${filePath}:`, error.message);
    }
    // Nếu là ENOENT, im lặng bỏ qua (không log) vì đó là tình huống bình thường
  });
}

// Băm nội dung file bằng thuật toán SHA-256 để tạo mã hash duy nhất làm khóa cache.
function hashFile(filePath) {
  // Hàm này trả về một Promise chứa chuỗi hash SHA-256 của file tại đường dẫn filePath

  return new Promise((resolve, reject) => {
    // Tạo một Promise mới để xử lý thao tác bất đồng bộ (đọc và băm file)
    // resolve: gọi khi thành công (trả về hash)
    // reject: gọi khi có lỗi

    const hash = crypto.createHash('sha256');
    // Tạo một đối tượng hash sử dụng thuật toán SHA-256
    // SHA-256 là một hàm băm mã hóa, tạo ra một chuỗi 64 ký tự hex duy nhất cho mỗi nội dung khác nhau
    // crypto là module có sẵn trong Node.js dùng cho các chức năng mã hóa

    const stream = fs.createReadStream(filePath);
    // Tạo một ReadStream để đọc file từ filePath
    // Stream đọc file thành từng đoạn nhỏ (chunk) thay vì đọc toàn bộ vào bộ nhớ một lần
    // Điều này rất quan trọng vì file có thể lớn (ví dụ 50MB) và không nên load hết vào RAM

    stream.on('data', (chunk) => hash.update(chunk));
    // Đăng ký sự kiện 'data': mỗi khi một chunk dữ liệu được đọc từ file, hàm callback này được gọi
    // hash.update(chunk) cập nhật giá trị hash với dữ liệu mới (cộng dồn tất cả các chunk)
    // Điều này cho phép tính hash cho toàn bộ file, dù file lớn cỡ nào

    stream.on('error', reject);
    // Nếu có lỗi trong quá trình đọc file (ví dụ file không tồn tại, lỗi quyền truy cập)
    // sự kiện 'error' được kích hoạt, gọi reject(error) để từ chối Promise
    // Người gọi hàm sẽ bắt được lỗi này trong catch

    stream.on('end', () => resolve(hash.digest('hex')));
    // Khi file được đọc hoàn toàn, sự kiện 'end' được kích hoạt
    // Gọi hash.digest('hex') để lấy giá trị hash cuối cùng dưới dạng chuỗi thập lục phân (hex)
    // Ví dụ: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    // Sau đó gọi resolve() với chuỗi hash này, hoàn thành Promise thành công
  });
}
// Lấy tên file gốc sạch (không chứa đuôi mở rộng) dùng làm tiêu đề cho sơ đồ.
function safeFileTitle(filename) {
  return path.basename(filename || 'Sơ đồ tư duy').replace(/\.[^/.]+$/, '').trim() || 'Sơ đồ tư duy';
}

// Trích xuất chuỗi văn bản từ gói dữ liệu chunk trả về từ Gemini API.
function getChunkText(chunk) {
  if (!chunk) return '';
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.text === 'function') return chunk.text();
  return chunk.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}

// === SCHEMA JSON CHO GROQ & OPENROUTER (FIXED-DEPTH, KHÔNG ĐỆ QUY) ===
// Groq và OpenRouter hỗ trợ response_format: { type: 'json_schema' } nhưng KHÔNG hỗ trợ recursive schema.
// Do đó, dùng kỹ thuật fixed-depth: khai báo schema lồng nhau cố định tối đa 10 cấp con.
// Cấu trúc của children
function buildChildJsonSchema(depth = 0) {
  const schema = {
    type: 'object',                          // Đây là một object
    properties: {                            // Các thuộc tính:
      title: { type: 'string' },             // - title: chuỗi
      points: { type: 'array', items: { type: 'string' } }, // - points: mảng chuỗi
    },
    required: ['title', 'points'],           // title và points bắt buộc
    additionalProperties: false,             // Không cho phép thuộc tính khác ngoài title/points
  };

  if (depth < 10) {
    // Nếu chưa đạt đến độ sâu tối đa (10), thêm trường children
    schema.properties.children = {
      type: 'array',
      items: buildChildJsonSchema(depth + 1), // Gọi đệ quy để tạo schema cho mỗi node con
    };
    schema.required.push('children');         // children bắt buộc ở mỗi cấp
  }
  // Nếu depth >= 10, không có children → node lá

  return schema;
}

// Schema JSON chuẩn OpenAI-compatible dùng cho Groq và OpenRouter.
// Được tạo sẵn một lần khi module load, tránh tạo lại mỗi request.
const FALLBACK_JSON_SCHEMA = {
  name: 'mindmap_document',
  strict: true, // Yêu cầu AI phải tuân thủ chặt chẽ schema (các model hỗ trợ sẽ bắt buộc)
  schema: { // Nội dung schema
    type: 'object',
    properties: { // liệt kê các trường mong đợi
      mainTopic: { type: 'string' },
      summary: { type: 'string' },
      subTopics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            chapterTitle: { type: 'string' },
            points: { type: 'array', items: { type: 'string' } },
            children: { type: 'array', items: buildChildJsonSchema() },
          },
          required: ['chapterTitle', 'points', 'children'],
          additionalProperties: false,
        },
      },
    },
    required: ['mainTopic', 'summary', 'subTopics'],
    additionalProperties: false, // ngăn AI sinh thêm trường linh tinh , giúp validate dễ dàng hơn vì cấu trúc cố định 
  },
};

// Chuẩn hóa dữ liệu Mindmap: loại bỏ khoảng trắng thừa và bổ sung nhánh mặc định nếu trống.
// Input của hàm normalizeMindmap là dữ liệu từ AI sau khi đã parse từ JSON (1 object javascript có các trường mainTopic,summary,subTopics)
function normalizeMindmap(mindmap) {
  // Hàm này nhận vào một object mindmap (có thể từ AI) và trả về một bản đã được chuẩn hóa,
  // đảm bảo dữ liệu sạch, không có khoảng trắng thừa, các mảng points/children không chứa giá trị rỗng,
  // và luôn có ít nhất một subTopic.

  // Định nghĩa hàm normalizeText: ép giá trị thành chuỗi, xử lý khoảng trắng, trim.
  // - String(value || ''): nếu value null/undefined thì dùng chuỗi rỗng.
  // - replace(/\s+/g, ' '): thay thế tất cả chuỗi khoảng trắng (dấu cách, tab, newline) bằng 1 dấu cách.
  // - .trim(): xóa khoảng trắng đầu và cuối.
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  // Định nghĩa hàm đệ quy normalizeChild để chuẩn hóa một node con.
  // Hàm này nhận vào một đối tượng child và trả về một đối tượng mới với các trường đã chuẩn hóa.
  const normalizeChild = (child) => ({
    // title: chuẩn hóa văn bản của trường title.
    title: normalizeText(child.title),
    // points: nếu child.points không có thì dùng mảng rỗng, map normalizeText, filter bỏ các giá trị falsy (rỗng).
    points: (child.points || []).map(normalizeText).filter(Boolean),
    // children: nếu child.children không có thì dùng mảng rỗng, map normalizeChild đệ quy, chỉ giữ những item có title khác rỗng.
    children: (child.children || []).map(normalizeChild).filter((item) => item.title),
  });

  // Tạo object normalized từ dữ liệu đầu vào.
  const normalized = {
    // Chuẩn hóa mainTopic: dùng normalizeText.
    mainTopic: normalizeText(mindmap.mainTopic),
    // Chuẩn hóa summary: tương tự.
    summary: normalizeText(mindmap.summary),
    // Xử lý subTopics: nếu không có thì dùng mảng rỗng, map qua từng topic.
    subTopics: (mindmap.subTopics || [])
      .map((topic) => ({
        // Mỗi topic được chuẩn hóa: chapterTitle, points (chuẩn hóa từng điểm và lọc rỗng),
        // children (đệ quy normalizeChild và lọc theo title).
        chapterTitle: normalizeText(topic.chapterTitle),
        points: (topic.points || []).map(normalizeText).filter(Boolean),
        children: (topic.children || []).map(normalizeChild).filter((item) => item.title),
      }))
      // Sau khi map, lọc bỏ những topic có chapterTitle rỗng (sau khi normalize).
      .filter((topic) => topic.chapterTitle),
  };

  // Nếu sau khi xử lý, mảng subTopics bị rỗng (do không có dữ liệu hoặc bị lọc hết),
  // thì tạo một subTopic mặc định.
  if (!normalized.subTopics.length) {
    normalized.subTopics.push({
      // chapterTitle: dùng summary nếu có, không thì dùng mainTopic, nếu không thì dùng 'Nội dung chính'.
      chapterTitle: normalized.summary || normalized.mainTopic || 'Nội dung chính',
      points: [],
      children: [],
    });
  }

  // Trả về object mindmap đã được chuẩn hóa.
  return normalized;
}

// Chuyển đổi dữ liệu sơ đồ tư duy có cấu trúc JSON thành văn bản Markdown phân cấp bằng tiêu đề (#).
// Hàm này dùng để lấy markdown vẽ ra sơ đồ trực quan bằng thư viện d3.js và markmap
function generateMarkdownFromMindmap(mindmap) {
  // Hàm này nhận vào một object mindmap đã được chuẩn hóa (từ normalizeMindmap)
  // và chuyển đổi thành chuỗi Markdown có cấu trúc heading (hierarchical headings)
  // để sau đó dùng thư viện markmap vẽ sơ đồ tư duy hoặc hiển thị dạng văn bản.

  // Hàm cleanLine: làm sạch một chuỗi văn bản, loại bỏ khoảng trắng thừa.
  const cleanLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  // Khởi tạo mảng lines, bắt đầu bằng heading level 1 (#) với mainTopic.
  // Nếu mainTopic rỗng sau khi clean, dùng 'Sơ đồ tư duy' làm tiêu đề mặc định.
  const lines = [`# ${cleanLine(mindmap.mainTopic) || 'Sơ đồ tư duy'}`];

  // Nếu có summary, thêm một dòng trống và hiển thị summary dưới dạng một dấu gạch đầu dòng (-).
  if (mindmap.summary) {
    lines.push('');
    lines.push(`- ${cleanLine(mindmap.summary)}`);
  }

  // Hàm đệ quy appendChild: xử lý một node con (child) và các nhánh con của nó.
  // Tham số depth thể hiện độ sâu hiện tại của node (bắt đầu từ 2 hoặc 3 tùy ngữ cảnh).
  const appendChild = (child, depth) => {
    if (depth <= 10) {
      // Nếu depth <= 10, ta dùng heading Markdown (#, ##, ###,...) cho node này.
      // headingDepth được giới hạn trong khoảng từ 2 đến 10 (vì H1 đã dùng cho mainTopic).
      const headingDepth = Math.min(Math.max(depth, 2), 10);
      lines.push('');
      // Tạo heading với số lượng # tương ứng và tiêu đề đã clean.
      lines.push(`${'#'.repeat(headingDepth)} ${cleanLine(child.title)}`);
      // Thêm các points (nếu có) dưới dạng danh sách gạch đầu dòng.
      (child.points || []).forEach((point) => lines.push(`- ${cleanLine(point)}`));
      // Đệ quy xử lý các children của node này, tăng depth lên 1.
      (child.children || []).forEach((nested) => appendChild(nested, depth + 1));
    } else {
      // Khi depth > 10 (quá sâu), không dùng heading nữa mà dùng danh sách lồng nhau (indent).
      // Indent được tính bằng 2 dấu cách cho mỗi cấp vượt quá 10.
      const indent = '  '.repeat(depth - 10);
      lines.push(`${indent}- ${cleanLine(child.title)}`);
      // Thêm points với indent sâu hơn.
      (child.points || []).forEach((point) => lines.push(`${indent}  - ${cleanLine(point)}`));
      // Đệ quy xử lý children, tiếp tục tăng depth.
      (child.children || []).forEach((nested) => appendChild(nested, depth + 1));
    }
  };


  // Xử lý từng subTopic trong mảng subTopics.
  (mindmap.subTopics || []).forEach((topic) => {
    lines.push('');
    // Mỗi chapterTitle được hiển thị dưới dạng heading level 2 (##).
    lines.push(`## ${cleanLine(topic.chapterTitle)}`);
    // Thêm các points (nếu có) dưới dạng gạch đầu dòng.
    (topic.points || []).forEach((point) => lines.push(`- ${cleanLine(point)}`));
    // Với mỗi child của topic, gọi appendChild với depth bắt đầu từ 3
    // (vì topic đã là H2, các con sẽ là H3 trở xuống).
    (topic.children || []).forEach((child) => appendChild(child, 3));
  });

  // Nối tất cả các dòng thành một chuỗi, ngăn cách bằng \n, và trim cuối cùng.
  return lines.join('\n').trim();
}

// Hằng số quy tắc phân tích chung, dùng trong mọi prompt.
const ANALYSIS_RULES = `QUY TẮC PHÂN TÍCH:
1. ĐỘ SÂU & CHI TIẾT: Xây dựng sơ đồ phân cấp sâu (6-8 tầng). Tận dụng tối đa token output để trích xuất đầy đủ, sâu sắc, bao quát mọi khía cạnh tài liệu.
2. CẤU TRÚC PHÂN CẤP: Phân rã logic chặt chẽ (Chủ đề chính -> Các chương/mục lớn -> Ý phụ -> Chi tiết nhỏ). KHÔNG dồn nội dung vào mảng 'points' ở cấp cha; hãy tách thành các 'children' con để tạo nhánh.
3. TIÊU ĐỀ NGẮN GỌN: Tiêu đề node ('title', 'chapterTitle') phải cực kỳ ngắn gọn (dưới 10 từ). Giải thích chi tiết, định nghĩa hoặc số liệu đưa vào mảng 'points'.
4. KHÔNG DÙNG KÝ TỰ ĐỊNH DẠNG: Các chuỗi văn bản trong 'mainTopic', 'chapterTitle', 'title' và 'points' phải là chữ thuần, tuyệt đối KHÔNG chứa ký tự Markdown (như #, ##, -, *, **, [ ]) vì hệ thống sẽ tự động định dạng khi vẽ.
5. ĐIỀU KIỆN DỪNG & TRÁNH ĐỂ TRỐNG: Chỉ tạo nhánh 'children' khi có nội dung thực tế. Node lá phải có mảng 'children' trống []. Không được để trống 'title'.
6. ĐỘ CHÍNH XÁC: Trích xuất thông tin khách quan, trung thực theo tài liệu gốc. Ưu tiên tiếng Việt nếu tài liệu là tiếng Việt.`;

// === VI. XÂY DỰNG PROMPT CHO AI ===
// Tạo prompt phân tích cho Gemini sử dụng File API.
// Gemini đã dùng responseSchema (structured output) nên không cần mô tả schema trong prompt.
function buildGeminiPrompt(filename) {
  return `Bạn là hệ thống phân tích tài liệu và tạo sơ đồ tư duy chuyên nghiệp.
Đọc toàn bộ file "${filename}" và lập sơ đồ tư duy phân cấp sâu, chi tiết, đầy đủ nhất có thể.

${ANALYSIS_RULES}`;
}

// Tạo prompt cho Groq và OpenRouter (không chứa mô tả schema vì API đã ép schema qua response_format).
function buildFallbackPrompt(filename, text) {
  return `Bạn là hệ thống phân tích tài liệu và tạo sơ đồ tư duy chuyên nghiệp.
Đọc toàn bộ nội dung tài liệu "${filename}" và lập sơ đồ tư duy phân cấp sâu, chi tiết, đầy đủ nhất có thể.

${ANALYSIS_RULES}

Nội dung tài liệu:
${text}`;
}

// === VII. HÀM XỬ LÝ VỚI GEMINI FILE API ===
// Chờ tệp tải lên Gemini File API chuyển sang trạng thái ACTIVE (xử lý xong trên hệ thống của Google).
async function waitForGeminiFile(ai, file, res) {
  let current = file;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!current.state || current.state === FileState.ACTIVE || current.state === 'ACTIVE') return current;
    if (current.state === FileState.FAILED || current.state === 'FAILED') {
      throw new Error(`Gemini File API xử lý file thất bại: ${current.error?.message || 'không rõ nguyên nhân'}`);
    }

    progress(res, `Gemini đang xử lý file (${attempt + 1}/30)...`, 25);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await ai.files.get({ name: current.name });
  }
  throw new Error('Gemini File API xử lý file quá lâu.');
}

// === VIII. HÀM GENERATE VỚI VERCEL AI SDK (STREAMOBJECT) ===
// Sử dụng Vercel AI SDK (streamObject) để tạo và stream JSON có cấu trúc từ tài liệu.
// Hàm generateWithVercelStreamObject: sử dụng Vercel AI SDK (streamObject) để gọi Gemini,
// stream JSON có cấu trúc (theo schema Zod) và gửi tiến trình về client qua SSE.

async function generateWithVercelStreamObject(file, res) {
  // 1. Lấy API key Gemini từ keyManager (round-robin giữa nhiều key)
  const apiKey = keyManager.next();
  if (!apiKey) throw new Error('Gemini API key chưa được cấu hình.');

  // 2. Import động Vercel AI SDK và Google adapter – dùng Promise.all để tải song song
  const [{ streamObject }, { createGoogleGenerativeAI }] = await Promise.all([
    import('ai'),                 // streamObject, các types
    import('@ai-sdk/google'),     // adapter cho Gemini
  ]);

  // 3. Tạo Google Generative AI instance với apiKey
  const google = createGoogleGenerativeAI({ apiKey });
  // 4. Đọc toàn bộ file upload vào buffer (để gửi kèm trong content)
  const fileBuffer = await fs.promises.readFile(file.path);

  // 5. Gửi sự kiện progress SSE báo bắt đầu dùng Vercel AI SDK
  progress(res, `Đang sinh object stream bằng Vercel AI SDK (${GEMINI_MODEL})...`, 35);

  // 6. Gọi streamObject – một phương thức của Vercel AI SDK cho phép stream object theo schema
  const result = streamObject({
    model: google(GEMINI_MODEL),          // model Gemini
    schema: MindmapDocumentSchema,        // Zod schema để validate và định hình output
    schemaName: 'MindmapDocument',
    schemaDescription: 'Cấu trúc JSON dùng để vẽ sơ đồ tư duy từ một tài liệu học tập.',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: buildGeminiPrompt(file.originalname) }, // prompt
        { type: 'file', data: fileBuffer, mediaType: file.mimetype, filename: file.originalname } // file đính kèm
      ],
    }],
    temperature: 0.1,               // độ sáng tạo thấp, ưu tiên chính xác
    maxOutputTokens: 65536,         // số token tối đa cho phép (64k)
  });

  // 7. Biến để tích lũy raw JSON và theo dõi kích thước phần object đã gửi
  let rawJson = '';
  let lastPartialSize = 0;

  // 8. Duyệt qua fullStream của result – mỗi phần có một type khác nhau
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      // Khi nhận được đoạn text (thường là JSON đang được sinh)
      rawJson += part.textDelta || '';
      // Gửi sự kiện object_delta với đoạn text vừa nhận
      sendSSE(res, 'object_delta', {
        provider: 'vercel-ai-sdk/google',
        model: GEMINI_MODEL,
        delta: part.textDelta || '',
        receivedChars: rawJson.length,
      });
      continue;
    }

    if (part.type === 'object') {
      // Khi SDK đã parse thành object (một phần hoặc toàn bộ)
      const partialJson = JSON.stringify(part.object);
      // Chỉ gửi nếu kích thước tăng hơn 120 ký tự để tránh spam
      if (partialJson.length > lastPartialSize + 120) {
        lastPartialSize = partialJson.length;
        sendSSE(res, 'object_partial', {
          provider: 'vercel-ai-sdk/google',
          model: GEMINI_MODEL,
          partial: part.object,
          receivedChars: partialJson.length,
        });
      }
      continue;
    }

    if (part.type === 'error') {
      // Nếu có lỗi từ SDK, throw
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  // 9. Lấy object cuối cùng (đã được validate theo schema)
  const object = await result.object;
  // 10. Chuẩn hóa mindmap (normalize) và parse qua Zod (dùng parse để throw nếu sai)
  const mindmap = normalizeMindmap(MindmapDocumentSchema.parse(object));
  // 11. Lấy thông tin usage (token) nếu có
  const usage = await result.usage.catch(() => null);

  // 12. Trả về kết quả
  return {
    mindmap,
    provider: 'vercel-ai-sdk/google',
    model: GEMINI_MODEL,
    rawLength: rawJson.length,
    usage,
  };
}

// Thực hiện gọi trực tiếp Gemini File API để phân tích tài liệu và sinh JSON theo schema.
async function generateWithGeminiFile(file, res) {
  // Hàm này gọi Gemini File API trực tiếp (không qua Vercel AI SDK) để upload file,
  // chờ xử lý, và generate content stream với schema, sau đó parse JSON và normalize.

  let lastError = null;
  // Biến lưu lỗi cuối cùng để ném ra nếu tất cả các lần thử đều thất bại

  // Tính số lần thử tối đa: bằng số lượng key tối đa hiện tại (tối thiểu 1)
  const attempts = GEMINI_KEYS.length || 1;

  // Vòng lặp thử lại với các API key khác nhau (tối đa attempts lần)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const apiKey = keyManager.next(); // Lấy key tiếp theo (round-robin)
    if (!apiKey) break; // Nếu không có key nào thì thoát

    const ai = new GoogleGenAI({ apiKey }); // Tạo instance Gemini SDK với key
    let uploadedFile = null; // Lưu thông tin file đã upload (để cleanup sau)

    try {
      // Gửi sự kiện progress qua SSE: bắt đầu upload file lên Gemini
      progress(res, `Đang upload file lên Gemini File API (${attempt + 1}/${attempts})...`, 20);

      // Upload file lên Gemini File API
      uploadedFile = await ai.files.upload({
        file: file.path,               // Đường dẫn local
        config: {
          mimeType: file.mimetype,     // Loại MIME của file
          displayName: file.originalname, // Tên hiển thị
        },
      });

      // Chờ Gemini xử lý file (state chuyển sang ACTIVE)
      uploadedFile = await waitForGeminiFile(ai, uploadedFile, res);
      if (!uploadedFile.uri) throw new Error('Gemini File API không trả về file URI.');

      // Gửi progress: bắt đầu generate content
      progress(res, `Đang sinh JSON có schema bằng ${GEMINI_MODEL}...`, 40);

      // Gọi Gemini generate content stream với schema
      const stream = await ai.models.generateContentStream({
        model: GEMINI_MODEL,
        contents: [{
          role: 'user',
          parts: [
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType || file.mimetype),
            { text: buildGeminiPrompt(file.originalname) },
          ],
        }],
        config: {
          temperature: 0.1,            // Độ sáng tạo thấp
          topP: 0.9,
          maxOutputTokens: 65536,      // Token tối đa
          responseMimeType: 'application/json', // Yêu cầu JSON
          responseSchema: GEMINI_MINDMAP_SCHEMA, // Schema Gemini
        },
      });

      // Thu thập stream thành chuỗi JSON và gửi object_delta qua SSE
      let rawJson = '';
      for await (const chunk of stream) {
        const text = getChunkText(chunk); // Trích xuất text từ chunk
        if (!text) continue;
        rawJson += text;
        sendSSE(res, 'object_delta', {
          provider: 'gemini',
          model: GEMINI_MODEL,
          delta: text,
          receivedChars: rawJson.length,
        });
      }

      // Parse JSON và normalize
      const mindmap = normalizeMindmap(JSON.parse(rawJson));

      // Trả về kết quả thành công
      return {
        mindmap,
        provider: 'gemini',
        model: GEMINI_MODEL,
        rawLength: rawJson.length,
      };

    } catch (error) {
      // Lưu lỗi và log
      lastError = error;
      console.warn(`[Gemini] Attempt ${attempt + 1} failed:`, error.message);

      // Nếu lỗi không phải rate limit (429/quota/rate) và đây là lần thử cuối, thì break
      const rateLimited = /429|quota|rate/i.test(error.message || '');
      if (!rateLimited && attempt >= attempts - 1) break;
      // Nếu là rate limit, vòng lặp sẽ tiếp tục với key khác (nếu còn)
    } finally {
      // Dọn dẹp: xóa file đã upload trên Gemini (để tránh lãng phí lưu trữ)
      if (uploadedFile?.name) {
        ai.files.delete({ name: uploadedFile.name }).catch((error) => {
          console.warn(`[Gemini] Failed to delete remote file ${uploadedFile.name}:`, error.message);
        });
      }
    }
  }

  // Nếu tất cả các lần thử đều thất bại, ném lỗi cuối cùng
  throw new Error(`Gemini File API thất bại: ${lastError?.message || 'chưa có API key hợp lệ'}`);
}
// === IX. HÀM ĐẾM SỐ TRANG CHO PDF VÀ DOCX ===
// Đọc tài liệu PDF để đếm tổng số trang và trích xuất văn bản thô.
async function getPDFPageCount(filePath) {
  // Hàm này đọc một file PDF từ đường dẫn, trích xuất số trang và văn bản.
  // Nó dùng thư viện PDFParse (từ pdf-parse) để xử lý.

  const dataBuffer = await fs.promises.readFile(filePath);
  // Đọc toàn bộ file PDF vào bộ nhớ dưới dạng Buffer (dữ liệu nhị phân).
  // await để đợi file được đọc xong.

  const parser = new PDFParse({ data: dataBuffer });
  // Khởi tạo đối tượng PDFParser với dữ liệu buffer vừa đọc.
  // PDFParse là class từ thư viện pdf-parse, dùng để parse PDF.

  const result = await parser.getText();
  // Gọi phương thức getText() để parse PDF và trả về kết quả.
  // Kết quả là một object chứa thông tin: total (số trang), text (văn bản đã trích xuất), v.v.

  return {
    numPages: result.total || 1,
    // Số trang: lấy từ result.total, nếu không có thì mặc định 1.
    text: result.text || ''
    // Văn bản: lấy từ result.text, nếu không có thì mặc định chuỗi rỗng.
  };
}
// Đọc tệp tin Word (docx) như một zip để giải nén metadata và trích xuất số trang từ thuộc tính Pages.
function getDocxPageCount(filePath) {
  // Hàm này đọc file .docx (Microsoft Word) và trả về số trang.
  // DOCX thực chất là một file ZIP chứa nhiều file XML, trong đó metadata nằm ở docProps/app.xml.

  try {
    // 1. Khởi tạo đối tượng AdmZip để đọc file docx như một file zip
    const zip = new AdmZip(filePath);

    // 2. Lấy entry (file bên trong) có đường dẫn 'docProps/app.xml'
    // File này chứa thông tin metadata của tài liệu, bao gồm số trang (Pages)
    const entry = zip.getEntry('docProps/app.xml');

    // 3. Nếu không có entry này (có thể file docx lỗi hoặc định dạng cũ), trả về 1 (mặc định)
    if (!entry) return 1;

    // 4. Đọc dữ liệu của entry dưới dạng buffer, chuyển thành chuỗi UTF-8 (XML text)
    const xml = entry.getData().toString('utf8');

    // 5. Dùng regex để tìm thẻ <Pages>số trang</Pages>
    const match = xml.match(/<Pages>(\d+)<\/Pages>/);

    // 6. Nếu tìm thấy, parse số trang thành integer và trả về; nếu không, trả về 1
    return match ? parseInt(match[1], 10) : 1;

  } catch (err) {
    // 7. Nếu có bất kỳ lỗi nào (file không đọc được, zip lỗi, parse lỗi...)
    // thì log cảnh báo và trả về 1 (mặc định) để không làm gián đoạn luồng xử lý
    console.warn('[DocxPageCount] Lỗi đọc số trang docx, mặc định 1:', err.message);
    return 1;
  }
}

// === X. HÀM FALLBACK (GROQ, OPENROUTER) ===
// Kiểm tra tệp tin có hỗ trợ trích xuất văn bản để chạy chế độ dự phòng (fallback) hay không.
function canUseTextFallback(file) {
  // Hàm này kiểm tra xem một file có hỗ trợ trích xuất văn bản để dùng làm fallback (dự phòng) hay không.

  // Danh sách các loại MIME được hỗ trợ:
  // - text/plain: file văn bản thuần (TXT)
  // - application/pdf: file PDF
  // - application/vnd.openxmlformats-officedocument.wordprocessingml.document: file DOCX (Word)
  const supported = [
    'text/plain',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  // Kiểm tra xem MIME type của file có nằm trong danh sách hỗ trợ không
  // Nếu có, trả về true (có thể dùng fallback), ngược lại false
  return supported.includes(file.mimetype);
}

// Trích xuất toàn bộ văn bản từ tài liệu PDF, Word hoặc Text để làm nội dung đầu vào dự phòng.
async function readTextForFallback(file) {
  // Hàm này đọc nội dung văn bản thô từ các file hỗ trợ (TXT, PDF, DOCX)
  // để sử dụng làm đầu vào cho AI (Groq/OpenRouter) khi Gemini thất bại.
  // Mục đích: trích xuất nội dung văn bản từ file để gửi kèm trong prompt của fallback.

  let text = ''; // Biến lưu nội dung văn bản đã trích xuất

  // === Xử lý các loại file khác nhau ===

  if (file.mimetype === 'text/plain') {
    // Với file TXT: đọc trực tiếp nội dung file dưới dạng UTF-8
    text = await fs.promises.readFile(file.path, 'utf8');
  } 
  else if (file.mimetype === 'application/pdf') {
    // Với file PDF: đọc file, parse bằng PDFParse và trích xuất text
    const dataBuffer = await fs.promises.readFile(file.path);
    const parser = new PDFParse({ data: dataBuffer });
    const result = await parser.getText();
    text = result.text || '';
  } 
  else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    // Với file DOCX: dùng mammoth để trích xuất raw text (không format)
    const result = await mammoth.extractRawText({ path: file.path });
    text = result.value || '';
  }

  // Giới hạn số ký tự lấy ra để tránh vượt quá token của AI
  return text.slice(0, MAX_FALLBACK_TEXT_CHARS);
}

// Sử dụng Groq (Llama model) làm phương án dự phòng khi Gemini gặp lỗi.
// Dùng response_format json_schema để API ép buộc trả về JSON đúng cấu trúc, không cần parse thủ công.
async function generateWithGroqText(file, text, res) {
  // Hàm này là một phương án dự phòng (fallback) khi Gemini gặp lỗi.
  // Nó gọi Groq API (một nhà cung cấp AI khác) để phân tích văn bản và sinh mindmap.

  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY chưa được cấu hình.');
  // Kiểm tra xem API key của Groq có tồn tại không. Nếu không, ném lỗi.

  progress(res, `Gemini lỗi, đang chuyển sang Groq (${GROQ_MODEL})...`, 45);
  // Gửi sự kiện progress qua SSE để thông báo cho client biết đang chuyển sang Groq.

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    // Endpoint của Groq tương thích với OpenAI API (chat completions)
    {
      model: GROQ_MODEL,                         // Model Groq (ví dụ: llama-3.1-8b-instant)
      messages: [
        { role: 'system', content: 'Trả về duy nhất JSON đúng schema được chỉ định.' },
        // System prompt: hướng dẫn AI chỉ trả về JSON
        { role: 'user', content: buildFallbackPrompt(file.originalname, text) },
        // User prompt: xây dựng từ tên file và nội dung văn bản đã trích xuất
      ],
      temperature: 0.1,                          // Độ sáng tạo thấp để ưu tiên chính xác
      max_tokens: 16384,                         // Số token tối đa cho output
      response_format: { type: 'json_schema', json_schema: FALLBACK_JSON_SCHEMA },
      // Ép buộc AI trả về JSON theo schema đã định nghĩa (FALLBACK_JSON_SCHEMA)
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`, // Xác thực với API key
        'Content-Type': 'application/json',
      },
      timeout: 60000,                            // Timeout 60 giây
    },
  );

  const content = response.data?.choices?.[0]?.message?.content;
  // Lấy nội dung trả về từ AI (JSON string)

  if (!content) throw new Error('Groq không trả về nội dung.');
  // Nếu không có content, ném lỗi

  return {
    mindmap: normalizeMindmap(JSON.parse(content)),
    // Parse JSON và chuẩn hóa mindmap
    provider: 'groq',                            // Ghi nhận provider
    model: GROQ_MODEL,                           // Tên model đã dùng
    rawLength: content.length,                   // Độ dài của JSON trả về
  };
}

// Sử dụng OpenRouter để thử nghiệm lần lượt nhiều mô hình dự phòng khác nhau (Gemini, Qwen, DeepSeek).
// Dùng response_format json_schema để API ép buộc trả về JSON đúng cấu trúc, không cần parse thủ công.
async function generateWithOpenRouterText(file, text, res) {
  // Hàm này là fallback cuối cùng trong chuỗi dự phòng. Nó gọi OpenRouter - một gateway cho phép truy cập nhiều mô hình AI từ nhiều nhà cung cấp khác nhau.
  // Mục đích: thử nghiệm nhiều mô hình khác nhau để tăng khả năng thành công khi Gemini và Groq đều thất bại.

  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY chưa được cấu hình.');
  // Kiểm tra API key OpenRouter. Nếu không có, ném lỗi.

  const models = Array.from(new Set([
    OPENROUTER_MODEL,                              // Mô hình mặc định từ biến môi trường (ví dụ: openrouter/auto)
    'google/gemini-2.0-flash-lite-preview:free',   // Gemini Lite miễn phí
    'qwen/qwen-2.5-72b-instruct:free',             // Qwen 72B miễn phí
    'google/gemini-2.5-flash',                     // Gemini Flash
    'deepseek/deepseek-chat'                       // DeepSeek Chat
  ].filter(Boolean)));
  // Danh sách các mô hình sẽ thử lần lượt. Thứ tự ưu tiên: model do user cấu hình trước, sau đó các model miễn phí.
  // filter(Boolean) loại bỏ các giá trị falsy (nếu OPENROUTER_MODEL rỗng).

  let lastError = null;
  // Biến lưu lỗi cuối cùng để ném ra nếu tất cả đều thất bại.

  for (const model of models) {
    // Vòng lặp thử từng model
    try {
      progress(res, `Đang chuyển sang OpenRouter (${model})...`, 50);
      // Gửi progress SSE để client biết đang thử model nào

      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        // OpenRouter endpoint tương thích với OpenAI API
        {
          model: model,                              // Model hiện tại trong vòng lặp
          messages: [
            { role: 'system', content: 'Trả về duy nhất JSON đúng schema được chỉ định.' },
            { role: 'user', content: buildFallbackPrompt(file.originalname, text) },
          ],
          temperature: 0.1,                          // Độ sáng tạo thấp
          max_tokens: 8192,                          // Giới hạn max output của các model OpenRouter (thường tối đa 8k)
          response_format: { type: 'json_schema', json_schema: FALLBACK_JSON_SCHEMA },
          // Yêu cầu JSON schema (OpenRouter hỗ trợ OpenAI-compatible)
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.APP_PUBLIC_URL || 'http://localhost:3000',
            'X-Title': 'Mindmap Generator',
            // Các header bổ sung để OpenRouter định danh ứng dụng
          },
          timeout: 90000,                            // Timeout 90s (cao hơn Groq)
        },
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from OpenRouter');
      // Lấy content, nếu rỗng thì ném lỗi

      // Parse JSON và normalize, trả về kết quả thành công
      return {
        mindmap: normalizeMindmap(JSON.parse(content)),
        provider: 'openrouter',
        model: model,
        rawLength: content.length,
      };
    } catch (err) {
      // Nếu model này thất bại, lưu lỗi và log, sau đó thử model tiếp theo
      lastError = err;
      console.warn(`[Gateway] OpenRouter model ${model} failed:`, err.message);
    }
  }

  // Nếu tất cả các model đều thất bại, ném lỗi tổng hợp
  throw new Error(`Tất cả các model của OpenRouter đều thất bại: ${lastError?.message}`);
}

// === XI. HÀM TỔNG HỢP GENERATEMINDMAPWITHFALLBACK ===
// Hàm gateway tự động thử các phương pháp phân tích tài liệu theo thứ tự ưu tiên giảm dần.
async function generateMindmapWithFallback(file, res) {
  // Hàm gateway (cổng kết nối) quản lý toàn bộ chiến lược gọi AI.
  // Nó thử các phương pháp phân tích tài liệu theo thứ tự ưu tiên giảm dần,
  // tự động chuyển sang phương án dự phòng nếu phương án trước thất bại.

  try {
    // === PHƯƠNG ÁN 1: VERCEL AI SDK (GEMINI) ===
    // Đây là lựa chọn ưu tiên hàng đầu vì nó có streaming và schema validation tốt.
    return await generateWithVercelStreamObject(file, res);
  } catch (aiSdkError) {
    // Nếu Vercel AI SDK thất bại (lỗi key, lỗi mạng, parse lỗi...)
    console.warn('[Gateway] Vercel AI SDK streamObject failed:', aiSdkError.message);

    try {
      // === PHƯƠNG ÁN 2: GEMINI FILE API ===
      // Gọi trực tiếp Gemini File API (không qua Vercel), vẫn dùng schema của Gemini.
      progress(res, 'streamObject lỗi, chuyển sang Gemini File API trực tiếp...', 40);
      return await generateWithGeminiFile(file, res);
    } catch (geminiError) {
      // Nếu Gemini File API cũng thất bại
      console.warn('[Gateway] Gemini File API failed:', geminiError.message);

      // === KIỂM TRA HỖ TRỢ FALLBACK TEXT ===
      // Nếu file không hỗ trợ trích xuất văn bản (ví dụ ảnh), thì không thể dùng text fallback.
      // Ném lỗi để dừng xử lý.
      if (!canUseTextFallback(file)) throw geminiError;

      // === TRÍCH XUẤT VĂN BẢN TỪ FILE ===
      // Đọc nội dung thô của file (TXT, PDF, DOCX) để chuẩn bị cho fallback.
      const text = await readTextForFallback(file);

      try {
        // === PHƯƠNG ÁN 3: GROQ ===
        // Gọi Groq API (Llama model) để phân tích văn bản.
        return await generateWithGroqText(file, text, res);
      } catch (groqError) {
        // Nếu Groq thất bại
        console.warn('[Gateway] Groq failed:', groqError.message);

        // === PHƯƠNG ÁN 4: OPENROUTER (CUỐI CÙNG) ===
        // Gọi OpenRouter - thử nhiều model khác nhau để tăng khả năng thành công.
        // Đây là phương án cuối cùng, nếu thất bại sẽ ném lỗi.
        return generateWithOpenRouterText(file, text, res);
      }
    }
  }
}

// === XII. XÂY DỰNG PAYLOAD VÀ LƯU CACHE ===
// Gọi AI phân tích và xây dựng cấu trúc dữ liệu kết quả đầy đủ (JSON + Markdown + Metadata).
async function buildMindmapPayload(file, fileHash, res, startedAt) {
  // Hàm này tập hợp toàn bộ quá trình: gọi AI, tạo Markdown, đóng gói kết quả.
  // Nó trả về một payload hoàn chỉnh để lưu cache và gửi về client.

  // Gọi hàm generateMindmapWithFallback (tự động thử nhiều dịch vụ AI) để lấy mindmap.
  // Hàm này trả về object: { mindmap, provider, model, rawLength, usage? }
  const generated = await generateMindmapWithFallback(file, res);

  // Gửi sự kiện progress (SSE) để thông báo client đang tạo Markdown.
  progress(res, 'Đang tạo Markdown từ JSON đã validate...', 85);

  // Chuyển đổi mindmap JSON thành Markdown (dùng để visualize với markmap).
  const markdown = generateMarkdownFromMindmap(generated.mindmap);

  // Trả về payload với đầy đủ dữ liệu.
  return {
    markdown,                               // Markdown text để hiển thị
    mindmap: generated.mindmap,             // JSON đã chuẩn hóa
    visualizationKey: fileHash,             // Hash dùng để tạo URL xem mindmap
    stats: {
      provider: generated.provider,         // 'vercel-ai-sdk/google', 'gemini', 'groq', 'openrouter'
      model: generated.model,               // Tên model đã dùng
      rawLength: generated.rawLength,       // Độ dài JSON thô
      fileHash,                             // SHA-256 của file
      fileName: file.originalname,          // Tên file gốc
      fileType: file.mimetype,              // Loại MIME
      fileSize: file.size,                  // Dung lượng file (bytes)
      processingTime: Date.now() - startedAt, // Thời gian xử lý (ms)
      cached: false,                        // Đánh dấu đây là kết quả mới (không từ cache)
      mainTopic: generated.mindmap.mainTopic, // Chủ đề chính
    },
    cachedAt: new Date().toISOString(),     // Thời gian tạo
  };
}

// Lưu bản ghi tài liệu đã xử lý vào cơ sở dữ liệu MongoDB để theo dõi lịch sử.
async function saveDocumentRecord(req, file, fileHash) {
  // Hàm này lưu thông tin của file đã xử lý vào DB (dùng để thống kê và lịch sử).

  const db = req.app.locals.usersDb;          // Lấy database từ app.locals
  if (!db || !req.session?.user) return;      // Nếu chưa đăng nhập hoặc chưa có DB thì bỏ qua

  const docRecord = {
    title: file.originalname,                 // Tên file gốc
    fileType: file.mimetype,                  // Loại MIME
    size: file.size,                          // Dung lượng file
    hash: fileHash,                           // SHA-256
    userId: req.session.user._id.toString(), // ID người dùng (dạng string)
    username: req.session.user.username || 'unknown', // Tên user
    createdAt: new Date(),                    // Thời gian upload
    status: 'active',                         // Trạng thái (active = còn hiệu lực)
  };

  // Chèn vào collection 'documents' (bất đồng bộ, không đợi để không chặn luồng chính)
  db.collection('documents').insertOne(docRecord)
    .catch((error) => console.error('Lỗi lưu tài liệu vào DB:', error));
}

// === XIII. HÀM XỬ LÝ UPLOAD STREAMING CHÍNH ===
// Xử lý chính luồng tải lên và phân tích tài liệu (kiểm tra cache, giới hạn trang, concurrency, stream kết quả).
async function processStreamingUpload(req, res) {
  // Đây là hàm xử lý chính khi client upload file lên server.
  // Nó quản lý toàn bộ vòng đời: nhận file, tính hash, kiểm tra cache, gọi AI, stream kết quả, lưu cache.

  const file = req.file;
  // Lấy thông tin file đã được multer xử lý và lưu vào req.file.

  const startedAt = Date.now();
  // Ghi lại thời điểm bắt đầu để tính thời gian xử lý.

  if (!file) {
    return res.status(400).json({ error: 'Không có file nào được tải lên.' });
  }
  // Nếu không có file, trả về lỗi 400.

  writeSSEHeaders(res);
  // Thiết lập header cho Server-Sent Events để bắt đầu stream.

  try {
    // 1. TÍNH HASH VÀ LƯU LỊCH SỬ
    progress(res, 'Đã nhận file, đang tính SHA-256 để kiểm tra cache...', 5);
    // Gửi sự kiện progress qua SSE: bắt đầu tính hash.

    const fileHash = await hashFile(file.path);
    // Tính SHA-256 của file (dùng stream để không tốn RAM).

    await saveDocumentRecord(req, file, fileHash);
    // Lưu metadata của file vào database (lịch sử upload).

    // 2. KIỂM TRA CACHE
    const key = cacheKey(fileHash);
    // Tạo cache key từ hash (ví dụ: "mindmap:document:abc123...").

    const cached = await documentCache.get(key);
    // Hỏi cache xem có kết quả đã xử lý cho file này chưa.

    if (cached?.markdown) {
      // Nếu có cache và có markdown trong đó → cache hit.
      const payload = {
        ...cached,
        visualizationKey: fileHash,
        stats: {
          ...(cached.stats || {}),
          cached: true,
          processingTime: Date.now() - startedAt,
        },
      };
      // Xây dựng payload từ dữ liệu cache, thêm thời gian xử lý (ngắn vì là cache) và đánh dấu cached.

      progress(res, 'Cache hit: đã tìm thấy mindmap cho file này.', 95, { cache: 'hit' });
      // Gửi progress báo cache hit.

      sendSSE(res, 'complete', {
        markdown: payload.markdown,
        mindmap: payload.mindmap,
        visualizationUrl: `/upload/mindmap-visualization/${fileHash}`,
        stats: payload.stats,
      });
      // Gửi sự kiện 'complete' với kết quả trực tiếp từ cache.

      return;
      // Kết thúc luồng xử lý (không gọi AI).
    }

    // 3. CACHE MISS – BẮT ĐẦU XỬ LÝ MỚI
    progress(res, 'Cache miss: file mới, đưa vào pool xử lý AI.', 12, { cache: 'miss' });
    // Báo cache miss.

    // 4. KIỂM TRA SỐ TRANG (chỉ với PDF và DOCX)
    let pageCount = 1;
    if (file.mimetype === 'application/pdf') {
      try {
        progress(res, 'Đang kiểm tra số trang tài liệu PDF...', 15);
        const pdfData = await getPDFPageCount(file.path);
        pageCount = pdfData.numPages;
      } catch (err) {
        console.error('[PageCount] Lỗi đọc số trang PDF:', err);
        throw new Error('Không thể đọc số trang của tài liệu PDF. File có thể bị lỗi.');
      }
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      try {
        progress(res, 'Đang kiểm tra số trang tài liệu DOCX...', 15);
        pageCount = getDocxPageCount(file.path);
      } catch (err) {
        console.error('[PageCount] Lỗi đọc số trang DOCX:', err);
        throw new Error('Không thể đọc số trang của tài liệu Word (DOCX). File có thể bị lỗi.');
      }
    }
    // Nếu là PDF hoặc DOCX, đọc số trang. Nếu lỗi, ném exception.

    if (pageCount > 200) {
      throw new Error(`Tài liệu quá dài (${pageCount} trang). Hệ thống chỉ chấp nhận tài liệu dưới 200 trang để đảm bảo hiệu suất AI.`);
    }
    // Giới hạn số trang tối đa 200 để tránh quá tải AI.

    // 5. QUẢN LÝ XỬ LÝ ĐỒNG THỜI (IN-FLIGHT REQUEST)
    let ownsInFlight = false;
    let payloadPromise = inFlightDocuments.get(fileHash);
    if (payloadPromise) {
      progress(res, 'File này đang được xử lý bởi request khác, đang chờ kết quả dùng chung...', 30);
      // Nếu có một request khác đang xử lý file này, chờ kết quả đó.
    } else {
      payloadPromise = runWithAiLimit(() => buildMindmapPayload(file, fileHash, res, startedAt));
      // Nếu chưa ai xử lý, tạo một promise mới và gắn vào inFlightDocuments.
      inFlightDocuments.set(fileHash, payloadPromise);
      ownsInFlight = true;
      // Đánh dấu là chủ sở hữu promise này để xóa sau khi hoàn thành.
    }

    // 6. CHỜ KẾT QUẢ
    const payload = await payloadPromise.finally(() => {
      if (ownsInFlight) inFlightDocuments.delete(fileHash);
      // Khi promise hoàn thành (hoặc lỗi), xóa khỏi inFlightDocuments nếu là chủ sở hữu.
    });

    // 7. LƯU CACHE VÀ TRẢ KẾT QUẢ
    await documentCache.set(key, payload, CACHE_TTL_SECONDS);
    // Lưu kết quả vào cache với TTL (mặc định 7 ngày).

    progress(res, 'Hoàn tất, đã lưu kết quả vào cache.', 100);
    // Gửi progress hoàn tất.

    sendSSE(res, 'complete', {
      markdown: payload.markdown,
      mindmap: payload.mindmap,
      visualizationUrl: `/upload/mindmap-visualization/${fileHash}`,
      stats: payload.stats,
    });
    // Gửi kết quả cuối cùng qua SSE.

  } catch (error) {
    // BẮT LỖI
    console.error('Document streaming failed:', error);
    sendSSE(res, 'error', { message: error.message || 'Lỗi xử lý tài liệu.' });
    // Gửi sự kiện lỗi qua SSE.
  } finally {
    // DỌN DẸP: LUÔN XÓA FILE TẠM
    await cleanupLocalUpload(file.path);
    // Xóa file tạm đã upload (dù thành công hay thất bại).

    if (!res.writableEnded) res.end();
    // Kết thúc response nếu chưa bị đóng.
  }
}

// === XIV. ĐỊNH NGHĨA CÁC ROUTE ===
// Route hiển thị giao diện trang tải lên tài liệu.
router.get('/page', authMiddleware.checkLoggedIn, documentController.getUploadPage);

// Route chính tiếp nhận file tải lên, tính toán cache và stream tiến trình/kết quả.
router.post('/summarize-stream', authMiddleware.checkLoggedIn, handleDocumentUpload, (req, res) => {
  processStreamingUpload(req, res);
});

// Endpoint cũ đã bị loại bỏ (trả về lỗi 410).
router.post('/start-summarize', authMiddleware.checkLoggedIn, (req, res) => {
  res.status(410).json({
    error: 'Endpoint cũ đã được thay bằng POST /upload/summarize-stream để stream trực tiếp, không còn tạo job trong RAM.',
  });
});

// Điều hướng mặc định của module upload tài liệu.
router.get('/', (req, res) => {
  res.redirect('/upload/page');
});

// Trích xuất kết quả từ cache và hiển thị giao diện HTML Markmap động tương tác.
router.get('/mindmap-visualization/:hash', authMiddleware.checkLoggedIn, async (req, res) => {
  const { hash } = req.params;
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    return res.status(400).send('Visualization key không hợp lệ.');
  }

  const payload = await documentCache.get(cacheKey(hash));
  if (!payload?.markdown) {
    return res.status(404).send(`
      <h1 style="font-family: sans-serif; color: #d9534f;">404 - Không tìm thấy sơ đồ</h1>
      <p style="font-family: sans-serif;">Kết quả có thể đã hết hạn cache hoặc server chưa cấu hình Redis bền vững.</p>
      <a href="/upload/page">Quay lại trang tải lên</a>
    `);
  }

  try {
    const html = generateMindmapHTML(payload.markdown, payload.stats?.mainTopic || safeFileTitle(payload.stats?.fileName));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error(`[Visualization] Error generating HTML for hash ${hash}:`, error);
    res.status(500).send('Không thể tạo trang trực quan hóa.');
  }
});

// === XV. HÀM GENERATEMINDMAPHTML ===
// Tạo trang HTML tĩnh tự chứa thư viện d3 và markmap để vẽ sơ đồ từ Markdown.
function generateMindmapHTML(markdownContent, title = 'Mindmap Visualization') {
  const safeTitle = String(title || 'Mindmap Visualization')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const normalizedMarkdown = markdownContent && markdownContent.trim()
    ? markdownContent.trim()
    : '# Lỗi\n\nKhông có nội dung Markdown.';

  const escapedMarkdown = normalizedMarkdown
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');

  return `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <script src="https://cdn.jsdelivr.net/npm/markmap-lib@0.15.4"></script>
  <script src="https://cdn.jsdelivr.net/npm/markmap-view@0.15.4"></script>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", Tahoma, sans-serif; background: #f5f7fb; color: #172033; }
    .shell { min-height: 100vh; display: flex; flex-direction: column; }
    header { padding: 18px 24px; background: #174ea6; color: #fff; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    header h1 { margin: 0; font-size: 20px; font-weight: 650; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    button, a { border: 0; border-radius: 6px; padding: 9px 13px; font-size: 14px; cursor: pointer; text-decoration: none; }
    .primary { background: #fff; color: #174ea6; }
    .secondary { background: rgba(255,255,255,0.16); color: #fff; }
    main { flex: 1; display: grid; grid-template-columns: minmax(280px, 380px) 1fr; min-height: 0; }
    aside { padding: 18px; background: #fff; border-right: 1px solid #dbe2ef; overflow: auto; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.45; }
    #mindmap { width: 100%; height: calc(100vh - 66px); background: #fbfcff; }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      aside { max-height: 34vh; border-right: 0; border-bottom: 1px solid #dbe2ef; }
      #mindmap { height: 62vh; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <h1>${safeTitle}</h1>
      <div class="actions">
        <button class="primary" onclick="fitMap()">Fit</button>
        <button class="secondary" onclick="window.print()">In</button>
        <a class="secondary" href="/upload/page">Quay lại</a>
      </div>
    </header>
    <main>
      <aside><pre>${normalizedMarkdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></aside>
      <svg id="mindmap"></svg>
    </main>
  </div>
  <script>
    const markdownContent = \`${escapedMarkdown}\`;
    let mm = null;
    function render() {
      if (!window.markmap || !window.markmap.Transformer || !window.markmap.Markmap) {
        setTimeout(render, 200);
        return;
      }
      const transformer = new window.markmap.Transformer();
      const { root } = transformer.transform(markdownContent);
      const svg = document.getElementById('mindmap');
      svg.innerHTML = '';
      mm = window.markmap.Markmap.create(svg, { autoFit: true, duration: 300 }, root);
    }
    function fitMap() {
      if (mm && typeof mm.fit === 'function') mm.fit();
    }
    render();
  </script>
</body>
</html>`;
}

// === XVI. XUẤT ROUTER ===
module.exports = router;
