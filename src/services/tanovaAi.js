// Kompatibilitas impor lama: implementasi AI aktif hanya memakai Gemini API.
export {
  analyzeWithGemini as analyzePlantImage,
  getGeminiHealth,
} from './aiService.js';