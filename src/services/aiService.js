import { env } from "../config/env.js";
import { httpError } from "../lib/errors.js";

const IMAGE_NAMES = {
  "image/jpeg": "tanova-camera.jpg",
  "image/png": "tanova-camera.png",
  "image/webp": "tanova-camera.webp",
};

function geminiModelId() {
  return String(env.ai.model || "gemini-2.5-flash").replace(/^models\//, "");
}

async function geminiFetch(url, options = {}) {
  if (!env.ai.geminiApiKey) {
    throw httpError(503, "GEMINI_API_KEY belum diisi di environment backend", "AI_NOT_CONFIGURED");
  }
  try {
    return await fetch(url, {
      ...options,
      headers: {
        "x-goog-api-key": env.ai.geminiApiKey,
        Accept: "application/json",
        ...(options.headers || {}),
      },
      signal: options.signal || AbortSignal.timeout(env.ai.timeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw httpError(timeout ? 504 : 502,
      timeout ? "Gemini API melewati batas waktu" : "Tidak dapat menghubungi Gemini API",
      timeout ? "AI_TIMEOUT" : "AI_UNREACHABLE");
  }
}

// Gemini tidak menyediakan endpoint /health khusus. GET model metadata memverifikasi
// API key dan akses ke model tanpa menjalankan inferensi atau mengirim gambar.
export async function getGeminiHealth() {
  const model = geminiModelId();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`;
  const response = await geminiFetch(url, { method: "GET", signal: AbortSignal.timeout(Math.min(env.ai.timeoutMs, 10000)) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw httpError(response.status === 401 || response.status === 403 ? 503 : 502,
      `Gemini health check gagal: ${String(message).slice(0, 250)}`, "AI_PROVIDER_UNHEALTHY");
  }
  const methods = payload?.supportedGenerationMethods || [];
  if (!methods.includes('generateContent')) {
    throw httpError(503, `Model ${model} tidak mendukung generateContent`, 'AI_MODEL_UNSUPPORTED');
  }
  return {
    ok: true,
    provider: "gemini",
    model,
    checked_at: new Date().toISOString(),
    model_display_name: payload?.displayName || null,
    supported_methods: methods,
  };
}

export async function analyzeWithGemini(buffer, mimeType) {
  if (!IMAGE_NAMES[mimeType]) throw httpError(415, "Format gambar harus JPEG, PNG, atau WebP", "UNSUPPORTED_IMAGE");
  const model = geminiModelId();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const prompt = `Kamu adalah asisten agronomi untuk sistem hidroponik TANOVA. Periksa foto tanaman yang diberikan.

Balas HANYA JSON valid tanpa markdown dengan struktur:
{
  "is_plant": true,
  "plant": "nama tanaman dalam bahasa Indonesia atau Tidak diketahui",
  "status": "healthy|nutrient|pest|disease|other",
  "problem": "masalah spesifik atau Sehat",
  "confidence": 0,
  "severity": "none|low|medium|high",
  "summary": "ringkasan singkat dalam bahasa Indonesia",
  "symptoms": ["gejala yang benar-benar terlihat"],
  "recommendations": ["saran praktis untuk hidroponik"]
}
Jika bukan tanaman, terlalu gelap, atau buram sehingga tidak bisa dinilai, set is_plant false, status other, confidence 0, dan jelaskan singkat pada summary. Jangan mengarang gejala yang tidak tampak. Jika ragu turunkan confidence. Severity none hanya untuk tanaman sehat. Semua teks berbahasa Indonesia.`;
  const started = Date.now();
  const response = await geminiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
      ] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw httpError(502, `Gemini gagal menganalisis gambar: ${String(message).slice(0, 300)}`, "AI_PROVIDER_ERROR");
  }
  if (payload?.promptFeedback?.blockReason) {
    throw httpError(422, "Foto ditolak oleh filter keamanan Gemini", "AI_BLOCKED");
  }
  const rawText = (payload?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
  if (!rawText) throw httpError(502, "Gemini tidak mengembalikan hasil analisis", "AI_BAD_RESPONSE");

  let raw;
  try { raw = JSON.parse(rawText.replace(/^```json\s*|\s*```$/g, "")); }
  catch { throw httpError(502, "Respons Gemini bukan JSON valid", "AI_BAD_RESPONSE"); }

  const result = normalizeGeminiResult(raw, rawText);
  return { is_plant: result.is_plant, result, model, latency_ms: Date.now() - started, raw_text: rawText };
}

function normalizeGeminiResult(raw, rawText) {
  const statuses = ["healthy", "nutrient", "pest", "disease", "other"];
  const severities = ["none", "low", "medium", "high"];
  const status = statuses.includes(raw?.status) ? raw.status : "other";
  const isPlant = raw?.is_plant !== false;
  let confidence = Number(raw?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0) confidence = null;
  else confidence = Math.round(Math.min(confidence > 1 ? confidence / 100 : confidence, 1) * 100) / 100;
  let severity = severities.includes(raw?.severity) ? raw.severity : (status === "healthy" ? "none" : "medium");
  if (status === "healthy") severity = "none";
  else if (severity === "none") severity = "low";
  const list = (value) => (Array.isArray(value) ? value : []).map((v) => String(v ?? "").trim().slice(0, 300)).filter(Boolean).slice(0, 4);
  const plant = String(raw?.plant || "Tidak diketahui").trim().slice(0, 150);
  const problem = String(raw?.problem || (status === "healthy" ? "Sehat" : "Masalah belum teridentifikasi")).trim().slice(0, 200);
  const summary = String(raw?.summary || "Analisis selesai.").trim().slice(0, 500);
  const category = { healthy: "leaf_health", nutrient: "nutrient", pest: "pest", disease: "disease", other: "other" }[status];
  const symptoms = list(raw?.symptoms);
  const recommendations = list(raw?.recommendations);
  const formattedText = [
    `**Status:** ${status === 'healthy' ? 'Sehat' : status === 'nutrient' ? 'Masalah nutrisi' : status === 'pest' ? 'Hama' : status === 'disease' ? 'Penyakit' : 'Lainnya'}`,
    `**Jenis Tanaman:** ${plant}`,
    `**Masalah:** ${problem}`,
    `**Confidence:** ${confidence === null ? 'Tidak tersedia' : `${Math.round(confidence * 100)}%`}`,
    symptoms.length ? `\n**Gejala:**\n${symptoms.map((item) => `- ${item}`).join('\n')}` : '',
    recommendations.length ? `\n**Rekomendasi:**\n${recommendations.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
    `\n**Ringkasan:** ${summary}`,
  ].filter(Boolean).join('\n');
  return {
    is_plant: isPlant,
    status,
    plant,
    problem,
    category,
    label: status === "healthy" ? "Tanaman sehat" : problem,
    confidence,
    severity,
    summary,
    symptoms,
    recommendations,
    formatted_text: formattedText,
    raw_text: rawText,
  };
}
