/**
 * File Path Link Provider for xterm.js
 * Detects file paths in terminal output and makes them clickable.
 * Uses terminal.registerLinkProvider() custom ILinkProvider API.
 */

const { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } = require('../shared/mediaTypes');

// Extension-anchored regex:
// - Must contain at least one slash (avoids false positives like "package.json")
// - Matches absolute (/x/y.js), explicit-relative (./x.js, ../x.js) and bare
//   relative (src/renderer/editor.js) forms — the last is what linters, test
//   runners and git print, so it is the common case.
// - Captures optional :line and :line:col suffixes
// - Excludes URLs (handled by urlLinker/WebLinksAddon)
const KNOWN_EXTENSIONS = 'js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|fish|css|scss|sass|less|html|htm|xml|svg|json|jsonc|yaml|yml|toml|ini|cfg|conf|md|mdx|txt|log|env|lock|sql|graphql|gql|vue|svelte|astro|prisma|proto|makefile|dockerfile|cmake';

const FILE_PATH_RE = new RegExp(
  // Not preceded by word char, colon, slash, dot or @ — keeps the match from
  // starting midway through a URL, a domain or a longer path.
  '(?<![\\w:/.@-])' +
  '(' +
    '(?:' +
      '(?:\\.{1,2}/|/)(?:[\\w.@_-]+/)*' +   // /abs/…, ./rel/…, ../rel/…
      '|' +
      // Bare relative. The first segment may not contain a dot, so bare domains
      // such as example.com/app.js stay with the URL linker instead.
      '[\\w@_-]+/(?:[\\w.@_-]+/)*' +
    ')' +
    '[\\w.@_-]+\\.(?:' + [KNOWN_EXTENSIONS, ...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].join('|') + ')' +
  ')' +
  '(?::(\\d+)(?::(\\d+))?)?' +               // optional :line:col
  '(?=[\\s\'",;)\\]}>|`]|$)',                 // lookahead: ends at whitespace, punctuation, or EOL
  'gi'
);

/**
 * Find every file-path match in a line of terminal text.
 * Pure helper so the pattern can be tested without an xterm instance.
 * @param {string} text
 * @returns {Array<{path: string, line: number|undefined, col: number|undefined, index: number, length: number, text: string}>}
 */
function findFilePathMatches(text) {
  const matches = [];
  if (!text) return matches;

  FILE_PATH_RE.lastIndex = 0;
  let match;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    matches.push({
      path: match[1],
      line: match[2] ? parseInt(match[2], 10) : undefined,
      col: match[3] ? parseInt(match[3], 10) : undefined,
      index: match.index,
      length: match[0].length,
      text: match[0]
    });
  }
  return matches;
}

/**
 * Create and register a file path link provider on a terminal instance.
 * @param {Terminal} terminal - xterm.js Terminal instance
 * @param {Function} onActivate - callback(filePath, line, col)
 * @returns {IDisposable} disposable to unregister the provider
 */
function getFilePathLinks(terminal, bufferLineNumber, onActivate) {
  const buffer = terminal.buffer.active;
  let firstRow = bufferLineNumber - 1;
  if (!buffer.getLine(firstRow)) return [];
  while (firstRow > 0 && buffer.getLine(firstRow).isWrapped) firstRow--;

  // Keep a string-index → cell map: wrapped lines and wide/combined characters
  // otherwise put the clickable region on the wrong text.
  let text = '';
  const positions = [];
  for (let row = firstRow; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (row > firstRow && !line.isWrapped) break;
    for (let col = 0; col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) positions.push({ x: col + 1, y: row + 1 });
    }
  }

  return findFilePathMatches(text).map(match => ({
    range: { start: positions[match.index], end: positions[match.index + match.length - 1] },
    text: match.text,
    activate() { onActivate(match.path, match.line, match.col); }
  }));
}

function registerFilePathLinks(terminal, onActivate) {
  const provider = {
    provideLinks(bufferLineNumber, callback) {
      const links = getFilePathLinks(terminal, bufferLineNumber, onActivate);

      callback(links.length > 0 ? links : undefined);
    }
  };

  return terminal.registerLinkProvider(provider);
}

module.exports = { registerFilePathLinks, findFilePathMatches, getFilePathLinks };
