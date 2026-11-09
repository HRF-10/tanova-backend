import { env } from '../config/env.js';
import { httpError } from '../lib/errors.js';

const STATUS_MAP = {
  healthy: 'healthy',
  health: 'healthy',
  nutrient: 'nutrient',
  deficiency: 'nutrient',
  pest: 'pest',
  disease: 'disease',
  other: 'other',
};
const CATEGORY_BY_STATUS = {
  healthy: 'leaf_health',
  nutrient: 'nutrient',
  pest: 'pest',
  disease: 'disease',
  other: 'other',
};

function cleanList(lines, max = 4) {
  return lines.map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean).slice(0, max);
}

function extractSection(text, heading, nextHeading) {
  const source = String(text || '');
  const start = source.search(new RegExp(`${heading}\\s*:`, 'i'));
  if (start < 0) return [];
  const bodyStart = source.indexOf(':', start) + 1;
  const tail = source.slice(bodyStart);
  const end = nextHeading ? tail.search(new RegExp(`${nextHeading}\\s*:`, 'i')) : -1;
  const section = (end >= 0 ? tail.slice(0, end) : tail).trim();
  return cleanList(section.split(/\r?\n/));
}

export function normalizeTanovaResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw httpError(502, 'API analisis mengembalikan format JSON yang tidak valid', 'AI_BAD_RESPONSE');
  }

  const rawStatus = String(raw.status || 'other').toLowerCase();
  if (rawStatus === 'error' || raw.error_message) {
    throw httpError(502, String(raw.error_message || 'Layanan analisis gagal memproses gambar'), 'AI_PROVIDER_ERROR');
  }
  const status = STATUS_MAP[rawStatus] || 'other';
  const confidenceValue = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.round(Math.max(0, Math.min(100, confidenceValue > 1 ? confidenceValue / 100 : confidenceValue)) * 100) / 100
    : null;
  const text = String(raw.text || raw.response_text || '').trim();
  const plant = String(raw.plant || 'Tidak diketahui').trim().slice(0, 150);
  const problem = String(raw.problem || '').trim().slice(0, 200);
  const isPlant = !['not_plant', 'not-plant', 'invalid'].includes(rawStatus) && raw.is_plant !== false;
  const symptoms = extractSection(text, 'Gejala', 'Rekomendasi');
  const recommendations = extractSection(text, 'Rekomendasi', null);

  return {
    is_plant: isPlant,
    plant,
    category: CATEGORY_BY_STATUS[status],
    label: status === 'healthy' ? 'Tanaman sehat' : problem || 'Masalah tidak teridentifikasi',
    confidence,
    // API teman belum mengirim severity; gunakan medium secara konservatif untuk kasus bermasalah.
    severity: status === 'healthy' ? 'none' : 'medium',
    summary: text.slice(0, 500),
    symptoms,
    recommendations,
    source_status: rawStatus,
    source_id: raw.id ?? null,
    image_url: typeof raw.image_url === 'string' ? raw.image_url : null,
    model: raw.model || null,
    latency_ms: Number.isFinite(Number(raw.latency_ms)) ? Number(raw.latency_ms) : null,
  };
}

export async function analyzePlantImage(buffer, mimeType) {
  if (!env.ai.imageApiUrl) {
    throw httpError(503, 'IMAGE_API_URL belum diisi di environment backend', 'AI_NOT_CONFIGURED');
  }

  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mimeType }), `tanova-image.${mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'}`);
  const headers = {};
  if (env.ai.imageApiKey) headers['x-api-key'] = env.ai.imageApiKey;

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${env.ai.imageApiUrl}/api/analyze`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(env.ai.timeoutMs),
    });
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw httpError(timeout ? 504 : 502,
      timeout ? 'API analisis gambar terlalu lama menjawab' : 'API analisis gambar tidak dapat dihubungi',
      timeout ? 'AI_TIMEOUT' : 'AI_UNREACHABLE');
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message || payload?.error?.message || `HTTP ${response.status}`;
    throw httpError(502, `API analisis gambar menolak permintaan: ${message}`, 'AI_PROVIDER_ERROR');
  }

  const result = normalizeTanovaResponse(payload);
  return {
    result,
    model: result.model || 'tanovaai-external',
    latency_ms: result.latency_ms ?? Date.now() - started,
    external_image_url: result.image_url,
  };
}
