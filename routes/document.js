// routes/document.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('redis');
const { z } = require('zod');
const { GoogleGenAI, createPartFromUri, Type, FileState } = require('@google/genai');
const authMiddleware = require('../middlewares/middlewares.js');
const documentController = require('../controllers/documentController.js');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';

const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY || process.env.GLOBAL_AI_CONCURRENCY || '3', 10);
const CACHE_TTL_SECONDS = parseInt(process.env.DOCUMENT_CACHE_TTL_SECONDS || String(7 * 24 * 60 * 60), 10);
const MAX_UPLOAD_MB = parseFloat(process.env.MAX_DOCUMENT_UPLOAD_MB || '5');
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);
const MAX_FALLBACK_TEXT_CHARS = parseInt(process.env.MAX_FALLBACK_TEXT_CHARS || '120000', 10);
const TEMP_UPLOAD_DIR = path.join(__dirname, '..', 'temp', 'uploads');
const CACHE_PREFIX = 'mindmap:document:';

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

if (GEMINI_KEYS.length === 0) console.warn('Gemini API key is not configured. Gemini File API calls will fail.');
if (!GROQ_API_KEY) console.warn('GROQ_API_KEY is not configured. Groq fallback is disabled.');
if (!OPENROUTER_API_KEY) console.warn('OPENROUTER_API_KEY is not configured. OpenRouter fallback is disabled.');

let pLimitInstance = null;
async function runWithAiLimit(task) {
  if (!pLimitInstance) {
    const { default: pLimit } = await import('p-limit');
    pLimitInstance = pLimit(Math.max(1, AI_CONCURRENCY));
  }
  return pLimitInstance(task);
}

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

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/gif',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(new Error('Chỉ chấp nhận PDF, DOCX, TXT, JPG, PNG hoặc GIF.'));
    }
    cb(null, true);
  },
});

function handleDocumentUpload(req, res, next) {
  upload.single('documentFile')(req, res, (err) => {
    if (!err) return next();

    if (req.file?.path) {
      cleanupLocalUpload(req.file.path).catch((cleanupError) => {
        console.warn('[handleDocumentUpload] Failed to cleanup rejected upload:', cleanupError.message);
      });
    }

    const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
      ? `File quá lớn. Giới hạn hiện tại là ${MAX_UPLOAD_MB}MB.`
      : err.message || 'Lỗi tải file.';
    return res.status(400).json({ error: message });
  });
}

const MindmapLeafSchema = z.object({
  title: z.string().trim().min(1),
  points: z.array(z.string().trim().min(1)).optional().default([]),
});

const MindmapChildSchema = z.object({
  title: z.string().trim().min(1),
  points: z.array(z.string().trim().min(1)).optional().default([]),
  children: z.array(MindmapLeafSchema).optional().default([]),
});

const MindmapDocumentSchema = z.object({
  mainTopic: z.string().trim().min(1),
  summary: z.string().trim().optional().default(''),
  subTopics: z.array(z.object({
    chapterTitle: z.string().trim().min(1),
    points: z.array(z.string().trim().min(1)).optional().default([]),
    children: z.array(MindmapChildSchema).optional().default([]),
  })).min(1),
});

function childResponseSchema(depth = 0) {
  const schema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      points: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
    },
    required: ['title', 'points'],
    propertyOrdering: ['title', 'points'],
  };

  if (depth < 2) {
    schema.properties.children = {
      type: Type.ARRAY,
      items: childResponseSchema(depth + 1),
    };
    schema.required.push('children');
    schema.propertyOrdering.push('children');
  }

  return schema;
}

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

class DocumentCache {
  constructor() {
    this.memory = new Map();
    this.redisClientPromise = null;
    this.redisUrl = process.env.REDIS_URL;
    this.upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    this.upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  }

