const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('util');

// Patch child_process.execFile BEFORE the manager is required: it destructures
// and promisifies execFile at module load (Keychain token lookup).
const childProcess = require('child_process');
let keychainStdout = JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } });
let keychainFails = false;

const fakeExecFile = () => { throw new Error('callback path not used'); };
fakeExecFile[util.promisify.custom] = async () => {
  if (keychainFails) throw new Error('keychain locked');
  return { stdout: keychainStdout, stderr: '' };
};
childProcess.execFile = fakeExecFile;

// https.request is called per fetch, so patching the shared module object works.
const https = require('https');
let nextResponse = null; // { statusCode, body } | { networkError } | { timeout: true }

https.request = (options, onResponse) => {
  const response = nextResponse;
  const reqHandlers = {};
  const req = {
    on: (event, handler) => { reqHandlers[event] = handler; return req; },
    destroy: () => {},
    end: () => {
      setImmediate(() => {
        if (response.networkError) {
          reqHandlers.error(new Error(response.networkError));
          return;
        }
        if (response.timeout) {
          reqHandlers.timeout();
          return;
        }
        const resHandlers = {};
        const res = {
          statusCode: response.statusCode,
          on: (event, handler) => { resHandlers[event] = handler; return res; }
        };
        onResponse(res);
        resHandlers.data(response.body || '');
        resHandlers.end();
      });
    }
  };
  return req;
};

const claudeUsageManager = require('../src/main/claudeUsageManager');

const goodBody = JSON.stringify({
  five_hour: { utilization: 17, resets_at: '2026-07-10T14:00:00Z' },
  seven_day: { utilization: 11, resets_at: '2026-07-13T10:00:00Z' }
});

test('cold error (no cache) returns nulls so the UI can show N/A', async () => {
  nextResponse = { statusCode: 401, body: '{}' };
  const usage = await claudeUsageManager.fetchUsage();

  assert.equal(usage.error, 'Token expired or invalid');
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.sevenDay, null);
});

test('missing token without cache returns nulls', async () => {
  keychainFails = true;
  const usage = await claudeUsageManager.fetchUsage();
  keychainFails = false;

  assert.equal(usage.error, 'No OAuth token found');
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.sevenDay, null);
});

test('successful fetch returns utilization and seeds the cache', async () => {
  nextResponse = { statusCode: 200, body: goodBody };
  const usage = await claudeUsageManager.fetchUsage();

  assert.equal(usage.error, null);
  assert.equal(usage.fiveHour.utilization, 17);
  assert.equal(usage.sevenDay.utilization, 11);
});

test('401 after a good fetch falls back to cached values with the error set', async () => {
  nextResponse = { statusCode: 401, body: '{}' };
  const usage = await claudeUsageManager.fetchUsage();

  assert.equal(usage.error, 'Token expired or invalid');
  assert.equal(usage.fiveHour.utilization, 17);
  assert.equal(usage.sevenDay.utilization, 11);
});

test('server error falls back to cached values', async () => {
  nextResponse = { statusCode: 500, body: 'oops' };
  const usage = await claudeUsageManager.fetchUsage();

  assert.equal(usage.error, 'API error: 500');
  assert.equal(usage.fiveHour.utilization, 17);
});

test('unparseable body falls back to cached values', async () => {
  nextResponse = { statusCode: 200, body: 'not json' };
  const usage = await claudeUsageManager.fetchUsage();

  assert.equal(usage.error, 'Failed to parse response');
  assert.equal(usage.fiveHour.utilization, 17);
});

test('network error and timeout fall back to cached values', async () => {
  nextResponse = { networkError: 'ECONNRESET' };
  const networkUsage = await claudeUsageManager.fetchUsage();
  assert.equal(networkUsage.error, 'Network error: ECONNRESET');
  assert.equal(networkUsage.fiveHour.utilization, 17);

  nextResponse = { timeout: true };
  const timeoutUsage = await claudeUsageManager.fetchUsage();
  assert.equal(timeoutUsage.error, 'Request timeout');
  assert.equal(timeoutUsage.sevenDay.utilization, 11);
});
