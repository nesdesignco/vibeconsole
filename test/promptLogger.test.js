const test = require('node:test');
const assert = require('node:assert/strict');

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
