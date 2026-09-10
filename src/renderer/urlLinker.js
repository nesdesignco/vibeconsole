/**
 * Bare URL Link Provider for xterm.js
 * Makes protocol-less web URLs clickable (www.*, bare domains like
 * form-drive.vercel.app or github.com/user/repo, localhost:3000).
 *
 * WebLinksAddon only linkifies http(s):// text and its internal isUrl()
 * check rejects protocol-less matches even with a custom urlRegex, so these
 * need their own provider (same ILinkProvider pattern as filePathLinker).
 */

const { BARE_URL_REGEX, findUrlAtColumn, stripTrailingJunk } = require('../shared/urlUtils');
const { getFilePathLinks } = require('./filePathLinker');

/**
 * Create and register a bare URL link provider on a terminal instance.
 * @param {Terminal} terminal - xterm.js Terminal instance
 * @param {Function} onActivate - callback(event, uri)
 * @returns {IDisposable} disposable to unregister the provider
 */
function registerBareUrlLinks(terminal, onActivate) {
  const provider = {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      const links = [];

      BARE_URL_REGEX.lastIndex = 0;
      let match;
      while ((match = BARE_URL_REGEX.exec(text)) !== null) {
        const uri = stripTrailingJunk(match[0]);
        if (!uri) continue;

        links.push({
          range: {
            start: { x: match.index + 1, y: bufferLineNumber },  // x is 1-based
            end: { x: match.index + uri.length + 1, y: bufferLineNumber }
          },
          text: uri,
          activate(event) {
            onActivate(event, uri);
          }
        });
      }

      callback(links.length > 0 ? links : undefined);
    }
  };

  return terminal.registerLinkProvider(provider);
}

/**
 * Resolve an OSC 8 hyperlink URI at a buffer cell, if any.
 * cell.extended.urlId and core._oscLinkService are internal xterm APIs
 * (no public equivalent exists); guarded so a future xterm change degrades
 * to "no OSC link found" instead of breaking clicks.
 */
function resolveOscUriAtCell(terminal, bufferRow, col) {
  try {
    const line = terminal.buffer.active.getLine(bufferRow);
    if (!line) return null;
    const cell = terminal.buffer.active.getNullCell();
    line.getCell(col, cell);
    const urlId = cell?.extended?.urlId;
    if (!urlId) return null;
    return terminal._core?._oscLinkService?.getLinkData?.(urlId)?.uri ?? null;
  } catch {
    return null;
  }
}

/**
 * Safety net that makes link clicks reliable in every terminal state.
 * xterm's native Linkifier activation is fragile: any viewport re-render
 * between mousedown and mouseup (a TUI like Codex/Claude Code redrawing on
 * mouse reports or streaming output) recreates the link object, and the
 * Linkifier's `_mouseDownLink === _currentLink` identity check fails — the
 * click silently does nothing. This fallback re-runs its own hit-test on
 * mouseup whenever native activation did not handle the click.
 *
 * Capture phase is required: xterm stops propagation of mouse events when
 * forwarding them to the application.
 */
function attachClickLinkFallback(terminal, element, linkHandler) {
  let downAt = null;

  element.addEventListener('mousedown', (event) => {
    downAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  }, true);

  element.addEventListener('mouseup', (event) => {
    const start = downAt;
    downAt = null;
    if (!start || event.button !== 0) return;
    // Shift+click extends the selection (or bypasses mouse reporting);
    // never treat it as a link click.
    if (event.shiftKey) return;
    // A real click, not a drag.
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 5) return;

    const upAt = Date.now();
    const clientX = event.clientX;
    const clientY = event.clientY;
    const screen = element.querySelector('.xterm-screen');
    if (!screen) return;
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const col = Math.floor((clientX - rect.left) / (rect.width / terminal.cols));
    const row = Math.floor((clientY - rect.top) / (rect.height / terminal.rows));
    if (col < 0 || row < 0 || col >= terminal.cols || row >= terminal.rows) return;
    const bufferRow = terminal.buffer.active.viewportY + row;
    // Snapshot before the TUI reacts to mouseup and replaces the visible text.
    const fileLink = getFilePathLinks(terminal, bufferRow + 1, linkHandler.activateFile).find(({ range }) =>
      (bufferRow + 1 > range.start.y || (bufferRow + 1 === range.start.y && col + 1 >= range.start.x)) &&
      (bufferRow + 1 < range.end.y || (bufferRow + 1 === range.end.y && col + 1 <= range.end.x)));
    const oscUri = resolveOscUriAtCell(terminal, bufferRow, col);
    const lineText = terminal.buffer.active.getLine(bufferRow)?.translateToString(false) ?? '';
    const uri = oscUri || findUrlAtColumn(lineText, col);
    // Defer past xterm's own mouseup handling; if the native path already
    // opened a link for this click, stay out of the way.
    setTimeout(() => {
      if (linkHandler.lastSentAt >= upAt) return;

      if (fileLink && linkHandler.activateFile && !oscUri) fileLink.activate();
      else if (uri) linkHandler.activate(event, uri);
    }, 30);
  }, true);
}

module.exports = { attachClickLinkFallback, registerBareUrlLinks };
