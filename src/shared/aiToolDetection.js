/**
 * AI Tool Command Detection
 * Shared matcher for mapping a typed command line to an AI tool id.
 * Fast heuristic only — the authoritative signal is process-based
 * detection in src/main/aiToolProcessDetector.js.
 */

const { AI_TOOLS } = require('./aiTools');
const AI_TOOL_COMMAND_MAP = Object.fromEntries(
  Object.values(AI_TOOLS).flatMap(tool =>
    [tool.command, ...(tool.aliases || [])].map(command => [command, tool.id]))
);

/**
 * Match a submitted command line to an AI tool id.
 * Compares the basename of the first token case-insensitively, so
 * `/usr/local/bin/claude -p` and `CLAUDE` both match.
 * @param {string} line - Full command line as typed
 * @returns {string|null}
 */
function matchAiToolCommand(line) {
  if (!line || typeof line !== 'string') return null;

  const trimmed = line.trim();
  if (!trimmed) return null;

  const [firstToken] = trimmed.split(/\s+/);
  const basename = firstToken.toLowerCase().split(/[\\/]/).pop();
  return Object.hasOwn(AI_TOOL_COMMAND_MAP, basename) ? AI_TOOL_COMMAND_MAP[basename] : null;
}

// Match complete shell diagnostics, not arbitrary mentions of a missing tool.
function matchMissingAiTool(line) {
  const match = line.trim().match(/^(?:zsh: command not found: |fish: Unknown command: )([\w-]+)$/i)
    || line.trim().match(/^(?:-?(?:\/[^\s:]+\/)?(?:ba|da|z|k)?sh): (?:\d+: |line \d+: )?([\w-]+): (?:command )?not found$/i);
  return match && Object.hasOwn(AI_TOOL_COMMAND_MAP, match[1]) ? AI_TOOL_COMMAND_MAP[match[1]] : null;
}

module.exports = { AI_TOOL_COMMAND_MAP, matchAiToolCommand, matchMissingAiTool };
