/**
 * File Path Link Provider for xterm.js
 * Detects file paths in terminal output and makes them clickable.
 * Uses terminal.registerLinkProvider() custom ILinkProvider API.
 */

// Extension-anchored regex:
// - Must contain at least one slash (avoids false positives like "package.json")
// - Supports optional ./ or absolute / prefix
// - Captures optional :line and :line:col suffixes
// - Excludes URLs (handled by WebLinksAddon)
const KNOWN_EXTENSIONS = 'js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|fish|css|scss|sass|less|html|htm|xml|svg|json|jsonc|yaml|yml|toml|ini|cfg|conf|md|mdx|txt|log|env|lock|sql|graphql|gql|vue|svelte|astro|prisma|proto|makefile|dockerfile|cmake';

const FILE_PATH_RE = new RegExp(
  '(?<![\\w:/])' +                           // negative lookbehind: not preceded by word char, colon, or slash (avoids URLs)
  '(\\.{0,2}/(?:[\\w.@_-]+/)*[\\w.@_-]+' +   // path with at least one slash
  '\\.(?:' + KNOWN_EXTENSIONS + '))' +        // known extension
  '(?::(\\d+)(?::(\\d+))?)?' +               // optional :line:col
  '(?=[\\s\'",;)\\]}>|`]|$)',                 // lookahead: ends at whitespace, punctuation, or EOL
  'gi'
);

/**
 * Create and register a file path link provider on a terminal instance.
 * @param {Terminal} terminal - xterm.js Terminal instance
 * @param {Function} onActivate - callback(filePath, line, col)
 * @returns {IDisposable} disposable to unregister the provider
 */
function registerFilePathLinks(terminal, onActivate) {
  const provider = {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      const links = [];

      FILE_PATH_RE.lastIndex = 0;
      let match;
      while ((match = FILE_PATH_RE.exec(text)) !== null) {
        const filePath = match[1];
        const lineNum = match[2] ? parseInt(match[2], 10) : undefined;
        const colNum = match[3] ? parseInt(match[3], 10) : undefined;
        const startX = match.index;
        const fullMatchLength = match[0].length;

        links.push({
          range: {
            start: { x: startX + 1, y: bufferLineNumber },  // x is 1-based
            end: { x: startX + fullMatchLength + 1, y: bufferLineNumber }
          },
          text: match[0],
          activate() {
            onActivate(filePath, lineNum, colNum);
          }
        });
      }

      callback(links.length > 0 ? links : undefined);
    }
  };

  return terminal.registerLinkProvider(provider);
}

module.exports = { registerFilePathLinks };
