const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../src/telemetryProcessor');

test('parseEvent handles payload string wrapper', () => {
  const parsed = _internal.parseEvent({
    payload: JSON.stringify({
      deviceId: 'd-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      sensorType: 'temperature',
      value: 23,
    }),
  });

  assert.equal(parsed.deviceId, 'd-1');
});

test('isIso8601 validates timestamp strings', () => {
  assert.equal(_internal.isIso8601('2026-01-01T00:00:00.000Z'), true);
  assert.equal(_internal.isIso8601('invalid-date'), false);
});
