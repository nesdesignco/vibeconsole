const test = require('node:test');
const assert = require('node:assert/strict');

const { createTerminalLinkHandler } = require('../src/renderer/terminalManager');
const { IPC } = require('../src/shared/ipcChannels');

test('terminal link handler forwards OSC 8 links through the safe external URL channel', () => {
  const messages = [];
  const handler = createTerminalLinkHandler({
    send: (...args) => messages.push(args)
  });

  handler.activate({}, 'http://localhost:3000');

  assert.deepEqual(messages, [[IPC.OPEN_EXTERNAL_URL, 'http://localhost:3000']]);
  assert.equal(handler.allowNonHttpProtocols, undefined);
});

test('terminal link handler normalizes bare-domain links before sending', () => {
  const messages = [];
  const handler = createTerminalLinkHandler({
    send: (...args) => messages.push(args)
  });

  handler.activate({}, 'form-drive.vercel.app');
  handler.activate({}, 'localhost:3000');
  handler.activate({}, 'https://example.com/a).');

  assert.deepEqual(messages, [
    [IPC.OPEN_EXTERNAL_URL, 'https://form-drive.vercel.app'],
    [IPC.OPEN_EXTERNAL_URL, 'http://localhost:3000'],
    [IPC.OPEN_EXTERNAL_URL, 'https://example.com/a']
  ]);
});

test('terminal link handler opens one URL per click even when both paths fire', () => {
  const messages = [];
  const handler = createTerminalLinkHandler({
    send: (...args) => messages.push(args)
  });

  const before = handler.lastSentAt;
  handler.activate({}, 'https://example.com');
  handler.activate({}, 'https://example.com'); // fallback + native aynı tıklama
  handler.activate({}, 'https://other.com');

  assert.deepEqual(messages, [
    [IPC.OPEN_EXTERNAL_URL, 'https://example.com'],
    [IPC.OPEN_EXTERNAL_URL, 'https://other.com']
  ]);
  assert.ok(handler.lastSentAt >= before);
});

test('terminal link handler drops unusable link text instead of sending garbage', () => {
  const messages = [];
  const handler = createTerminalLinkHandler({
    send: (...args) => messages.push(args)
  });

  handler.activate({}, ')..');
  handler.activate({}, '');

  assert.deepEqual(messages, []);
});
