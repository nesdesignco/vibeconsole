/**
 * Shell Escape Utility
 * Safely escapes strings for use in shell commands sent to PTY
 */

/**
 * Escape a string for safe use in a single-quoted shell argument.
 * Uses the '\'' break-out pattern: end quote, escaped quote, start quote.
 * @param {string} str
 * @returns {string} Shell-safe quoted string
 */
function shellQuote(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape a string for use with bash $'...' ANSI-C quoting.
 * Supports multi-line strings (newlines become \n).
 * @param {string} str
 * @returns {string} ANSI-C quoted string: $'...'
 */
function ansiCQuote(str) {
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return "$'" + escaped + "'";
}

module.exports = { shellQuote, ansiCQuote };
