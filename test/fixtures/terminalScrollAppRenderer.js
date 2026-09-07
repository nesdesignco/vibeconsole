const { getMultiTerminalUI } = require('../../src/renderer/terminal');
const wait = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));

window.runAppScrollTests = async () => {
  for (let i = 0; i < 100 && !getMultiTerminalUI()?.initialized; i++) await wait(50);
  const ui = getMultiTerminalUI();
  const manager = ui.getManager();
  const id = await ui.createTerminalForCurrentProject({ shell: '/bin/sh' });
  const instance = manager.getTerminal(id);
  const terminal = instance.terminal;
  const otherId = [...manager.terminals.keys()].find(key => key !== id);
  await wait(500);
  const results = [];
  const position = () => ({ y: terminal.buffer.active.viewportY, base: terminal.buffer.active.baseY });
  const check = (name, pass, details = position()) => results.push({ name, pass, details });
  const checkScrollbar = name => {
    const viewport = terminal.element.querySelector('.xterm-viewport');
    const rowHeight = terminal.element.querySelector('.xterm-screen').getBoundingClientRect().height / terminal.rows;
    const expected = terminal.buffer.active.viewportY * rowHeight;
    check(name, Math.abs(viewport.scrollTop - expected) <= 1, { ...position(), top: viewport.scrollTop, expected });
  };
  const topText = () => terminal.buffer.active.getLine(terminal.buffer.active.viewportY).translateToString(true);
  let serial = 0;
  const output = async (clear = '', count = 350) => {
    const marker = `APP_DONE_${++serial}`;
    // Shell builtin output traverses node-pty -> coalescing -> preload -> xterm.
    ui.sendCommand(`printf '${clear}'; i=0; while [ "$i" -lt ${count} ]; do printf 'app-line %s\\n' "$i"; i=$((i+1)); done; printf 'APP_DONE_'; printf '${serial}\\n'`, id);
    for (let attempt = 0; attempt < 100; attempt++) {
      await wait(50);
      const buffer = terminal.buffer.active;
      if (Array.from({ length: buffer.length }, (_, line) => buffer.getLine(line)?.translateToString(true)).includes(marker)) {
        await wait();
        return;
      }
    }
    throw new Error(`PTY output did not finish: ${marker}`);
  };

  await output();
  manager.setActiveTerminal(otherId);
  await wait();
  manager.setActiveTerminal(id);
  await wait();
  checkScrollbar('actual tab return restores native scrollbar at bottom');
  terminal.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
  await wait();
  check('downward wheel after actual tab return stays at bottom', position().y === position().base);
  checkScrollbar('downward wheel keeps actual native scrollbar synchronized');
  const viewport = terminal.element.querySelector('.xterm-viewport');
  const rowHeight = terminal.element.querySelector('.xterm-screen').getBoundingClientRect().height / terminal.rows;
  viewport.scrollTop = Math.floor(position().base / 2) * rowHeight;
  await wait();
  check('moving actual native scrollbar moves terminal history', position().y > 0 && position().y < position().base);
  checkScrollbar('native scrollbar movement agrees with terminal buffer');
  terminal.scrollToLine(70);
  await wait();
  await output('\\033[2J\\033[3J\\033[H');
  check('real PTY redraw resumes following output', position().base > 200 && position().y === position().base);
  checkScrollbar('real PTY redraw updates the native scrollbar');

  terminal.scrollToLine(70);
  await wait();
  const anchor = topText();
  const outer = document.getElementById('terminal-container');
  const geometry = { cols: terminal.cols, rows: terminal.rows };
  outer.style.display = 'none';
  await wait(500); // Exercise the application's real trailing ResizeObserver.
  check('app observer skips hidden terminal geometry', terminal.cols === geometry.cols && terminal.rows === geometry.rows,
    { expected: geometry, actual: { cols: terminal.cols, rows: terminal.rows } });
  outer.style.display = '';
  await wait(500);
  check('app observer preserves history on reveal', topText() === anchor);
  checkScrollbar('app observer restores native scrollbar on reveal');

  for (let i = 0; i < 4; i++) {
    document.querySelector('.btn-sidebar-toggle').click();
    await wait(450);
  }
  check('sidebar toggles preserve visible history', topText() === anchor);
  checkScrollbar('sidebar toggles keep native scrollbar synchronized');

  for (let i = 0; i < 4; i++) {
    document.querySelector('.btn-skills-toggle').click();
    await wait(450);
  }
  check('skills panel transitions preserve visible history', topText() === anchor);
  checkScrollbar('skills panel transitions keep native scrollbar synchronized');

  const settingsButton = document.querySelector('.btn-settings');
  check('settings uses the library icon at the right edge of the toolbar', !!settingsButton.querySelector('svg') && settingsButton === settingsButton.parentElement.lastElementChild);
  settingsButton.click();
  await wait(450);
  const panel = document.getElementById('appearance-panel');
  check('open settings is accessible and reports its expanded state', !panel.inert && settingsButton.getAttribute('aria-expanded') === 'true');
  const adapter = require('../../src/renderer/monacoEditor');
  const monaco = require('monaco-editor/esm/vs/editor/editor.api.js');
  const editorHost = document.createElement('div');
  editorHost.style.cssText = 'position:fixed;left:10px;bottom:10px;width:300px;height:100px';
  document.body.appendChild(editorHost);
  adapter.init(editorHost);
  adapter.setDocument({ content: 'original', filePath: '/appearance-check.txt' });
  const model = monaco.editor.getModels().find(item => item.uri.path === '/appearance-check.txt');
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'unsaved edit' }], () => []);
  const choose = async selector => {
    document.querySelector(selector).click();
    for (let i = 0; i < 100 && document.querySelector('#appearance-panel fieldset').disabled; i++) await wait(20);
    await wait(450);
  };
  const changeMode = async mode => {
    const control = panel.querySelector('#appearance-mode');
    control.value = mode;
    control.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && panel.querySelector('fieldset').disabled; i++) await wait(20);
  };
  for (let i = 0; i < 10; i++) {
    const mode = i % 2 ? 'dark' : 'light';
    await changeMode(mode);
    check(`mode switch ${i + 1} keeps selected and rendered appearance synchronized`, window.vibeAppearance.mode === mode && panel.querySelector('#appearance-mode').value === mode);
  }
  await changeMode('system');
  await choose('[data-theme="ivory"]');
  check('choosing a palette from System mode applies it immediately', window.vibeAppearance.mode === 'light' && panel.querySelector('#appearance-mode').value === 'light');
  for (const theme of require('../../src/shared/appearance').THEMES) {
    await choose(`[data-theme="${theme.id}"]`);
    check(`${theme.id} updates the UI, terminal and editor without losing session state`,
      [...manager.terminals.values()].every(item => item.terminal.options.theme.background === theme.colors['terminal-bg']) &&
      getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor === `rgb(${theme.colors['bg-primary'].slice(1).match(/../g).map(hex => parseInt(hex, 16)).join(', ')})` &&
      window.vibeAppearance.mode === theme.mode && panel.querySelectorAll('[data-theme][aria-pressed="true"]').length === 1 && manager.getTerminal(id).terminal === terminal &&
      topText() === anchor && adapter.getValue() === 'unsaved edit' && !model.isDisposed());
  }
  for (const style of ['classic', 'flat', 'soft']) {
    await choose(`[data-style="${style}"]`);
    check(`${style} style preserves terminal history`, document.documentElement.dataset.themeStyle === style && topText() === anchor);
    checkScrollbar(`${style} style keeps the native scrollbar synchronized`);
    const card = panel.querySelector('.appearance-preset');
    const rect = card.getBoundingClientRect();
    check(`${style} keeps palette cards square and applies corner styles`, Math.abs(rect.width - rect.height) < 1 && (style !== 'flat' || getComputedStyle(card).borderRadius === '0px'));
  }
  adapter.undo();
  check('theme changes preserve editor undo history', adapter.getValue() === 'original');
  adapter.dispose(); editorHost.remove();
  const confirm = window.confirm;
  try {
    window.confirm = () => false;
    await choose('[data-reset]');
    check('canceling reset preserves appearance', window.vibeAppearance.mode === 'light' && document.documentElement.dataset.themeStyle === 'soft');
    window.confirm = () => true;
    await choose('[data-reset]');
    check('confirmed reset restores Dark Violet Classic', window.vibeAppearance.mode === 'dark' && document.documentElement.dataset.themeStyle === 'classic' && panel.querySelector('[data-theme="violet"]').getAttribute('aria-pressed') === 'true');
  } finally { window.confirm = confirm; }
  document.querySelector('#appearance-panel [data-close]').click();
  await wait(450);
  check('closing settings returns keyboard focus, hides its controls and preserves history', document.activeElement.matches('.btn-settings') && topText() === anchor && panel.inert && document.querySelector('.btn-settings').getAttribute('aria-expanded') === 'false');

  for (let i = 0; i < 10; i++) {
    manager.setActiveTerminal(otherId);
    await wait(30);
    manager.setActiveTerminal(id);
    await wait(30);
  }
  await wait();
  check('actual debounced tab rendering preserves visible history', topText() === anchor);
  checkScrollbar('actual debounced tab rendering restores history scrollbar');

  manager.setGridLayout('1x2');
  manager.setViewMode('grid');
  await wait();
  await output('\\033[3J');
  check('real PTY redraw in grid follows output', position().y === position().base);
  checkScrollbar('real PTY redraw in grid updates native scrollbar');
  terminal.scrollToLine(60);
  await wait();
  const gridAnchor = topText();
  for (let i = 0; i < 5; i++) {
    manager.renameTerminal(id, `Scroll test ${i}`);
    await wait(50);
  }
  manager.setViewMode('tabs');
  await wait();
  check('grid metadata and tab return preserve visible history', topText() === gridAnchor);
  checkScrollbar('grid metadata and tab return restore native scrollbar');

  manager.setActiveTerminal(otherId);
  await wait();
  await output('\\033[3J');
  manager.setActiveTerminal(id);
  await wait();
  check('real background PTY redraw follows output on return', position().y === position().base);
  checkScrollbar('real background PTY redraw restores native scrollbar on return');
  return results;
};
