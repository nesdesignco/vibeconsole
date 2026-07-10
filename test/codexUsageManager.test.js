const test = require('node:test');
const assert = require('node:assert/strict');

const codexUsageManager = require('../src/main/codexUsageManager');

function buildTokenCountEvent({ limitId, primary = 0, secondary = 0, timestamp = '2026-02-12T20:56:54.914Z' }) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: limitId,
        primary: { used_percent: primary, resets_at: 1770946556 },
        secondary: { used_percent: secondary, resets_at: 1771414470 }
      }
    }
  });
}

test('selectBestRateLimit prefers aggregate codex over model specific', () => {
  const content = [
    buildTokenCountEvent({ limitId: 'codex', primary: 12, secondary: 34 }),
    buildTokenCountEvent({ limitId: 'codex_bengalfox', primary: 0, secondary: 0 })
  ].join('\n');

  const candidates = codexUsageManager.parseTokenCountCandidatesFromContent(content);
  const selected = codexUsageManager.selectBestRateLimit(candidates);

  assert.ok(selected);
  assert.equal(selected.limitId, 'codex');
  assert.equal(selected.tokenCount.rate_limits.primary.used_percent, 12);
});

test('selectBestRateLimit falls back to model specific when aggregate is absent', () => {
  const content = [
    buildTokenCountEvent({ limitId: 'codex_bengalfox', primary: 21, secondary: 41 }),
    buildTokenCountEvent({ limitId: 'codex_orca', primary: 22, secondary: 42 })
  ].join('\n');

  const candidates = codexUsageManager.parseTokenCountCandidatesFromContent(content);
  const selected = codexUsageManager.selectBestRateLimit(candidates);

  assert.ok(selected);
  assert.ok(/^codex_/.test(selected.limitId));
});

test('parseTokenCountCandidatesFromContent skips malformed lines', () => {
  const content = [
    '{bad json',
    buildTokenCountEvent({ limitId: 'codex', primary: 7, secondary: 9 }),
    JSON.stringify({ timestamp: '2026-02-12T20:56:55.000Z', type: 'event_msg', payload: { type: 'agent_reasoning' } })
  ].join('\n');

  const candidates = codexUsageManager.parseTokenCountCandidatesFromContent(content);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].limitId, 'codex');
});

test('normalizeUsage includes source metadata and ISO reset times', () => {
  const content = buildTokenCountEvent({ limitId: 'codex', primary: 45, secondary: 67 });
  const candidates = codexUsageManager.parseTokenCountCandidatesFromContent(content);
  const selected = codexUsageManager.selectBestRateLimit(candidates);
  const normalized = codexUsageManager.normalizeUsage(selected);

  assert.equal(normalized.error, null);
  assert.equal(normalized.sourceLimitId, 'codex');
  assert.equal(normalized.sourceTimestamp, '2026-02-12T20:56:54.914Z');
  assert.equal(normalized.fiveHour.utilization, 45);
  assert.equal(normalized.sevenDay.utilization, 67);
  assert.equal(normalized.fiveHour.resetsAt, codexUsageManager.toIsoFromUnixSeconds(1770946556));
  assert.equal(normalized.sevenDay.resetsAt, codexUsageManager.toIsoFromUnixSeconds(1771414470));
});

test('normalizeUsage returns no-data shape for missing candidate', () => {
  const normalized = codexUsageManager.normalizeUsage(null);

  assert.equal(normalized.error, 'No usage data available');
  assert.equal(normalized.fiveHour, null);
  assert.equal(normalized.sevenDay, null);
  assert.equal(normalized.sourceLimitId, null);
  assert.equal(normalized.sourceTimestamp, null);
});

test('applyWindowExpiry zeroes windows whose reset time has passed', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const usage = {
    fiveHour: { utilization: 13, resetsAt: '2026-07-10T10:55:00Z' },
    sevenDay: { utilization: 2, resetsAt: '2026-07-16T22:00:00Z' },
    error: null
  };

  const result = codexUsageManager.applyWindowExpiry(usage, now);

  assert.deepEqual(result.fiveHour, { utilization: 0, resetsAt: null, expired: true });
  assert.deepEqual(result.sevenDay, usage.sevenDay); // future window untouched
});

test('applyWindowExpiry leaves null windows and future windows untouched', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const usage = {
    fiveHour: null,
    sevenDay: { utilization: 5, resetsAt: '2026-07-12T00:00:00Z' },
    error: null
  };

  const result = codexUsageManager.applyWindowExpiry(usage, now);

  assert.equal(result.fiveHour, null);
  assert.deepEqual(result.sevenDay, usage.sevenDay);
  assert.equal(codexUsageManager.applyWindowExpiry(null, now), null);
});

test('applyWindowExpiry does not mutate its input', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const usage = {
    fiveHour: { utilization: 13, resetsAt: '2026-07-10T10:55:00Z' },
    sevenDay: { utilization: 2, resetsAt: '2026-07-10T10:55:00Z' },
    error: null
  };

  codexUsageManager.applyWindowExpiry(usage, now);

  assert.equal(usage.fiveHour.utilization, 13);
  assert.equal(usage.fiveHour.resetsAt, '2026-07-10T10:55:00Z');
  assert.equal(usage.fiveHour.expired, undefined);
});

test('applyWindowExpiry composes with normalizeUsage on an expired event', () => {
  const pastUnixSeconds = 1770946556; // 2026-02-13
  const content = buildTokenCountEvent({ limitId: 'codex', primary: 45, secondary: 67 });
  const candidates = codexUsageManager.parseTokenCountCandidatesFromContent(content);
  const normalized = codexUsageManager.normalizeUsage(codexUsageManager.selectBestRateLimit(candidates));
  const now = (pastUnixSeconds + 60) * 1000;

  const result = codexUsageManager.applyWindowExpiry(normalized, now);

  assert.equal(result.fiveHour.utilization, 0);
  assert.equal(result.fiveHour.expired, true);
  assert.equal(result.sevenDay.utilization, 67); // its reset is still in the future
});
