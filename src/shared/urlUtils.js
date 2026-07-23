/**
 * URL detection and normalization helpers for terminal links.
 * Shared by the renderer (bare URL link provider) and the main process
 * (external URL guard), like ipcChannels.js.
 */

// Curated TLD list keeps bare-domain matching conservative so file names
// (deploy.sh, index.js, config.json) never turn into links.
const BARE_TLDS = 'com|org|net|io|dev|app|ai|co|me|gg|xyz|info|edu|gov|tr|uk';

// Protocol-less web URLs: www.*, bare domains with a known TLD, localhost:port.
// The lookbehind blocks matches inside file paths (src/app.co), emails
// (user@host.com) and longer words; full http(s):// URLs are excluded the same
// way (their host is preceded by "/") and stay with WebLinksAddon.
const BARE_URL_REGEX = new RegExp(
  '(?<![\\w.@/-])' +
  '(?:' +
    'www\\.[\\w-]+(?:\\.[\\w-]+)+' +
    '|(?:[\\w-]+\\.)+(?:' + BARE_TLDS + ')(?![\\w-])' +
    '|localhost(?=:\\d)' +
  ')' +
  '(?::\\d{1,5})?' +
  '(?:/[^\\s"\'<>{}|\\\\^`\\[\\]]*)?',
  'g'
);

// Upstream WebLinksAddon strict pattern (keep in sync with
// @xterm/addon-web-links) — used for click hit-testing under TUI mouse capture.
const STRICT_URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

const TRAILING_PUNCTUATION_RE = /[.,;:!?'"`]+$/;
const BRACKET_PAIRS = [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']];

function countChar(text, char) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === char) count++;
  }
  return count;
}

/**
 * Strip punctuation that surrounding prose glued onto a URL: trailing
 * sentence punctuation and unbalanced closing brackets, e.g.
 * "(https://x.com/y)." -> the match "https://x.com/y)." -> "https://x.com/y".
 */
function stripTrailingJunk(text) {
  let url = String(text);
  let prev;
  do {
    prev = url;
    url = url.replace(TRAILING_PUNCTUATION_RE, '');
    for (const [open, close] of BRACKET_PAIRS) {
      if (url.endsWith(close) && countChar(url, close) > countChar(url, open)) {
        url = url.slice(0, -1);
      }
    }
  } while (url !== prev);
  return url;
}

/**
 * Normalize a candidate URL for opening in the default browser.
 * Adds a protocol when missing (http for localhost, https otherwise).
 * Returns null when nothing usable remains.
 */
function normalizeTerminalUrl(raw) {
  if (typeof raw !== 'string') return null;
  const url = stripTrailingJunk(raw.trim());
  if (!url) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
  if (/^localhost(?::|\/|$)/i.test(url)) return 'http://' + url;
  return 'https://' + url;
}

/**
 * Find the URL covering a 0-based column in a line of terminal text.
 * Checks full http(s) URLs first, then protocol-less ones.
 * Returns the cleaned URL text or null.
 */
function findUrlAtColumn(text, column) {
  const patterns = [
    new RegExp(STRICT_URL_REGEX.source, 'g'),
    new RegExp(BARE_URL_REGEX.source, BARE_URL_REGEX.flags)
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > column) break;
      const uri = stripTrailingJunk(match[0]);
      if (uri && column < match.index + uri.length) return uri;
    }
  }
  return null;
}

module.exports = { BARE_URL_REGEX, STRICT_URL_REGEX, findUrlAtColumn, normalizeTerminalUrl, stripTrailingJunk };
