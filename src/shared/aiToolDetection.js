/**
 * AI Tool Command Detection
 * Shared matcher for mapping a typed command line to an AI tool id.
 * Fast heuristic only — the authoritative signal is process-based
 * detection in src/main/aiToolProcessDetector.js.
 */

const AI_TOOL_COMMAND_MAP = {
  claude: 'claude',
  codex: 'codex'
};

/**
 * Match a submitted command line to an AI tool id.
 * Compares the basename of the first token case-insensitively, so
 * `/usr/local/bin/claude -p` and `CLAUDE` both match.
 * @param {string} line - Full command line as typed
 * @returns {'claude'|'codex'|null}
 */
function matchAiToolCommand(line) {
  if (!line || typeof line !== 'string') return null;

  const trimmed = line.trim();
  if (!trimmed) return null;

  const [firstToken] = trimmed.split(/\s+/);
  const basename = firstToken.toLowerCase().split(/[\\/]/).pop();
  return AI_TOOL_COMMAND_MAP[basename] || null;
}

module.exports = { AI_TOOL_COMMAND_MAP, matchAiToolCommand };
