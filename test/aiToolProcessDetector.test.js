const test = require('node:test');
const assert = require('node:assert/strict');

// aiToolProcessDetector requires ptyManager, which requires node-pty (a
// native module built for Electron's ABI) - stub it like ptyManager.test.js.
const nodePtyPath = require.resolve('node-pty');
require.cache[nodePtyPath] = {
  id: nodePtyPath,
  filename: nodePtyPath,
  loaded: true,
  exports: { spawn: () => { throw new Error('not used in this test'); } }
};

const detector = require('../src/main/aiToolProcessDetector');

test('parsePsOutput builds pid/ppid/comm maps, comm may contain spaces', () => {
  const output = [
    '  100     1 /sbin/launchd',
    '  200   100 -zsh',
    '  300   200 /Users/x/Application Support/bin/codex',
    '  400   200 claude',
    'garbage line',
    ''
  ].join('\n');

  const { commByPid, childrenByPpid } = detector.parsePsOutput(output);

  assert.equal(commByPid.get(300), '/Users/x/Application Support/bin/codex');
  assert.equal(commByPid.get(400), 'claude');
  assert.deepEqual(childrenByPpid.get(200), [300, 400]);
  assert.equal(commByPid.has(NaN), false);
});

test('commToTool matches exact basenames case-insensitively', () => {
  assert.equal(detector.commToTool('claude'), 'claude');
  assert.equal(detector.commToTool('CLAUDE'), 'claude');
  assert.equal(detector.commToTool('/Users/x/.npm-global/lib/bin/codex'), 'codex');
  assert.equal(detector.commToTool('codex-code-mode-host'), null);
  assert.equal(detector.commToTool('-zsh'), null);
  assert.equal(detector.commToTool(''), null);
  assert.equal(detector.commToTool(null), null);
});

test('detectToolForPid finds a direct child', () => {
  const maps = detector.parsePsOutput([
    '  200     1 -zsh',
    '  300   200 claude'
  ].join('\n'));

  assert.equal(detector.detectToolForPid(200, maps), 'claude');
});

test('detectToolForPid finds a grandchild through a nested shell', () => {
  const maps = detector.parsePsOutput([
    '  200     1 -zsh',
    '  300   200 /bin/zsh',
    '  400   300 /opt/bin/codex'
  ].join('\n'));

  assert.equal(detector.detectToolForPid(200, maps), 'codex');
});

test('detectToolForPid returns null when no tool is running', () => {
  const maps = detector.parsePsOutput([
    '  200     1 -zsh',
    '  300   200 vim'
  ].join('\n'));

  assert.equal(detector.detectToolForPid(200, maps), null);
});

test('detectToolForPid prefers the tool nearest to the shell', () => {
  // claude launched from inside codex: the shell-level codex wins
  const maps = detector.parsePsOutput([
    '  200     1 -zsh',
    '  300   200 /opt/bin/codex',
    '  400   300 claude'
  ].join('\n'));

  assert.equal(detector.detectToolForPid(200, maps), 'codex');
});

test('detectToolForPid terminates on ppid cycles', () => {
  const maps = detector.parsePsOutput([
    '  300   200 vim',
    '  200   300 -zsh'
  ].join('\n'));

  assert.equal(detector.detectToolForPid(200, maps), null);
});

test('nextDetectionState applies a detected tool immediately', () => {
  const next = detector.nextDetectionState({ effective: null, nullStreak: 1 }, 'claude');
  assert.deepEqual(next, { effective: 'claude', nullStreak: 0 });
});

test('nextDetectionState debounces disappearance over consecutive misses', () => {
  const afterFirstMiss = detector.nextDetectionState({ effective: 'claude', nullStreak: 0 }, null);
  assert.equal(afterFirstMiss.effective, 'claude'); // still held

  const afterSecondMiss = detector.nextDetectionState(afterFirstMiss, null);
  assert.equal(afterSecondMiss.effective, null); // cleared

  const recovered = detector.nextDetectionState(afterFirstMiss, 'claude');
  assert.deepEqual(recovered, { effective: 'claude', nullStreak: 0 });
});

test('nextDetectionState stays null without a prior tool', () => {
  const next = detector.nextDetectionState(undefined, null);
  assert.equal(next.effective, null);
});
