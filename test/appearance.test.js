const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('./helpers/loadModule');
const { THEMES, STYLES, defaults, normalize, variables, terminalTheme, contrast } = require('../src/shared/appearance');

test('appearance values survive restart and changed preset defaults without being reset', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-appearance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const create = () => loadModule('src/main/appearance.js', { electron: { app: { getPath: () => directory } } });
  const settings = defaults();
  settings.mode = 'system';
  settings.dark.colors['accent-primary'] = '#123456';
  settings.light.colors['bg-primary'] = '#fffefa';
  settings.style = { ...STYLES[2], radius: 12 };
  create().save(settings);
  assert.deepEqual(JSON.parse(JSON.stringify(create().load().settings)), settings);
  const original = THEMES[0].colors['accent-primary'];
  try {
    THEMES[0].colors['accent-primary'] = '#abcdef';
    assert.equal(create().load().settings.dark.colors['accent-primary'], '#123456');
  } finally { THEMES[0].colors['accent-primary'] = original; }
  assert.equal(create().load().settings.style.radius, 12);
  const file = path.join(directory, 'appearance.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => create().save(defaults()), /preserved/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('new fields receive defaults; invalid colors and future schemas cannot overwrite preferences', () => {
  const settings = defaults();
  delete settings.light.colors['folder-icon'];
  assert.equal(normalize(settings).light.colors['folder-icon'], defaults().light.colors['folder-icon']);
  settings.dark.colors['accent-primary'] = 'url(https://invalid.test)';
  assert.throws(() => normalize(settings), /HEX/);
  assert.throws(() => normalize({ ...defaults(), version: 2 }), /preserved/);
  assert.throws(() => normalize({ ...defaults(), dark: { colors: [] } }), /palette/);
});

test('failed replacement preserves preferences, removes temporary files and permits retry', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-appearance-save-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const electron = { app: { getPath: () => directory } };
  const storage = loadModule('src/main/appearance.js', { electron });
  storage.save(defaults());
  const file = path.join(directory, 'appearance.json');
  const original = fs.readFileSync(file, 'utf8');
  const failed = loadModule('src/main/appearance.js', { electron, fs: { ...fs, renameSync() { throw new Error('disk failure'); } } });
  assert.throws(() => failed.save({ ...defaults(), mode: 'light' }), /disk failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory), ['appearance.json']);
  storage.save({ ...defaults(), mode: 'light' });
  assert.equal(storage.load().settings.mode, 'light');
  fs.renameSync(file, file + '.original');
  fs.symlinkSync(file + '.original', file);
  assert.throws(() => storage.save(defaults()), /preserved/);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
});

test('system mode uses the saved light and dark palettes and supplies every terminal color', () => {
  const settings = defaults();
  settings.mode = 'system';
  settings.light.colors['accent-primary'] = '#123456';
  settings.dark.colors['accent-primary'] = '#abcdef';
  for (const systemDark of [false, true]) {
    const resolved = variables(settings, systemDark);
    const palette = settings[systemDark ? 'dark' : 'light'].colors;
    assert.equal(resolved.values['accent-primary'], palette['accent-primary']);
    const terminal = terminalTheme(resolved.values);
    assert.equal(terminal.cursor, palette['accent-primary']);
    assert.equal(terminal.background, palette['terminal-bg']);
    assert.equal(Object.keys(terminal).length, 21);
    assert.equal(Object.values(resolved.values).some(value => String(value).includes('undefined')), false);
  }
});

test('four light and four dark presets resolve across three styles without sharing mutable user settings', () => {
  for (const mode of ['light', 'dark']) assert.equal(THEMES.filter(theme => theme.mode === mode).length, 4);
  for (const theme of THEMES) for (const style of STYLES) {
    const settings = defaults();
    settings[theme.mode] = structuredClone(theme); settings.mode = theme.mode; settings.style = { ...style };
    const resolved = variables(normalize(settings));
    assert.equal(resolved.mode, theme.mode);
    assert.equal(resolved.values['radius-sm'], `${style.radius}px`);
    for (const foreground of ['text-primary', 'text-secondary', 'text-tertiary', 'text-muted']) {
      for (const background of ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-elevated', 'bg-hover']) {
        assert.ok(contrast(theme.colors[foreground], theme.colors[background]) >= 4.5, `${theme.id}: ${foreground} on ${background}`);
      }
    }
    settings[theme.mode].colors['bg-primary'] = '#123456';
    assert.notEqual(theme.colors['bg-primary'], '#123456');
  }
});
