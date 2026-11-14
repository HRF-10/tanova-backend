import { env } from "../config/env.js";
import { httpError } from "../lib/errors.js";

const IMAGE_NAMES = {
  "image/jpeg": "tanova-camera.jpg",
  "image/png": "tanova-camera.png",
  "image/webp": "tanova-camera.webp",
};

export async function analyzeWithTanovaAI(buffer, mimeType) {
  if (!env.ai.serviceUrl) {
    throw httpError(
      503,
      "TANOVAAI_URL belum diatur di environment backend",
      "AI_NOT_CONFIGURED",
    );
  }
  if (!env.ai.serviceApiKey) {
    throw httpError(
      503,
      "TANOVAAI_API_KEY belum diatur di environment backend",
      "AI_NOT_CONFIGURED",
    );
  }

  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  form.append("image", blob, IMAGE_NAMES[mimeType] || "tanova-camera.jpg");

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${env.ai.serviceUrl}/api/analyze`, {
      method: "POST",
      headers: { "x-api-key": env.ai.serviceApiKey },
      body: form,
      signal: AbortSignal.timeout(env.ai.serviceTimeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw httpError(
      timeout ? 504 : 502,
      timeout
        ? "Layanan Tanova AI melewati batas waktu"
        : "Tidak dapat menghubungi layanan Tanova AI",
      timeout ? "AI_TIMEOUT" : "AI_UNREACHABLE",
    );
  }

  const rawText = await response.text();
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw httpError(
      502,
      "Layanan Tanova AI mengembalikan respons yang bukan JSON",
      "AI_BAD_RESPONSE",
    );
  }

  // Foto bukan tanaman: layanan AI membalas 422 not_a_plant
  if (response.status === 422 || payload?.error === "not_a_plant") {
    return {
      is_plant: false,
      payload,
      model: payload?.model || "tanovaai",
      latency_ms: Date.now() - started,
    };
  }

  if (!response.ok) {
    const message =
      payload?.message || payload?.error?.message || `HTTP ${response.status}`;
    throw httpError(
      502,
      `Layanan Tanova AI gagal: ${String(message).slice(0, 300)}`,
      "AI_PROVIDER_ERROR",
    );
  }

  if (!response.ok) {
    const message =
      payload?.message || payload?.error?.message || `HTTP ${response.status}`;
    throw httpError(
      502,
      `Layanan Tanova AI gagal: ${String(message).slice(0, 300)}`,
      "AI_PROVIDER_ERROR",
    );
  }

  const status = String(payload?.status || "").toLowerCase();
  if (status === "error" || payload?.error) {
    throw httpError(
      502,
      "Layanan Tanova AI gagal memproses gambar",
      "AI_PROVIDER_ERROR",
    );
  }

  // Layanan teman mengembalikan status "disease" atau status lain untuk hasil analisis.
  const recognized = [
    "disease",
    "healthy",
    "normal",
    "health",
    "pest",
    "nutrient",
    "other",
  ];
  if (!recognized.includes(status)) {
    return {
      is_plant: false,
      payload,
      model: payload?.model || "tanovaai",
      latency_ms: Date.now() - started,
    };
  }

  const problem = String(payload.problem || "").trim();
  const plant = String(payload.plant || "Tidak diketahui").trim();
  const label = ["healthy", "normal", "health"].includes(status)
    ? "Tanaman sehat"
    : problem || "Masalah tanaman terdeteksi";

  let category = "other";
  if (status === "healthy" || status === "normal" || status === "health")
    category = "leaf_health";
  else if (
    status === "pest" ||
    /hama|serangga|ulat|kumbang|pengorok/i.test(problem)
  )
    category = "pest";
  else if (
    status === "disease" ||
    /penyakit|karat|busuk|jamur|virus|bakteri/i.test(problem)
  )
    category = "disease";
  else if (status === "nutrient") category = "nutrient";

  let confidence = Number(payload.confidence);
  if (!Number.isFinite(confidence) || confidence < 0) confidence = null;
  else
    confidence =
      Math.round(
        Math.min(confidence > 1 ? confidence / 100 : confidence, 1) * 100,
      ) / 100;

  // Service teman belum memberikan severity terstruktur; jangan mengarang tingkat "high".
  const severity = category === "leaf_health" ? "none" : "medium";
  const text = String(payload.text || "").trim();
  const recommendations = [];
  const inRecommendations = text.split(/\*\*Rekomendasi:\*\*/i)[1] || "";
  for (const line of inRecommendations.split("\n")) {
    const item = line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
    if (item) recommendations.push(item);
  }

  const imageUrl =
    typeof payload.image_url === "string" ? payload.image_url : null;
  if (imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:") throw new Error("not https");
    } catch {
      throw httpError(
        502,
        "URL gambar dari layanan AI tidak valid",
        "AI_BAD_RESPONSE",
      );
    }
  }

  return {
    is_plant: true,
    result: {
      category,
      label,
      confidence,
      severity,
      summary: text || `${plant}: ${label}`,
      recommendations: recommendations.slice(0, 8),
      plant,
      problem,
      raw_text: text,
      status,
    },
    image_url: imageUrl,
    model: payload?.model || "tanovaai",
    latency_ms: Date.now() - started,
    source_payload: payload,
  };
}
