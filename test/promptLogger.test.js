const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promptLogger = require('../src/main/promptLogger');

test('sanitizeHistoryLine redacts common tokens', () => {
  assert.equal(
    promptLogger.sanitizeHistoryLine('Authorization: Bearer eyJaaaaaaaa.bbbbbbbb.cccccccc', 't1'),
    'Authorization: Bearer [REDACTED]'
  );

  assert.equal(
    promptLogger.sanitizeHistoryLine('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', 't1'),
    'OPENAI_API_KEY=[REDACTED]'
  );

  assert.equal(
    promptLogger.sanitizeHistoryLine('token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 't1'),
    'token=[REDACTED]'
  );

  assert.equal(
    promptLogger.sanitizeHistoryLine('password=my-super-secret-password', 't1'),
    'password=[REDACTED]'
  );
});

test('sanitizeHistoryLine redacts private key blocks line-by-line', () => {
  const tid = 'keyblock';
  assert.equal(
    promptLogger.sanitizeHistoryLine('-----BEGIN PRIVATE KEY-----', tid),
    '[REDACTED: PRIVATE KEY BLOCK]'
  );
  assert.equal(
    promptLogger.sanitizeHistoryLine('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj', tid),
    '[REDACTED: PRIVATE KEY BLOCK]'
  );
  assert.equal(
    promptLogger.sanitizeHistoryLine('-----END PRIVATE KEY-----', tid),
    '[REDACTED: PRIVATE KEY BLOCK]'
  );
  // After end marker, normal lines should pass through.
  assert.equal(
    promptLogger.sanitizeHistoryLine('echo hello', tid),
    'echo hello'
  );
});

test('getHistory returns only a bounded tail of a large log', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  promptLogger.init({ getPath: () => dir });
  const logPath = promptLogger.getLogFilePath();

  // ~3MB across 60k lines: well past both the byte and line bounds.
  const lines = Array.from({ length: 60000 }, (_, i) => `[2026-08-07T00:00:00.000Z] command number ${i}`);
  fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
  assert.ok(fs.statSync(logPath).size > 2 * 1024 * 1024);

  const history = await promptLogger.getHistory();

  assert.ok(history.length < 1024 * 1024, `tail should be bounded, got ${history.length} bytes`);
  const returned = history.split('\n').filter(Boolean);
  assert.ok(returned.length <= 5000, `expected at most 5000 lines, got ${returned.length}`);

  // The tail must be the newest entries, and never a partial first line.
  assert.equal(returned.at(-1), lines.at(-1));
  assert.ok(returned.every(l => l.startsWith('[')), 'no partial line may survive');
});

test('getHistory returns the whole log when it is small', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-history-small-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  promptLogger.init({ getPath: () => dir });
  fs.writeFileSync(promptLogger.getLogFilePath(), '[t] one\n[t] two\n', 'utf8');

  assert.equal(await promptLogger.getHistory(), '[t] one\n[t] two\n');
});

test('getHistory is empty when no log file exists', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-history-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  promptLogger.init({ getPath: () => dir });
  assert.equal(await promptLogger.getHistory(), '');
});