  async get(key) {
    try {
      const value = await this.getRemote(key);
      if (value) return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (error) {
      console.warn(`[DocumentCache] Remote get failed for ${key}:`, error.message);
    }

    const local = this.memory.get(key);
    if (!local) return null;
    if (local.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return local.value;
  }

  async set(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
    const serialized = JSON.stringify(value);
    try {
      await this.setRemote(key, serialized, ttlSeconds);
    } catch (error) {
      console.warn(`[DocumentCache] Remote set failed for ${key}:`, error.message);
    }

    this.memory.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async getRemote(key) {
    if (this.upstashUrl && this.upstashToken) {
      return this.upstashCommand(['GET', key]);
    }

    const client = await this.getRedisClient();
    return client ? client.get(key) : null;
  }

  async setRemote(key, serialized, ttlSeconds) {
    if (this.upstashUrl && this.upstashToken) {
      await this.upstashCommand(['SET', key, serialized, 'EX', String(ttlSeconds)]);
      return;
    }

    const client = await this.getRedisClient();
    if (client) await client.set(key, serialized, { EX: ttlSeconds });
  }

  async upstashCommand(command) {
    const response = await axios.post(
      this.upstashUrl.replace(/\/$/, ''),
      command,
      {
        headers: {
          Authorization: `Bearer ${this.upstashToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );
    if (response.data?.error) throw new Error(response.data.error);
    return response.data?.result;
  }

  async getRedisClient() {
    if (!this.redisUrl) return null;
    if (!this.redisClientPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on('error', (error) => console.warn('[DocumentCache] Redis error:', error.message));
      this.redisClientPromise = client.connect()
        .then(() => client)
        .catch((error) => {
          this.redisClientPromise = null;
          throw error;
        });
    }
    return this.redisClientPromise;
  }
}

const documentCache = new DocumentCache();
const inFlightDocuments = new Map();

function cacheKey(hash) {
  return `${CACHE_PREFIX}${hash}`;
}

function sendSSE(res, event, data) {
  if (!res || res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSSEHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function progress(res, message, percent, extra = {}) {
  sendSSE(res, 'progress', { message, percent, ...extra });
}

function isPathInside(childPath, parentPath) {
  const resolvedChild = path.resolve(childPath);
  const resolvedParent = path.resolve(parentPath);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function cleanupLocalUpload(filePath) {
  if (!filePath) return;
  if (!isPathInside(filePath, TEMP_UPLOAD_DIR)) {
    console.warn(`[cleanupLocalUpload] Refusing to delete outside temp upload dir: ${filePath}`);
    return;
  }
  await fs.promises.unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') console.warn(`[cleanupLocalUpload] Failed to delete ${filePath}:`, error.message);
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeFileTitle(filename) {
  return path.basename(filename || 'Sơ đồ tư duy').replace(/\.[^/.]+$/, '').trim() || 'Sơ đồ tư duy';
}

function getChunkText(chunk) {
  if (!chunk) return '';
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.text === 'function') return chunk.text();
  return chunk.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const withoutFence = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  if (withoutFence.startsWith('{') && withoutFence.endsWith('}')) return withoutFence;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < withoutFence.length; i += 1) {
    const char = withoutFence[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) return withoutFence.slice(start, i + 1);
    }
  }
  return withoutFence;
}

function parseMindmapJson(rawText) {
  const jsonText = extractJsonObject(rawText);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`AI trả về JSON không hợp lệ: ${error.message}`);
  }

  const result = MindmapDocumentSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(`JSON không đúng schema: ${firstIssue?.path?.join('.') || 'root'} ${firstIssue?.message || ''}`.trim());
  }
  return normalizeMindmap(result.data);
}

function normalizeMindmap(mindmap) {
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalizeChild = (child) => ({
    title: normalizeText(child.title),
    points: (child.points || []).map(normalizeText).filter(Boolean),
    children: (child.children || []).map(normalizeChild).filter((item) => item.title),
  });

  const normalized = {
    mainTopic: normalizeText(mindmap.mainTopic),
    summary: normalizeText(mindmap.summary),
    subTopics: (mindmap.subTopics || []).map((topic) => ({
      chapterTitle: normalizeText(topic.chapterTitle),
      points: (topic.points || []).map(normalizeText).filter(Boolean),
      children: (topic.children || []).map(normalizeChild).filter((item) => item.title),
    })).filter((topic) => topic.chapterTitle),
  };

  if (!normalized.subTopics.length) {
    normalized.subTopics.push({
      chapterTitle: normalized.summary || normalized.mainTopic || 'Nội dung chính',
      points: [],
      children: [],
    });
  }
  return normalized;
}

function generateMarkdownFromMindmap(mindmap) {
  const cleanLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const lines = [`# ${cleanLine(mindmap.mainTopic) || 'Sơ đồ tư duy'}`];

  if (mindmap.summary) {
    lines.push('');
    lines.push(`- ${cleanLine(mindmap.summary)}`);
  }

  const appendChild = (child, depth) => {
    const headingDepth = Math.min(Math.max(depth, 2), 6);
    lines.push('');
    lines.push(`${'#'.repeat(headingDepth)} ${cleanLine(child.title)}`);
    (child.points || []).forEach((point) => lines.push(`- ${cleanLine(point)}`));
    (child.children || []).forEach((nested) => appendChild(nested, headingDepth + 1));
  };

  (mindmap.subTopics || []).forEach((topic) => {
    lines.push('');
    lines.push(`## ${cleanLine(topic.chapterTitle)}`);
    (topic.points || []).forEach((point) => lines.push(`- ${cleanLine(point)}`));
    (topic.children || []).forEach((child) => appendChild(child, 3));
  });

  return lines.join('\n').trim();
}

function buildGeminiPrompt(filename) {
  return `Bạn là hệ thống phân tích tài liệu học tập và tạo sơ đồ tư duy.

Hãy đọc toàn bộ file đính kèm "${filename}" bằng ngữ cảnh gốc của Gemini File API. Không chia nhỏ tài liệu theo chunk.

Yêu cầu:
- Trả về duy nhất một JSON object đúng schema đã được cung cấp.
- mainTopic là chủ đề chính của tài liệu.
- summary là một câu tóm tắt ngắn.
- subTopics là các chương/mục lớn theo đúng logic tài liệu.
- Mỗi subTopic có chapterTitle, points và children.
- points là các ý quan trọng, ngắn gọn, có thể dùng trực tiếp để vẽ mindmap.
- children là các nhánh con; nếu không có thì trả về mảng rỗng.
- Không thêm markdown, không giải thích ngoài JSON.
- Ưu tiên tiếng Việt nếu tài liệu là tiếng Việt.`;
}

function buildTextPrompt(filename, text) {
  return `${buildGeminiPrompt(filename)}

Nội dung tài liệu:
${text}`;
}

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

async function generateWithVercelStreamObject(file, res) {
  const apiKey = keyManager.next();
  if (!apiKey) throw new Error('Gemini API key chưa được cấu hình.');

  const [{ streamObject }, { createGoogleGenerativeAI }] = await Promise.all([
    import('ai'),
    import('@ai-sdk/google'),
  ]);

  const google = createGoogleGenerativeAI({ apiKey });
  const fileBuffer = await fs.promises.readFile(file.path);

  progress(res, `Đang sinh object stream bằng Vercel AI SDK (${GEMINI_MODEL})...`, 35);

  const result = streamObject({
    model: google(GEMINI_MODEL),
    schema: MindmapDocumentSchema,
    schemaName: 'MindmapDocument',
    schemaDescription: 'Cấu trúc JSON dùng để vẽ sơ đồ tư duy từ một tài liệu học tập.',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: buildGeminiPrompt(file.originalname) },
        {
          type: 'file',
          data: fileBuffer,
          mediaType: file.mimetype,
          filename: file.originalname,
        },
      ],
    }],
    temperature: 0.1,
    maxOutputTokens: 8192,
  });

  let rawJson = '';
  let lastPartialSize = 0;

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      rawJson += part.textDelta || '';
      sendSSE(res, 'object_delta', {
        provider: 'vercel-ai-sdk/google',
        model: GEMINI_MODEL,
        delta: part.textDelta || '',
        receivedChars: rawJson.length,
      });
      continue;
    }

    if (part.type === 'object') {
      const partialJson = JSON.stringify(part.object);
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
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  const object = await result.object;
  const mindmap = normalizeMindmap(MindmapDocumentSchema.parse(object));
  const usage = await result.usage.catch(() => null);

  return {
    mindmap,
    provider: 'vercel-ai-sdk/google',
    model: GEMINI_MODEL,
    rawLength: rawJson.length,
    usage,
  };
}

async function generateWithGeminiFile(file, res) {
  let lastError = null;
  const attempts = Math.max(1, Math.min(GEMINI_KEYS.length || 1, 3));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const apiKey = keyManager.next();
    if (!apiKey) break;

    const ai = new GoogleGenAI({ apiKey });
    let uploadedFile = null;

    try {
      progress(res, `Đang upload file lên Gemini File API (${attempt + 1}/${attempts})...`, 20);
      uploadedFile = await ai.files.upload({
        file: file.path,
        config: {
          mimeType: file.mimetype,
          displayName: file.originalname,
        },
      });

      uploadedFile = await waitForGeminiFile(ai, uploadedFile, res);
      if (!uploadedFile.uri) throw new Error('Gemini File API không trả về file URI.');

      progress(res, `Đang sinh JSON có schema bằng ${GEMINI_MODEL}...`, 40);
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
          temperature: 0.1,
          topP: 0.9,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
          responseSchema: GEMINI_MINDMAP_SCHEMA,
        },
      });

      let rawJson = '';
      for await (const chunk of stream) {
        const text = getChunkText(chunk);
        if (!text) continue;
        rawJson += text;
        sendSSE(res, 'object_delta', {
          provider: 'gemini',
          model: GEMINI_MODEL,
          delta: text,
          receivedChars: rawJson.length,
        });
      }

      const mindmap = parseMindmapJson(rawJson);
      return {
        mindmap,
        provider: 'gemini',
        model: GEMINI_MODEL,
        rawLength: rawJson.length,
      };
    } catch (error) {
      lastError = error;
      console.warn(`[Gemini] Attempt ${attempt + 1} failed:`, error.message);
      const rateLimited = /429|quota|rate/i.test(error.message || '');
      if (!rateLimited && attempt >= attempts - 1) break;
    } finally {
      if (uploadedFile?.name) {
        ai.files.delete({ name: uploadedFile.name }).catch((error) => {
          console.warn(`[Gemini] Failed to delete remote file ${uploadedFile.name}:`, error.message);
        });
      }
    }
  }

  throw new Error(`Gemini File API thất bại: ${lastError?.message || 'chưa có API key hợp lệ'}`);
}

