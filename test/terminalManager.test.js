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
