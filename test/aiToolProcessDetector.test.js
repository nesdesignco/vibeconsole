const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

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

test('detects native and interpreter CLIs without matching prompt arguments', () => {
  const entries = [
    ['grok', 'grok', 'grok'],
    ['/bin/node', 'node /usr/local/bin/gemini', 'gemini'],
    ['node', 'node /opt/lib/node_modules/@google/gemini-cli/dist/index.js', 'gemini'],
    ['node', 'node --no-warnings /opt/lib/node_modules/@qwen-code/qwen-code/dist/index.js', 'qwen'],
    ['node', 'node /opt/lib/node_modules/@github/copilot/npm-loader.js', 'copilot'],
    ['node', 'node /opt/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs', 'kimi'],
    ['node', 'node /opt/cursor-agent/versions/2026.09/index.js', 'cursor'],
    ['python3.13', 'python3.13 /Users/me/.local/bin/kimi', 'kimi'],
    ['python3', 'python3 -m kimi_cli', 'kimi'],
    ['node', 'node "/Users/my name/.local/bin/qwen"', 'qwen'],
    ['node', 'node app.js /opt/bin/gemini', null],
    ['node', 'node -e "qwen"', null],
    ['python3', 'python3 -c "kimi"', null],
    ['zsh', 'zsh -c grok', null],
    ['node', 'node /app/not-gemini-cli/index.js --prompt kimi', null]
  ];
  for (const [comm, args, expected] of entries) {
    const maps = detector.parsePsOutput(`300 200 ${comm}`);
    maps.argsByPid = new Map([[300, args]]);
    assert.equal(detector.detectToolForPid(200, maps), expected, args);
  }
  for (const name of ['grok', 'gemini', 'copilot', 'cursor-agent', 'qwen', 'kimi', 'kimi-cli']) {
    assert.ok(detector.commToTool(`/Users/me/Application Support/bin/${name}`), name);
  }
  assert.equal(detector.commToTool('grok-helper'), null);
  assert.equal(detector.commToTool('constructor'), null);
});

test('shared agent alias is identified by its target, never by its name alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agent-alias-'));
  try {
    for (const [folder, binary, expected] of [
      ['grok', 'grok-macos-aarch64', 'grok'], ['cursor', 'cursor-agent', 'cursor'], ['other', 'other-agent', null]
    ]) {
      const folderPath = path.join(dir, folder);
      fs.mkdirSync(folderPath);
      fs.writeFileSync(path.join(folderPath, binary), 'test binary');
      fs.symlinkSync(binary, path.join(folderPath, 'agent'));
      assert.equal(detector.commToTool(path.join(folderPath, 'agent')), expected);
    }
    assert.equal(detector.commToTool('agent'), null);
    assert.equal(detector.commToTool('/nonexistent/agent'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real interpreter processes with spaces in executable and script paths are detected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-process-space-'));
  const installDir = path.join(dir, 'Example User', 'CLI Tools');
  fs.mkdirSync(installDir, { recursive: true });
  const node = path.join(installDir, 'node');
  const script = path.join(installDir, 'qwen');
  fs.symlinkSync(process.execPath, node);
  fs.writeFileSync(script, 'process.stdout.write("ready"); setInterval(() => {}, 1000);');
  const child = spawn(node, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Child exited: ${code}`)));
    });
    const comm = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'comm=']).toString().trim();
    const args = execFileSync('/bin/ps', ['-ww', '-p', String(child.pid), '-o', 'args=']).toString().trim();
    assert.equal(detector.interpreterToTool(comm, args), 'qwen');
    assert.equal(detector.interpreterToTool('node', `node --no-warnings ${script}`), 'qwen');
    const otherScript = path.join(installDir, 'app.js');
    fs.writeFileSync(otherScript, '');
    assert.equal(detector.interpreterToTool('node', `node ${otherScript} ${script}`), null);
    assert.equal(detector.interpreterToTool('node', `node -e "console.log('${script}')"`), null);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('close', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