async function getPDFPageCount(filePath) {
  const dataBuffer = await fs.promises.readFile(filePath);
  const data = await pdfParse(dataBuffer);
  return {
    numPages: data.numpages || 1,
    text: data.text || ''
  };
}

function getDocxPageCount(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('docProps/app.xml');
    if (!entry) return 1;
    const xml = entry.getData().toString('utf8');
    const match = xml.match(/<Pages>(\d+)<\/Pages>/);
    return match ? parseInt(match[1], 10) : 1;
  } catch (err) {
    console.warn('[DocxPageCount] Lỗi đọc số trang docx, mặc định 1:', err.message);
    return 1;
  }
}

function canUseTextFallback(file) {
  const supported = [
    'text/plain',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  return supported.includes(file.mimetype);
}

async function readTextForFallback(file) {
  let text = '';
  if (file.mimetype === 'text/plain') {
    text = await fs.promises.readFile(file.path, 'utf8');
  } else if (file.mimetype === 'application/pdf') {
    const dataBuffer = await fs.promises.readFile(file.path);
    const data = await pdfParse(dataBuffer);
    text = data.text || '';
  } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ path: file.path });
    text = result.value || '';
  }
  return text.slice(0, MAX_FALLBACK_TEXT_CHARS);
}

function parseProviderJsonResponse(content) {
  if (!content) throw new Error('Provider không trả về nội dung.');
  return parseMindmapJson(content);
}

