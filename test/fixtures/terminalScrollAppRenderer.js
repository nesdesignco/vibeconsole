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
  terminal.scrollToLine(70);
  await wait();
  await output('\\033[2J\\033[3J\\033[H');
  check('real PTY redraw resumes following output', position().base > 200 && position().y === position().base);

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

  for (let i = 0; i < 4; i++) {
    document.querySelector('.btn-sidebar-toggle').click();
    await wait(450);
  }
  check('sidebar toggles preserve visible history', topText() === anchor);

  for (let i = 0; i < 4; i++) {
    document.querySelector('.btn-skills-toggle').click();
    await wait(450);
  }
  check('skills panel transitions preserve visible history', topText() === anchor);

  for (let i = 0; i < 10; i++) {
    manager.setActiveTerminal(otherId);
    await wait(30);
    manager.setActiveTerminal(id);
    await wait(30);
  }
  await wait();
  check('actual debounced tab rendering preserves visible history', topText() === anchor);

  manager.setGridLayout('1x2');
  manager.setViewMode('grid');
  await wait();
  await output('\\033[3J');
  check('real PTY redraw in grid follows output', position().y === position().base);
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

  manager.setActiveTerminal(otherId);
  await wait();
  await output('\\033[3J');
  manager.setActiveTerminal(id);
  await wait();
  check('real background PTY redraw follows output on return', position().y === position().base);
  return results;
};
