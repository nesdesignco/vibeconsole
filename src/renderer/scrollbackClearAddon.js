/**
 * Compatibility fix for xterm 5.5: ED3 clears history but leaves its user-scroll
 * latch set, pinning subsequent output to row zero. Upstream fix:
 * https://github.com/xtermjs/xterm.js/pull/6081
 * Remove this addon once the installed xterm includes that fix and the real
 * Chromium scroll regression tests pass without it.
 */
class ScrollbackClearAddon {
  activate(terminal) {
    const beforeErase = params => {
      if (params[0] === 3 && terminal.buffer.active.type === 'normal') {
        // Reset follow-output synchronously, before the parser removes history
        // and consumes the rest of this write. A positive public scroll request
        // also resets the latch when baseY is already zero; scrollToBottom()
        // would be a no-op there. Never touch the normal scroll latch from alt.
        terminal.scrollLines(terminal.buffer.active.baseY + terminal.rows);
      }
      return false; // xterm still executes ED3; do not filter or rewrite output.
    };
    this.handlers = [
      terminal.parser.registerCsiHandler({ final: 'J' }, beforeErase),
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'J' }, beforeErase)
    ];
  }

  dispose() {
    this.handlers?.forEach(handler => handler.dispose());
    this.handlers = [];
  }
}

module.exports = { ScrollbackClearAddon };