async function generateWithGroqText(file, text, res) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY chưa được cấu hình.');
  progress(res, `Gemini lỗi, đang chuyển sang Groq (${GROQ_MODEL})...`, 45);

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'Trả về duy nhất JSON hợp lệ đúng schema. Không markdown, không giải thích.' },
        { role: 'user', content: buildTextPrompt(file.originalname, text) },
      ],
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    },
  );

  return {
    mindmap: parseProviderJsonResponse(response.data?.choices?.[0]?.message?.content),
    provider: 'groq',
    model: GROQ_MODEL,
    rawLength: response.data?.choices?.[0]?.message?.content?.length || 0,
  };
}

async function generateWithOpenRouterText(file, text, res) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY chưa được cấu hình.');
  progress(res, `Đang chuyển sang OpenRouter (${OPENROUTER_MODEL})...`, 50);

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: 'Trả về duy nhất JSON hợp lệ đúng schema. Không markdown, không giải thích.' },
        { role: 'user', content: buildTextPrompt(file.originalname, text) },
      ],
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_PUBLIC_URL || 'http://localhost:3000',
        'X-Title': 'Mindmap Generator',
      },
      timeout: 60000,
    },
  );

  return {
    mindmap: parseProviderJsonResponse(response.data?.choices?.[0]?.message?.content),
    provider: 'openrouter',
    model: OPENROUTER_MODEL,
    rawLength: response.data?.choices?.[0]?.message?.content?.length || 0,
  };
}

async function generateMindmapWithFallback(file, res) {
  try {
    return await generateWithVercelStreamObject(file, res);
  } catch (aiSdkError) {
    console.warn('[Gateway] Vercel AI SDK streamObject failed:', aiSdkError.message);

    try {
      progress(res, 'streamObject lỗi, chuyển sang Gemini File API trực tiếp...', 40);
      return await generateWithGeminiFile(file, res);
    } catch (geminiError) {
      console.warn('[Gateway] Gemini File API failed:', geminiError.message);
      if (!canUseTextFallback(file)) throw geminiError;

      const text = await readTextForFallback(file);
      try {
        return await generateWithGroqText(file, text, res);
      } catch (groqError) {
        console.warn('[Gateway] Groq failed:', groqError.message);
        return generateWithOpenRouterText(file, text, res);
      }
    }
  }
}

