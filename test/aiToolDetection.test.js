const test = require('node:test');
const assert = require('node:assert/strict');

const { matchAiToolCommand, matchMissingAiTool } = require('../src/shared/aiToolDetection');

test('recognizes shell missing-command diagnostics without matching dependency failures or prose', () => {
  for (const line of ['zsh: command not found: copilot', 'bash: copilot: command not found',
    '/bin/sh: 1: copilot: not found', 'sh: copilot: command not found\r',
    '/bin/bash: line 1: copilot: command not found', 'fish: Unknown command: copilot']) {
    assert.equal(matchMissingAiTool(line), 'copilot', line);
  }
  for (const line of ['zsh: command not found: npm', 'zsh: command not found: agent',
    'For example zsh: command not found: copilot', 'echo copilot: command not found',
    'zsh: permission denied: copilot', 'zsh: command not found: copilot-extra']) {
    assert.equal(matchMissingAiTool(line), null, line);
  }
  assert.equal(matchMissingAiTool('zsh: command not found: cursor-agent'), 'cursor');
  assert.equal(matchMissingAiTool('zsh: command not found: kimi-cli'), 'kimi');
});

test('matches plain tool commands', () => {
  assert.equal(matchAiToolCommand('claude'), 'claude');
  assert.equal(matchAiToolCommand('codex --yolo'), 'codex');
  assert.equal(matchAiToolCommand('  claude --resume  '), 'claude');
});

test('matches all built-in launch commands and legacy aliases', () => {
  const { AI_TOOLS } = require('../src/shared/aiTools');
  assert.equal(Object.keys(AI_TOOLS).length, 8);
  for (const tool of Object.values(AI_TOOLS)) {
    for (const command of [tool.command, ...(tool.aliases || [])]) {
      assert.equal(matchAiToolCommand(`/usr/local/bin/${command} --resume`), tool.id);
    }
  }
  assert.equal(matchAiToolCommand('constructor'), null);
  assert.equal(matchAiToolCommand('echo qwen'), null);
  assert.equal(AI_TOOLS.cursor.command, 'cursor-agent');
  assert.equal(matchAiToolCommand('agent'), null); // Shared by Grok and Cursor.
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
