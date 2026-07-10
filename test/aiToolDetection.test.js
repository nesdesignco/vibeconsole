const test = require('node:test');
const assert = require('node:assert/strict');

const { matchAiToolCommand } = require('../src/shared/aiToolDetection');

test('matches plain tool commands', () => {
  assert.equal(matchAiToolCommand('claude'), 'claude');
  assert.equal(matchAiToolCommand('codex --yolo'), 'codex');
  assert.equal(matchAiToolCommand('  claude --resume  '), 'claude');
});

test('matches by basename of the first token', () => {
  assert.equal(matchAiToolCommand('/usr/local/bin/claude -p "hi"'), 'claude');
  assert.equal(matchAiToolCommand('C:\\tools\\codex'), 'codex');
  assert.equal(matchAiToolCommand('C:\\tools\\claude --help'), 'claude');
});

test('matches case-insensitively', () => {
  assert.equal(matchAiToolCommand('CLAUDE'), 'claude');
  assert.equal(matchAiToolCommand('Codex resume'), 'codex');
});

test('does not match other commands or partial names', () => {
  assert.equal(matchAiToolCommand('claudette'), null);
  assert.equal(matchAiToolCommand('npx claude'), null); // known limitation - process detection covers it
  assert.equal(matchAiToolCommand('git status'), null);
  assert.equal(matchAiToolCommand(''), null);
  assert.equal(matchAiToolCommand('   '), null);
  assert.equal(matchAiToolCommand(null), null);
  assert.equal(matchAiToolCommand(42), null);
});
