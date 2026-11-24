import assert from 'node:assert/strict';
import { calculateCalibrationProfile, composeCalibrationProfiles, calibratedReading, normalizeCalibrationSensor } from '../simulator/calibration.js';

const onePoint = calculateCalibrationProfile({ points: [{ measured: 6.2, reference: 6.86 }] });
assert.equal(onePoint.scale, 1);
assert.ok(Math.abs(onePoint.offset - 0.66) < 1e-9);

const twoPoint = calculateCalibrationProfile({ points: [
  { measured: 4.2, reference: 4.01 },
  { measured: 6.2, reference: 6.86 },
] });
assert.ok(twoPoint.scale > 0);
assert.ok(Math.abs(calibratedReading(4.2, twoPoint) - 4.01) < 1e-9);
assert.ok(Math.abs(calibratedReading(6.2, twoPoint) - 6.86) < 1e-9);

const repeated = composeCalibrationProfiles(twoPoint, { scale: 1, offset: 0.1 });
assert.ok(Math.abs(calibratedReading(4.2, repeated) - 4.11) < 1e-9);
assert.equal(normalizeCalibrationSensor('temp_water'), 'water_temp');
assert.equal(normalizeCalibrationSensor('temp_air'), 'air_temp');
assert.ok(calculateCalibrationProfile({ points: [{ measured: 2, reference: 3 }, { measured: 2, reference: 4 }] }).error);
console.log('Calibration simulator tests: OK');