async function buildMindmapPayload(file, fileHash, res, startedAt) {
  const generated = await generateMindmapWithFallback(file, res);
  progress(res, 'Đang tạo Markdown từ JSON đã validate...', 85);

  const markdown = generateMarkdownFromMindmap(generated.mindmap);
  return {
    markdown,
    mindmap: generated.mindmap,
    visualizationKey: fileHash,
    stats: {
      provider: generated.provider,
      model: generated.model,
      rawLength: generated.rawLength,
      fileHash,
      fileName: file.originalname,
      fileType: file.mimetype,
      fileSize: file.size,
      processingTime: Date.now() - startedAt,
      cached: false,
      mainTopic: generated.mindmap.mainTopic,
    },
    cachedAt: new Date().toISOString(),
  };
}

async function saveDocumentRecord(req, file, fileHash) {
  const db = req.app.locals.usersDb;
  if (!db || !req.session?.user) return;

  const docRecord = {
    title: file.originalname,
    fileType: file.mimetype,
    size: file.size,
    hash: fileHash,
    userId: req.session.user._id.toString(),
    username: req.session.user.username || 'unknown',
    createdAt: new Date(),
    status: 'active',
  };

  db.collection('documents').insertOne(docRecord)
    .catch((error) => console.error('Lỗi lưu tài liệu vào DB:', error));
}

async function processStreamingUpload(req, res) {
  const file = req.file;
  const startedAt = Date.now();

  if (!file) {
    return res.status(400).json({ error: 'Không có file nào được tải lên.' });
  }

  writeSSEHeaders(res);

  try {
    progress(res, 'Đã nhận file, đang tính SHA-256 để kiểm tra cache...', 5);
    const fileHash = await hashFile(file.path);
    await saveDocumentRecord(req, file, fileHash);

    const key = cacheKey(fileHash);
    const cached = await documentCache.get(key);
    if (cached?.markdown) {
      const payload = {
        ...cached,
        visualizationKey: fileHash,
        stats: {
          ...(cached.stats || {}),
          cached: true,
          processingTime: Date.now() - startedAt,
        },
      };
      progress(res, 'Cache hit: đã tìm thấy mindmap cho file này.', 95, { cache: 'hit' });
      sendSSE(res, 'complete', {
        markdown: payload.markdown,
        visualizationUrl: `/upload/mindmap-visualization/${fileHash}`,
        stats: payload.stats,
      });
      return;
    }

    progress(res, 'Cache miss: file mới, đưa vào pool xử lý AI.', 12, { cache: 'miss' });

    // Kiểm tra giới hạn số trang (dưới 20 trang) đối với PDF và DOCX
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

    if (pageCount > 200) {
      throw new Error(`Tài liệu quá dài (${pageCount} trang). Hệ thống chỉ chấp nhận tài liệu dưới 200 trang để đảm bảo hiệu suất AI.`);
    }

    let ownsInFlight = false;
    let payloadPromise = inFlightDocuments.get(fileHash);
    if (payloadPromise) {
      progress(res, 'File này đang được xử lý bởi request khác, đang chờ kết quả dùng chung...', 30);
    } else {
      payloadPromise = runWithAiLimit(() => buildMindmapPayload(file, fileHash, res, startedAt));
      inFlightDocuments.set(fileHash, payloadPromise);
      ownsInFlight = true;
    }

    const payload = await payloadPromise.finally(() => {
      if (ownsInFlight) inFlightDocuments.delete(fileHash);
    });

    await documentCache.set(key, payload, CACHE_TTL_SECONDS);
    progress(res, 'Hoàn tất, đã lưu kết quả vào cache.', 100);
    sendSSE(res, 'complete', {
      markdown: payload.markdown,
      visualizationUrl: `/upload/mindmap-visualization/${fileHash}`,
      stats: payload.stats,
    });
  } catch (error) {
    console.error('Document streaming failed:', error);
    sendSSE(res, 'error', { message: error.message || 'Lỗi xử lý tài liệu.' });
  } finally {
    await cleanupLocalUpload(file.path);
    if (!res.writableEnded) res.end();
  }
}

router.get('/page', authMiddleware.checkLoggedIn, documentController.getUploadPage);

router.post('/summarize-stream', authMiddleware.checkLoggedIn, handleDocumentUpload, (req, res) => {
  processStreamingUpload(req, res);
});

router.post('/start-summarize', authMiddleware.checkLoggedIn, (req, res) => {
  res.status(410).json({
    error: 'Endpoint cũ đã được thay bằng POST /upload/summarize-stream để stream trực tiếp, không còn tạo job trong RAM.',
  });
});

router.get('/', (req, res) => {
  res.redirect('/upload/page');
});

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

module.exports = router;
