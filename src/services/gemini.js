import { env } from '../config/env.js';
import { httpError } from '../lib/errors.js';

const STATUS = ['healthy', 'nutrient', 'pest', 'disease', 'other'];
const SEVERITY = ['none', 'low', 'medium', 'high'];
const CATEGORY_BY_STATUS = { healthy: 'leaf_health', nutrient: 'nutrient', pest: 'pest', disease: 'disease', other: 'other' };

const PROMPT = `Kamu adalah ahli agronomi untuk sistem hidroponik. Analisis foto tanaman ini.
Balas HANYA dengan satu objek JSON (tanpa teks lain, tanpa markdown) dengan bentuk:
{
  "is_plant": true atau false (false jika foto bukan tanaman, terlalu gelap, atau terlalu buram untuk dinilai),
  "plant": "nama tanaman dalam bahasa Indonesia, atau 'Tidak diketahui'",
  "status": salah satu dari "healthy", "nutrient", "pest", "disease", "other",
  "problem": "nama masalah yang spesifik, atau 'Sehat' jika status healthy",
  "confidence": angka 0 sampai 100,
  "severity": salah satu dari "none", "low", "medium", "high",
  "summary": "satu kalimat tentang kondisi tanaman dan penyebab yang paling mungkin",
  "symptoms": ["gejala yang benar-benar terlihat di foto, maksimal 4"],
  "recommendations": ["tindakan konkret untuk pembudidaya hidroponik, maksimal 4"]
}
Aturan:
- Laporkan hanya yang terlihat di foto. Jika ragu, turunkan confidence.
- severity "none" hanya untuk tanaman sehat. "high" jika tanaman terancam mati atau masalah cepat menyebar.
- Semua teks berbahasa Indonesia.`;

const strList = (v) =>
  (Array.isArray(v) ? v : [])
    .map((s) => String(s ?? '').trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 4);

function extractJson(text) {
  const clean = String(text || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const a = clean.indexOf('{');
    const b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(clean.slice(a, b + 1));
      } catch { /* jatuh ke error di bawah */ }
    }
  }
  throw httpError(502, 'Balasan AI bukan JSON yang valid', 'AI_BAD_RESPONSE');
}

// Rapikan keluaran model supaya aman disimpan ke database, apa pun yang dikirim model.
export function normalizeAnalysis(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const status = STATUS.includes(r.status) ? r.status : 'other';
  let severity = SEVERITY.includes(r.severity) ? r.severity : status === 'healthy' ? 'none' : 'medium';
  if (status === 'healthy') severity = 'none';
  else if (severity === 'none') severity = 'low';

  let confidence = Number(r.confidence);
  if (!Number.isFinite(confidence) || confidence < 0) confidence = null;
  else {
    if (confidence > 1) confidence /= 100;
    confidence = Math.round(Math.min(confidence, 1) * 100) / 100;
  }

  const problem = String(r.problem || '').trim().slice(0, 200);
  return {
    is_plant: r.is_plant !== false,
    plant: String(r.plant || 'Tidak diketahui').trim().slice(0, 150),
    category: CATEGORY_BY_STATUS[status],
    label: status === 'healthy' ? 'Tanaman sehat' : problem || 'Masalah tidak teridentifikasi',
    confidence,
    severity,
    summary: String(r.summary || '').trim().slice(0, 500),
    symptoms: strList(r.symptoms),
    recommendations: strList(r.recommendations),
  };
}

export async function analyzePlantImage(buffer, mimeType) {
  if (!env.ai.geminiApiKey) {
    throw httpError(503, 'GEMINI_API_KEY belum diisi di .env backend', 'AI_NOT_CONFIGURED');
  }
  const model = env.ai.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const started = Date.now();

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.ai.geminiApiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(env.ai.timeoutMs),
    });
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw httpError(504, timeout ? 'Layanan AI terlalu lama menjawab' : 'Layanan AI tidak dapat dihubungi', 'AI_UNREACHABLE');
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw httpError(502, `Layanan AI menolak permintaan: ${payload?.error?.message || `HTTP ${res.status}`}`, 'AI_PROVIDER_ERROR');
  }
  if (payload?.promptFeedback?.blockReason) {
    throw httpError(422, 'Foto ditolak oleh filter keamanan layanan AI', 'AI_BLOCKED');
  }
  const text = (payload?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw httpError(502, 'Layanan AI tidak mengembalikan hasil', 'AI_BAD_RESPONSE');

  return { result: normalizeAnalysis(extractJson(text)), model, latency_ms: Date.now() - started };
}
