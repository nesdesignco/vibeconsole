const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpinner } = require('../src/renderer/spinnerButton');

test('spinner exposes busy state, prevents repeat work and always resets after failure', async () => {
  const classes = new Set();
  const attributes = new Map([['aria-label', 'Refresh']]);
  const button = { disabled: false, classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    getAttribute: name => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
  let finish;
  const started = Date.now();
  const task = withSpinner(button, () => new Promise((resolve, reject) => { finish = reject; }));
  assert.equal(button.disabled, true);
  assert.equal(attributes.get('aria-busy'), 'true');
  assert.equal(classes.has('spinning'), true);
  await withSpinner(button, () => assert.fail('duplicate work'));
  const rejected = assert.rejects(task, /offline/);
  finish(new Error('offline'));
  await rejected;
  assert.ok(Date.now() - started >= 400);
  assert.equal(button.disabled, false);
  assert.equal(classes.has('spinning'), false);
  assert.equal(attributes.has('aria-busy'), false);
  assert.equal(attributes.get('aria-label'), 'Refresh');
});
