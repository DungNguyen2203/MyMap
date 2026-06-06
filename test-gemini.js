// test-gemini.js
require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
const MODEL_NAME = "gemini-2.5-flash";

async function testGemini() {
  if (GEMINI_KEYS.length === 0) {
    console.log("❌ Không tìm thấy key nào trong GEMINI_API_KEYS!");
    return;
  }

  console.log(`🔍 Tìm thấy ${GEMINI_KEYS.length} key trong GEMINI_API_KEYS. Bắt đầu thử nghiệm...`);

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = GEMINI_KEYS[i];
    const maskedKey = key.slice(0, 8) + "..." + key.slice(-4);
    console.log(`\n🔑 Đang thử key thứ ${i + 1}: ${maskedKey}`);
    
    try {
      const genAI = new GoogleGenAI({ apiKey: key });
      const result = await genAI.models.generateContent({
        model: MODEL_NAME,
        contents: "Xin chào, Gemini! Bạn có đang hoạt động không?",
      });
      console.log(`✅ Thành công với key ${maskedKey}! Phản hồi:`);
      console.log(result.text);
    } catch (err) {
      console.error(`❌ Thất bại với key ${maskedKey}:`, err.message || err);
    }
  }
}

testGemini();
