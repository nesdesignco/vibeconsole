const { TerminalManager } = require('../../src/renderer/terminalManager');
const { TerminalGrid } = require('../../src/renderer/terminalGrid');
const { MultiTerminalUI } = require('../../src/renderer/multiTerminalUI');

const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
const position = terminal => ({ y: terminal.buffer.active.viewportY, base: terminal.buffer.active.baseY });
const scrollbar = terminal => {
  const viewport = terminal.element.querySelector('.xterm-viewport');
  const rowHeight = terminal.element.querySelector('.xterm-screen').getBoundingClientRect().height / terminal.rows;
  return { top: viewport.scrollTop, expected: terminal.buffer.active.viewportY * rowHeight };
};
const scrollbarMatches = terminal => {
  const { top, expected } = scrollbar(terminal);
  return Math.abs(top - expected) <= 1;
};

window.runScrollTests = async () => {
  const manager = new TerminalManager();
  const host = document.getElementById('host');
  // Use the real render paths without launching shells or the unrelated toolbar.
  const ui = Object.assign(Object.create(MultiTerminalUI.prototype), {
    manager, contentContainer: host, grid: new TerminalGrid(host, manager),
    _mountedTerminalId: null, _lastViewMode: 'tabs'
  });
  manager._initializeTerminal('a', {});
  manager._initializeTerminal('b', {});
  const a = manager.getTerminal('a');
  const terminal = a.terminal;
  const state = () => ({ terminals: manager.getTerminalStates(), activeTerminalId: manager.activeTerminalId, gridLayout: '1x2' });
  ui._renderTabView(state());
  await wait();
  await write(terminal, Array.from({length: 500}, (_, i) => `line ${i}\r\n`).join(''));
  await wait();
  const results = [];
  const check = (name, pass, details) => results.push({ name, pass, details });

  manager.setActiveTerminal('b'); ui._renderTabView(state());
  await wait();
  manager.setActiveTerminal('a'); ui._renderTabView(state());
  check('remount immediately restores the native scrollbar', scrollbarMatches(terminal), scrollbar(terminal));
  terminal.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
  await wait();
  check('downward wheel immediately after remount cannot jump upward', position(terminal).y === position(terminal).base && scrollbarMatches(terminal), { ...position(terminal), ...scrollbar(terminal) });

  terminal.scrollToBottom(); await wait();
  manager.setActiveTerminal('b'); ui._renderTabView(state());
  await wait();
  manager.setActiveTerminal('a'); ui._renderTabView(state());
  await write(terminal, 'output before native scroll event\r\n');
  await wait();
  check('remount plus queued output keeps thumb and content at bottom', position(terminal).y === position(terminal).base && scrollbarMatches(terminal), { ...position(terminal), ...scrollbar(terminal) });

  terminal.scrollToBottom();
  await wait();
  const writeMovements = [];
  const writeSubscription = terminal.onScroll(y => writeMovements.push(y));
  manager._writeKeepingBottom(a, 'queued output\r\n');
  terminal.scrollLines(-100); // Input arrives before the asynchronous parser finishes.
  const expected = position(terminal).y;
  await write(terminal, '');
  await wait();
  writeSubscription.dispose();
  check('scroll up during queued output', position(terminal).y === expected, { expected, actual: position(terminal), writeMovements });

  terminal.scrollToBottom();
  terminal.scrollLines(-1);
  const oneLineUp = position(terminal).y;
  manager._writeKeepingBottom(a, 'one more line\r\n');
  await write(terminal, '');
  await wait();
  check('one line above bottom remains anchored', position(terminal).y === oneLineUp, { expected: oneLineUp, actual: position(terminal) });

  terminal.scrollToLine(200);
  await wait();
  manager.setActiveTerminal('b'); ui._renderTabView(state());
  await wait();
  manager.setActiveTerminal('a'); ui._renderTabView(state());
  await wait();
  check('tab return preserves history', position(terminal).y === 200, position(terminal));
  check('tab return restores the history scrollbar', scrollbarMatches(terminal), scrollbar(terminal));

  terminal.scrollToBottom();
  ui._renderGridView(state());
  await wait(20);
  terminal.scrollToLine(150);
  await wait();
  check('scroll during mount is not overwritten', position(terminal).y === 150, position(terminal));

  terminal.scrollToTop();
  await wait();
  ui._renderTabView(state());
  await wait(20);
  terminal.scrollToBottom();
  await wait();
  check('returning to bottom during mount never jumps back to top', position(terminal).y === position(terminal).base, position(terminal));
  ui._renderGridView(state());
  await wait();

  terminal.scrollToBottom();
  await wait();
  for (let i = 0; i < 5; i++) { ui._renderGridView(state()); await wait(); }
  check('grid updates stay at bottom', position(terminal).y === position(terminal).base, position(terminal));
  check('grid updates retain layout class', host.classList.contains('terminal-grid'), host.className);

  terminal.scrollToLine(180);
  await wait();
  ui._renderTabView(state());
  await wait();
  check('grid to tab preserves history', position(terminal).y === 180, position(terminal));
  check('grid to tab restores the native scrollbar', scrollbarMatches(terminal), scrollbar(terminal));

  terminal.scrollToBottom();
  await wait();
  const movements = [];
  const subscription = terminal.onScroll(y => movements.push(y));
  manager.setActiveTerminal('b'); ui._renderTabView(state());
  await wait();
  manager.setActiveTerminal('a'); ui._renderTabView(state());
  await wait();
  subscription.dispose();
  check('tab remount never jumps to top, even briefly', !movements.includes(0), movements);

  terminal.scrollToBottom();
  await wait();
  manager.setActiveTerminal('b'); ui._renderTabView(state());
  await wait();
  await write(terminal, Array.from({length: 80}, () => 'hidden output\r\n').join(''));
  await wait();
  manager.setActiveTerminal('a'); ui._renderTabView(state());
  await wait();
  check('hidden output follows bottom on return', position(terminal).y === position(terminal).base, position(terminal));
  check('hidden output updates scrollbar height and position on return', scrollbarMatches(terminal), scrollbar(terminal));

  // Rapid transitions used to leave several delayed fit/restore callbacks alive.
  terminal.scrollToLine(220);
  await wait();
  for (let i = 0; i < 20; i++) {
    manager.setActiveTerminal('b'); ui._renderTabView(state());
    manager.setActiveTerminal('a'); ui._renderTabView(state());
    ui._renderGridView(state());
    ui._renderTabView(state());
  }
  await wait();
  check('rapid remounts preserve history', position(terminal).y === 220, position(terminal));

  ui._renderGridView(state());
  await wait();
  const mountedElement = terminal.element;
  const mountedCell = mountedElement.closest('.grid-cell');
  let fits = 0;
  const originalFit = a.fitAddon.fit.bind(a.fitAddon);
  a.fitAddon.fit = () => { fits++; originalFit(); };
  for (let i = 0; i < 5; i++) {
    a.state.customName = `Renamed ${i}`;
    manager.setActiveTerminal(i % 2 ? 'a' : 'b');
    ui._renderGridView(state());
    await wait(60);
  }
  check('metadata updates keep DOM and skip fitting', fits === 0 && mountedElement.closest('.grid-cell') === mountedCell,
    { fits, sameCell: mountedElement.closest('.grid-cell') === mountedCell });
  check('metadata updates refresh names', mountedCell.querySelector('.grid-cell-name').textContent === 'Renamed 4');
  a.fitAddon.fit = originalFit;

  manager.setActiveTerminal('a'); ui._renderTabView(state());
  await wait();
  terminal.scrollToBottom();
  await wait();
  for (let i = 0; i < 30; i++) manager._writeKeepingBottom(a, `burst ${i}\r\n`);
  await write(terminal, '');
  await wait();
  check('output still follows bottom', position(terminal).y === position(terminal).base, position(terminal));

  terminal.scrollToLine(200);
  await wait();
  manager.setActiveTerminal('b'); ui._renderTabView(state());
  await wait();
  manager._writeKeepingBottom(a, 'background while reading history\r\n');
  await write(terminal, '');
  await wait();
  manager.setActiveTerminal('a'); ui._renderTabView(state());
  await wait();
  check('hidden output preserves history on return', position(terminal).y === 200, position(terminal));
  check('hidden output keeps history thumb synchronized', scrollbarMatches(terminal), scrollbar(terminal));

  // Verify native resize/reflow using content, not obsolete absolute line offsets.
  host.style.width = '700px'; manager.fitAll();
  await wait();
  check('width resize preserves visible history', terminal.buffer.active.getLine(terminal.buffer.active.viewportY).translateToString(true) === 'line 200', position(terminal));
  terminal.scrollToBottom();
  await wait();
  host.style.height = '450px'; manager.fitAll();
  await wait();
  check('height resize follows bottom', position(terminal).y === position(terminal).base, position(terminal));
  terminal.scrollLines(-1);
  await wait();
  const beforeFit = position(terminal).y;
  manager.fitAll();
  await wait();
  check('unchanged fit preserves one-line scroll', position(terminal).y === beforeFit, position(terminal));

  terminal.scrollToLine(200);
  await wait();
  host.style.height = '500px'; manager.fitAll();
  await wait();
  check('height resize preserves visible history', terminal.buffer.active.getLine(terminal.buffer.active.viewportY).translateToString(true) === 'line 200', position(terminal));

  terminal.scrollToLine(210);
  await wait();
  await write(terminal, '\x1b[?1049hAlternate screen\r\n');
  await wait();
  manager._writeKeepingBottom(a, '\x1b[?1049l');
  await write(terminal, '');
  await wait();
  check('alternate screen exit preserves normal history', position(terminal).y === 210, position(terminal));

  terminal.options.scrollback = 600;
  await wait();
  terminal.scrollToLine(210);
  await wait();
  const anchor = terminal.buffer.active.getLine(210).translateToString(true);
  manager._writeKeepingBottom(a, Array.from({length: 100}, () => 'buffer trim\r\n').join(''));
  await write(terminal, '');
  await wait();
  check('scrollback trimming keeps the same visible text', terminal.buffer.active.getLine(terminal.buffer.active.viewportY).translateToString(true) === anchor, position(terminal));

  terminal.scrollToBottom();
  await wait();
  manager._writeKeepingBottom(a, 'wheel during output\r\n');
  terminal.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1600, bubbles: true, cancelable: true }));
  await write(terminal, '');
  await wait();
  check('DOM wheel during output remains above bottom', position(terminal).base - position(terminal).y > 50, position(terminal));

  terminal.options.scrollback = 10000;
  terminal.reset();
  host.style.width = '900px'; manager.fitAll();
  await write(terminal, Array.from({length: 150}, (_, i) => `wrapped-${i}: ${'word '.repeat(30)}\r\n`).join(''));
  await wait();
  let wrappedAnchor = 0;
  for (let i = 0; i < terminal.buffer.active.baseY; i++) {
    if (terminal.buffer.active.getLine(i).translateToString(true).startsWith('wrapped-50:')) wrappedAnchor = i;
  }
  terminal.scrollToLine(wrappedAnchor);
  await wait();
  const anchors = [];
  const registerMarker = terminal.registerMarker.bind(terminal);
  terminal.registerMarker = offset => {
    const marker = registerMarker(offset);
    anchors.push(marker);
    return marker;
  };
  host.style.width = '450px'; manager.fitAll();
  await wait();
  check('column reflow follows visible content', terminal.buffer.active.getLine(terminal.buffer.active.viewportY).translateToString(true).startsWith('wrapped-50:'), position(terminal));
  check('resize anchors are disposed', anchors.length > 0 && anchors.every(marker => marker.isDisposed));

  const lines = (count, label = 'redraw') => Array.from({ length: count }, (_, i) => `${label} ${i}\r\n`).join('');
  const seedHistory = async (label = 'redraw') => {
    terminal.reset();
    await write(terminal, lines(300, label));
    // reset() zeroes xterm's DOM row metrics until the first paint. A parser
    // callback alone does not mean the new history is visible/scrollable yet.
    await wait();
    terminal.scrollToLine(70);
    await wait();
    if (position(terminal).y !== 70) throw new Error('History fixture did not reach row 70 before the action under test');
  };
  // CLI full-frame redraws clear scrollback, then replay a transcript. Test the
  // actual ANSI parser (including PTY chunk boundaries), not a mocked write.
  for (const [name, chunks] of [
    ['ED3', ['\x1b[3J']],
    ['DECSED3', ['\x1b[?3J']],
    ['split ED3', ['\x1b', '[', '3', 'J']],
    ['C1 ED3', ['\x9b3J']],
    ['full frame redraw', ['\x1b[2J\x1b[3J\x1b[H']]
  ]) {
    await seedHistory();
    for (const chunk of chunks) manager._writeKeepingBottom(a, chunk);
    manager._writeKeepingBottom(a, lines(200));
    await write(terminal, '');
    await wait();
    check(`${name} resumes following output after clearing history`,
      terminal.buffer.active.baseY > 100 && position(terminal).y === position(terminal).base, position(terminal));
  }

  await seedHistory();
  await write(terminal, '\x1b[2J\x1b[H' + lines(100));
  await wait();
  check('ED2 retains history and reading position', position(terminal).y === 70, position(terminal));

  await seedHistory();
  await write(terminal, '\x1b[?1049h\x1b[3J' + lines(100) + '\x1b[?1049l' + lines(100));
  await wait();
  check('ED3 on alternate screen preserves normal history and scroll intent', position(terminal).y === 70, position(terminal));

  // Returning to history after the clear is still an explicit user choice.
  await write(terminal, '\x1b[3J' + lines(200));
  terminal.scrollToLine(50);
  manager._writeKeepingBottom(a, lines(50));
  await write(terminal, '');
  await wait();
  check('user can scroll away again after ED3', position(terminal).y === 50, position(terminal));

  await seedHistory();
  // The text of an escape command inside OSC must never trigger the fix.
  await write(terminal, '\x1b]0;literal [3J title\x07' + lines(50));
  await wait();
  check('title text does not act as a scrollback clear', position(terminal).y === 70, position(terminal));

  await seedHistory();
  manager.setActiveTerminal('b'); ui._renderTabView(state());
  await wait();
  manager._writeKeepingBottom(a, '\x1b[3J' + lines(200));
  await write(terminal, '');
  manager.setActiveTerminal('a'); ui._renderTabView(state());
  await wait();
  check('background ED3 follows output when remounted', position(terminal).y === position(terminal).base, position(terminal));

  await seedHistory();
  terminal.options.scrollback = 0;
  terminal.options.scrollback = 10000;
  await wait(); // Let the setup-only scrollback option change reach the DOM.
  if (terminal.buffer.active.baseY !== 0) throw new Error('Expected empty scrollback before ED3');
  await write(terminal, '\x1b[3J' + lines(200));
  await wait();
  check('ED3 with no remaining history still resets follow-output', position(terminal).y === position(terminal).base, position(terminal));

  terminal.reset();
  host.style.height = '600px'; manager.fitAll();
  await write(terminal, lines(300));
  host.style.height = '450px'; manager.fitAll();
  terminal.scrollToLine(70);
  await wait();
  await write(terminal, '\x1b[?1049h' + lines(100) + '\x1b[3J\x1b[?1049l' + lines(50));
  await wait();
  check('alternate ED3 after inactive-buffer resize preserves normal scroll intent', position(terminal).y === 70, position(terminal));

  terminal.options.scrollback = 400;
  await seedHistory('history text survives hidden panels');
  const hiddenAnchor = terminal.buffer.active.getLine(70).translateToString(true);
  const geometry = { cols: terminal.cols, rows: terminal.rows };
  host.style.display = 'none';
  manager.fitAll();
  check('hidden layout never resizes PTY', terminal.cols === geometry.cols && terminal.rows === geometry.rows,
    { expected: geometry, actual: { cols: terminal.cols, rows: terminal.rows } });
  host.style.display = '';
  manager.fitAll();
  await wait();
  check('hidden layout return preserves visible history',
    terminal.buffer.active.getLine(terminal.buffer.active.viewportY).translateToString(true) === hiddenAnchor,
    { ...position(terminal), expected: hiddenAnchor, actual: terminal.buffer.active.getLine(terminal.buffer.active.viewportY).translateToString(true) });

  for (const instance of manager.terminals.values()) instance.terminal.dispose();
  return results;
};
