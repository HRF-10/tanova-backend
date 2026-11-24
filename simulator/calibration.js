// Kalibrasi affine untuk simulator Grove 1.
// measured adalah bacaan yang sedang terlihat; reference adalah nilai standar.
export const CALIBRATION_KEYS = ['ph', 'ec', 'water_temp', 'air_temp', 'humidity', 'waterflow'];

export function normalizeCalibrationSensor(value) {
  const key = String(value || '').toLowerCase();
  const aliases = { temp_water: 'water_temp', temp_air: 'air_temp', tds: 'ec' };
  return aliases[key] || key;
}

export function calculateCalibrationProfile(referenceValues) {
  const points = Array.isArray(referenceValues?.points) ? referenceValues.points : [];
  if (!points.length || points.length > 10) {
    return { error: 'reference_values.points wajib berisi 1 sampai 10 pasangan measured dan reference' };
  }
  const clean = points.map((point) => ({
    measured: Number(point?.measured),
    reference: Number(point?.reference),
  }));
  if (clean.some((point) => !Number.isFinite(point.measured) || !Number.isFinite(point.reference))) {
    return { error: 'Setiap titik kalibrasi harus memiliki measured dan reference berupa angka' };
  }
  if (clean.length === 1) {
    return { scale: 1, offset: clean[0].reference - clean[0].measured, points: clean };
  }
  const meanX = clean.reduce((sum, point) => sum + point.measured, 0) / clean.length;
  const meanY = clean.reduce((sum, point) => sum + point.reference, 0) / clean.length;
  const variance = clean.reduce((sum, point) => sum + (point.measured - meanX) ** 2, 0);
  if (variance < 1e-12) return { error: 'Nilai measured harus berbeda untuk kalibrasi multi-titik' };
  const covariance = clean.reduce((sum, point) => sum + (point.measured - meanX) * (point.reference - meanY), 0);
  const scale = covariance / variance;
  const offset = meanY - scale * meanX;
  if (!Number.isFinite(scale) || !Number.isFinite(offset) || scale <= 0 || scale > 10) {
    return { error: 'Koefisien kalibrasi tidak masuk akal; periksa nilai measured/reference' };
  }
  return { scale, offset, points: clean };
}

// Komposisi: koreksi baru diterapkan pada bacaan yang sudah dikoreksi sebelumnya.
export function composeCalibrationProfiles(previous, next) {
  return {
    scale: next.scale * (Number(previous?.scale) || 1),
    offset: next.scale * (Number(previous?.offset) || 0) + next.offset,
  };
}

export function calibratedReading(rawValue, profile) {
  return Number(rawValue) * (Number(profile?.scale) || 1) + (Number(profile?.offset) || 0);
}
