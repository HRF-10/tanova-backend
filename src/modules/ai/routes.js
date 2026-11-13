import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db } from '../../db/knex.js';
import { env } from '../../config/env.js';
import { dto } from '../../lib/dto.js';
import { httpError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { parseJson, toJson } from '../../lib/json.js';
import { pageMeta, pageParams } from '../../lib/pagination.js';
import { now, toMs } from '../../lib/time.js';
import { findDevice } from '../../lib/devices.js';
import { ghScope } from '../../lib/scope.js';
import { logActivity } from '../../lib/activity.js';
import { recommend } from '../../services/recommendations.js';
import { analyzeWithTanovaAI } from '../../services/aiService.js';
import { sniffMime } from '../../services/imageStore.js';

const tags = ['Tanova AI'];
const security = [{ bearerAuth: [] }];
const idParam = { type: 'object', properties: { id: { type: 'string' } } };
const CATEGORIES = ['leaf_health', 'nutrient', 'pest', 'disease', 'other'];
const SEVERITIES = ['none', 'low', 'medium', 'high'];
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const diagnosisDto = (r) => dto(r, { json: ['details', 'recommended_actions'] });

export default async function aiRoutes(app) {
  const ro = [app.authenticate];
  const rw = [app.authenticate, app.requireRole('admin', 'operator')];

  // Pemrosesan AI dilakukan di sisi aplikasi; aplikasi mengirim hasilnya ke sini memakai login pengguna.
  const userOnly = [app.authenticate, app.requireRole('admin', 'operator')];

  // ESP32 kirim x-api-key (CAMERA_API_KEY); aplikasi kirim Bearer token seperti biasa.
  const hash = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const cameraOrUser = async (request) => {
    const key = request.headers['x-api-key'];
    if (key) {
      if (!env.ai.cameraApiKey || !crypto.timingSafeEqual(hash(key), hash(env.ai.cameraApiKey))) {
        throw httpError(401, 'API key kamera tidak valid', 'INVALID_API_KEY');
      }
      request.isCamera = true;
      return;
    }
    await app.authenticate(request);
    await app.requireRole('admin', 'operator')(request);
  };

  // ESP32 paling mudah mengirim frame JPEG sebagai body mentah (tanpa multipart).
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: env.maxUploadMb * 1024 * 1024 },
    (req, body, done) => done(null, body),
  );

  async function createDiagnosis(request, { greenhouse_id, device, category, label, confidence, severity, details, recommendation, recommended_actions, image_url, captured_at }) {
    const auto = recommend(label);
    const t = now();
    const row = {
      id: newId(),
      greenhouse_id,
      device_id: device?.id ?? null,
      captured_at: toMs(captured_at, t),
      image_url: image_url ?? null,
      category,
      label: label.trim(),
      confidence,
      severity,
      details: toJson(details),
      recommendation: recommendation || auto.recommendation,
      recommended_actions: toJson(recommended_actions || auto.actions),
      action_status: 'pending',
      created_at: t,
    };
    await db('ai_diagnoses').insert(row);

    if (severity === 'high') {
      await db('alert_events').insert({
        id: newId(),
        greenhouse_id,
        device_id: device?.id ?? null,
        source: 'ai',
        severity: 'critical',
        title: `[AI] ${row.label}`,
        message: `${row.recommendation} Tingkat keparahan tinggi${confidence !== null ? `, keyakinan ${Math.round(confidence * 100)}%` : ''}.`,
        created_at: t,
      });
    }
    await logActivity(request, { action: 'ai.diagnosis_create', entity: 'ai_diagnosis', entity_id: row.id, description: `Diagnosis AI: ${row.label}`, greenhouse_id });
    return row;
  }

  // Tentukan greenhouse + device untuk data yang masuk
  async function resolveTarget(request, deviceId) {
    const scope = ghScope(request);
    if (deviceId) {
      const device = await findDevice(deviceId, scope);
      return { greenhouse_id: device.greenhouse_id, device };
    }
    if (!scope) throw httpError(400, 'device_id atau greenhouse_id wajib diisi', 'GREENHOUSE_REQUIRED');
    return { greenhouse_id: scope, device: null };
  }

  async function readMultipart(request) {
    const fields = {};
    let image_url = null;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const ext = IMAGE_EXT[part.mimetype];
        if (!ext) {
          part.file.resume();
          throw httpError(415, 'Format gambar harus JPEG, PNG, atau WebP', 'UNSUPPORTED_IMAGE');
        }
        const name = `${newId()}${ext}`;
        const dest = path.resolve(env.uploadDir, name);
        await pipeline(part.file, fs.createWriteStream(dest));
        if (part.file.truncated) {
          fs.rmSync(dest, { force: true });
          throw httpError(413, `Ukuran gambar maksimal ${env.maxUploadMb} MB`, 'IMAGE_TOO_LARGE');
        }
        image_url = `/uploads/${name}`;
      } else {
        fields[part.fieldname] = part.value;
      }
    }
    for (const k of ['details', 'recommended_actions']) {
      if (typeof fields[k] === 'string') fields[k] = parseJson(fields[k], undefined);
    }
    if (image_url) fields.image_url = image_url;
    return fields;
  }

  // ---- Diagnosis ----
  app.post('/ai/diagnoses', {
    onRequest: userOnly,
    schema: {
      tags, security,
      summary: 'Simpan hasil diagnosis AI (diproses di aplikasi) beserta foto dari kamera',
      description:
        'Terima JSON atau multipart/form-data (field "image" untuk foto). Field: device_id, label (wajib), category, confidence (0-1), severity, details, recommendation, recommended_actions, captured_at. ' +
        'Jika recommendation kosong, rekomendasi dibuat otomatis dari label. Severity "high" membuat notifikasi di aplikasi.',
    },
  }, async (request, reply) => {
    const body = request.isMultipart() ? await readMultipart(request) : request.body || {};
    if (!body.label || typeof body.label !== 'string') throw httpError(400, 'label wajib diisi', 'VALIDATION_ERROR');
    const category = body.category || 'leaf_health';
    const severity = body.severity || 'none';
    if (!CATEGORIES.includes(category)) throw httpError(400, `category harus salah satu dari ${CATEGORIES.join(', ')}`, 'VALIDATION_ERROR');
    if (!SEVERITIES.includes(severity)) throw httpError(400, `severity harus salah satu dari ${SEVERITIES.join(', ')}`, 'VALIDATION_ERROR');
    let confidence = body.confidence === undefined || body.confidence === '' ? null : Number(body.confidence);
    if (confidence !== null) {
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw httpError(400, 'confidence harus 0-1 (atau 0-100 persen)', 'VALIDATION_ERROR');
      if (confidence > 1) confidence /= 100;
    }

    const { greenhouse_id, device } = await resolveTarget(request, body.device_id);
    const row = await createDiagnosis(request, {
      greenhouse_id, device, category, confidence, severity,
      label: body.label,
      details: body.details,
      recommendation: body.recommendation,
      recommended_actions: body.recommended_actions,
      image_url: body.image_url,
      captured_at: body.captured_at,
    });
    return reply.code(201).send(diagnosisDto(row));
  });

  // Foto dari kamera (atau aplikasi) -> diteruskan ke layanan Tanova AI eksternal -> disimpan sebagai diagnosis.
  app.post('/ai/analyze', {
    onRequest: cameraOrUser,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    // Skema hanya untuk dokumentasi Swagger (kotak unggah file); isi multipart divalidasi manual di bawah.
    validatorCompiler: () => () => true,
    schema: {
      tags,
      security: [{ bearerAuth: [] }, { cameraKey: [] }],
      consumes: ['multipart/form-data', 'image/jpeg'],
      summary: 'Analisis foto tanaman melalui layanan Tanova AI eksternal dan simpan hasilnya',
      description:
        'Kirim foto sebagai multipart/form-data (field "image") atau body mentah image/jpeg. ' +
        'device_id (ID perangkat Tanova) boleh di query atau field form; wajib untuk kamera. ' +
        'Autentikasi: header x-api-key (kamera) atau Bearer token (aplikasi). ' +
        'Jika foto bukan tanaman atau terlalu gelap/buram, hasilnya tidak disimpan (saved: false).',
      body: { type: 'object', properties: { image: { type: 'string', format: 'binary' }, device_id: { type: 'string' } } },
      querystring: { type: 'object', properties: { device_id: { type: 'string' }, greenhouse_id: { type: 'string' } } },
    },
  }, async (request, reply) => {
    let buffer;
    let deviceId = request.query?.device_id;

    if (request.isMultipart()) {
      for await (const part of request.parts()) {
        if (part.type === 'file') buffer = await part.toBuffer();
        else if (part.fieldname === 'device_id') deviceId = part.value || deviceId;
      }
    } else if (Buffer.isBuffer(request.body)) {
      buffer = request.body;
    } else {
      throw httpError(415, 'Kirim foto sebagai multipart/form-data (field "image") atau body mentah image/jpeg', 'UNSUPPORTED_MEDIA');
    }
    if (!buffer?.length) throw httpError(400, 'Foto kosong atau field "image" tidak ditemukan', 'VALIDATION_ERROR');
    if (buffer.length > env.maxUploadMb * 1024 * 1024) throw httpError(413, `Ukuran gambar maksimal ${env.maxUploadMb} MB`, 'IMAGE_TOO_LARGE');
    const mime = sniffMime(buffer);
    if (!mime) throw httpError(415, 'Format gambar harus JPEG, PNG, atau WebP (file mungkin terpotong)', 'UNSUPPORTED_IMAGE');

    let greenhouse_id;
    let device;
    if (request.isCamera) {
      if (!deviceId) throw httpError(400, 'device_id wajib diisi untuk kamera', 'VALIDATION_ERROR');
      device = await findDevice(deviceId, null);
      greenhouse_id = device.greenhouse_id;
    } else {
      ({ greenhouse_id, device } = await resolveTarget(request, deviceId));
    }

    const analysis = await analyzeWithTanovaAI(buffer, mime);
    const { model, latency_ms } = analysis;
    if (!analysis.is_plant) {
      return reply.send({
        saved: false,
        is_plant: false,
        message: 'Layanan AI tidak mengembalikan hasil diagnosis tanaman yang dikenali.',
        model,
        latency_ms,
        service_result: analysis.payload || null,
      });
    }

    const result = analysis.result;
    const row = await createDiagnosis(request, {
      greenhouse_id,
      device,
      category: result.category,
      label: result.label,
      confidence: result.confidence,
      severity: result.severity,
      recommendation: result.summary || undefined,
      recommended_actions: result.recommendations.length ? result.recommendations : undefined,
      // Foto sudah disimpan oleh layanan AI teman; simpan URL publik yang dikembalikan.
      image_url: analysis.image_url,
      details: {
        source: request.isCamera ? 'camera' : 'app',
        plant: result.plant,
        problem: result.problem,
        service_status: result.status,
        response_text: result.raw_text,
        model,
        latency_ms,
      },
    });
    return reply.code(201).send({
      saved: true,
      ...diagnosisDto(row),
      ai_result: {
        status: result.status,
        plant: result.plant,
        problem: result.problem,
        confidence: result.confidence === null ? null : Math.round(result.confidence * 100),
        text: result.raw_text,
      },
    });
  });

  app.get('/ai/diagnoses', {
    onRequest: ro,
    schema: {
      tags, security, summary: 'Riwayat diagnosis AI',
      querystring: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, device_id: { type: 'string' }, category: { type: 'string', enum: CATEGORIES }, severity: { type: 'string', enum: SEVERITIES }, action_status: { type: 'string', enum: ['pending', 'done', 'dismissed'] }, from: { type: 'string' }, to: { type: 'string' }, greenhouse_id: { type: 'string' } } },
    },
  }, async (request) => {
    const scope = ghScope(request);
    const { page, limit, offset } = pageParams(request.query);
    const f = request.query;
    const q = db('ai_diagnoses');
    if (scope) q.where({ greenhouse_id: scope });
    for (const k of ['device_id', 'category', 'severity', 'action_status']) if (f[k]) q.where({ [k]: f[k] });
    if (f.from) q.where('captured_at', '>=', toMs(f.from, 0));
    if (f.to) q.where('captured_at', '<=', toMs(f.to, now()));
    const [{ total }] = await q.clone().count({ total: '*' });
    const rows = await q.orderBy('captured_at', 'desc').limit(limit).offset(offset);
    return { data: rows.map(diagnosisDto), meta: pageMeta(page, limit, Number(total)) };
  });

  app.get('/ai/diagnoses/:id', { onRequest: ro, schema: { tags, security, summary: 'Detail diagnosis AI', params: idParam } }, async (request) => {
    const scope = ghScope(request);
    const q = db('ai_diagnoses').where({ id: request.params.id });
    if (scope) q.andWhere({ greenhouse_id: scope });
    const row = await q.first();
    if (!row) throw httpError(404, 'Diagnosis tidak ditemukan', 'DIAGNOSIS_NOT_FOUND');
    return diagnosisDto(row);
  });

  app.patch('/ai/diagnoses/:id/action', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Tandai tindak lanjut rekomendasi (pending / done / dismissed)', params: idParam,
      body: { type: 'object', additionalProperties: false, required: ['action_status'], properties: { action_status: { type: 'string', enum: ['pending', 'done', 'dismissed'] } } },
    },
  }, async (request) => {
    const scope = ghScope(request);
    const q = db('ai_diagnoses').where({ id: request.params.id });
    if (scope) q.andWhere({ greenhouse_id: scope });
    const row = await q.first();
    if (!row) throw httpError(404, 'Diagnosis tidak ditemukan', 'DIAGNOSIS_NOT_FOUND');
    await db('ai_diagnoses').where({ id: row.id }).update({ action_status: request.body.action_status });
    await logActivity(request, { action: 'ai.action_status', entity: 'ai_diagnosis', entity_id: row.id, description: `Tindak lanjut "${row.label}": ${request.body.action_status}`, greenhouse_id: row.greenhouse_id });
    return diagnosisDto(await db('ai_diagnoses').where({ id: row.id }).first());
  });

  // Rekomendasi tindakan yang belum ditindaklanjuti
  app.get('/ai/recommendations', {
    onRequest: ro,
    schema: { tags, security, summary: 'Rekomendasi tindakan dari AI yang masih pending', querystring: { type: 'object', properties: { device_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }, greenhouse_id: { type: 'string' } } } },
  }, async (request) => {
    const scope = ghScope(request);
    const q = db('ai_diagnoses').where({ action_status: 'pending' }).whereNot({ severity: 'none' });
    if (scope) q.andWhere({ greenhouse_id: scope });
    if (request.query.device_id) q.andWhere({ device_id: request.query.device_id });
    const rows = await q.orderBy('captured_at', 'desc').limit(request.query.limit || 10);
    return {
      data: rows.map((r) => ({
        diagnosis_id: r.id,
        label: r.label,
        severity: r.severity,
        recommendation: r.recommendation,
        recommended_actions: parseJson(r.recommended_actions, []),
        captured_at: new Date(Number(r.captured_at)).toISOString(),
      })),
    };
  });

  // ---- Pertumbuhan ----
  app.post('/ai/growth', {
    onRequest: userOnly,
    schema: {
      tags, security, summary: 'Catat data pertumbuhan tanaman (tinggi, jumlah daun, skor kesehatan)',
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device_id: { type: 'string' },
          recorded_at: { type: 'string' },
          height_cm: { type: 'number', minimum: 0 },
          leaf_count: { type: 'integer', minimum: 0 },
          health_score: { type: 'number', minimum: 0, maximum: 100 },
          notes: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const b = request.body || {};
    if (b.height_cm === undefined && b.leaf_count === undefined && b.health_score === undefined) {
      throw httpError(400, 'Isi minimal salah satu: height_cm, leaf_count, health_score', 'VALIDATION_ERROR');
    }
    const { greenhouse_id, device } = await resolveTarget(request, b.device_id);
    const t = now();
    const row = {
      id: newId(),
      greenhouse_id,
      device_id: device?.id ?? null,
      recorded_at: toMs(b.recorded_at, t),
      height_cm: b.height_cm ?? null,
      leaf_count: b.leaf_count ?? null,
      health_score: b.health_score ?? null,
      notes: b.notes ?? null,
      created_at: t,
    };
    await db('growth_records').insert(row);
    return reply.code(201).send(dto(row));
  });

  app.get('/ai/growth', {
    onRequest: ro,
    schema: {
      tags, security, summary: 'Grafik tren pertumbuhan tanaman',
      querystring: { type: 'object', properties: { device_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 2000, default: 365 }, greenhouse_id: { type: 'string' } } },
    },
  }, async (request) => {
    const scope = ghScope(request);
    const f = request.query;
    const q = db('growth_records');
    if (scope) q.where({ greenhouse_id: scope });
    if (f.device_id) q.where({ device_id: f.device_id });
    q.where('recorded_at', '>=', toMs(f.from, now() - 30 * 86_400_000)).where('recorded_at', '<=', toMs(f.to, now()));
    const rows = (await q.orderBy('recorded_at', 'desc').limit(f.limit || 365)).reverse();
    const withHeight = rows.filter((r) => r.height_cm !== null);
    return {
      count: rows.length,
      summary: {
        first: rows[0] ? dto(rows[0]) : null,
        latest: rows.at(-1) ? dto(rows.at(-1)) : null,
        height_change_cm: withHeight.length > 1 ? Math.round((withHeight.at(-1).height_cm - withHeight[0].height_cm) * 10) / 10 : null,
      },
      data: rows.map((r) => dto(r)),
    };
  });

  // Prediksi kesehatan: regresi linear sederhana dari health_score historis (baseline, bukan model AI).
  app.get('/ai/prediction', {
    onRequest: ro,
    schema: {
      tags, security, summary: 'Prediksi skor kesehatan tanaman beberapa hari ke depan',
      querystring: { type: 'object', properties: { device_id: { type: 'string' }, history_days: { type: 'integer', minimum: 3, maximum: 90, default: 30 }, days: { type: 'integer', minimum: 1, maximum: 14, default: 7 }, greenhouse_id: { type: 'string' } } },
    },
  }, async (request) => {
    const scope = ghScope(request);
    const { history_days = 30, days = 7, device_id } = request.query;
    const q = db('growth_records').whereNotNull('health_score').where('recorded_at', '>=', now() - history_days * 86_400_000);
    if (scope) q.where({ greenhouse_id: scope });
    if (device_id) q.where({ device_id });
    const rows = await q.orderBy('recorded_at', 'asc');
    if (rows.length < 3) {
      return { available: false, reason: 'Data skor kesehatan belum cukup (minimal 3 catatan)', samples: rows.length };
    }

    const t0 = Number(rows[0].recorded_at);
    const xs = rows.map((r) => (Number(r.recorded_at) - t0) / 86_400_000);
    const ys = rows.map((r) => r.health_score);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = my - slope * mx;
    const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
    const clamp = (v) => Math.max(0, Math.min(100, Math.round(v * 10) / 10));

    const lastX = xs.at(-1);
    const forecast = Array.from({ length: days }, (_, i) => {
      const dayX = lastX + i + 1;
      return { date: new Date(t0 + dayX * 86_400_000).toISOString().slice(0, 10), predicted_health_score: clamp(intercept + slope * dayX) };
    });
    return {
      available: true,
      method: 'linear_regression',
      samples: n,
      current_health_score: ys.at(-1),
      trend: slope > 0.2 ? 'improving' : slope < -0.2 ? 'declining' : 'stable',
      slope_per_day: Math.round(slope * 100) / 100,
      r_squared: Math.round(r2 * 100) / 100,
      forecast,
    };
  });
}
