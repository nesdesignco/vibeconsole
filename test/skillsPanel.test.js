const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadModule, createElements } = require('./helpers/loadModule');
const { SKILLS } = require('../src/shared/skillsCatalog');

test('Skills uses shared refresh artwork and shows accurate installation states with local logos', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.equal((html.match(/id="icon-refresh"/g) || []).length, 1);
  assert.equal((html.match(/<use href="#icon-refresh"/g) || []).length, 3);
  for (const skill of SKILLS) {
    assert.ok(fs.statSync(path.join(__dirname, '../vendor/skills', skill.logo)).size > 0);
  }

  const element = createElements();
  const listeners = new Map();
  const document = { getElementById: id => {
    const el = element(id);
    el.addEventListener = (event, fn) => listeners.set(`${id}:${event}`, fn);
    return el;
  } };
  let resolveLoad;
  const panel = loadModule('src/renderer/skillsPanel.js', {
    './escapeHtml': { escapeHtml: String, escapeAttr: String },
    './electronBridge': { ipcRenderer: { invoke: () => new Promise(resolve => { resolveLoad = resolve; }) } },
    './panelCoordinator': { registerPanel() {}, togglePanel() {}, hidePanel() {} },
    './toast': { createToast: () => ({ show() {} }) },
    './clipboardWrite': { writeClipboardText() {} }
  }, { document });
  panel.init();
  const refresh = element('skills-refresh');
  const attributes = new Map();
  refresh.getAttribute = key => attributes.get(key) || null;
  refresh.setAttribute = (key, value) => attributes.set(key, value);
  refresh.removeAttribute = key => attributes.delete(key);
  const pending = listeners.get('skills-refresh:click')();
  assert.equal(refresh.disabled, true);
  resolveLoad(SKILLS.map((skill, i) => ({ ...skill, provider: 'claude',
    installed: i !== 0, installedSkills: ['example'], enabled: [null, null, true, false][i], statusError: '' })));
  await pending;
  assert.equal(refresh.disabled, false);
  const rows = element('skills-content').innerHTML.match(/<article[\s\S]*?<\/article>/g);
  assert.match(rows[0], /status-available" role="status">Not installed/);
  assert.match(rows[1], /status-enabled" role="status">Installed/);
  assert.match(rows[2], /status-enabled" role="status">Enabled/);
  assert.match(rows[3], /status-available" role="status">Disabled/);

  await listeners.get('skills-content:click')({ target: { closest: () => ({ matches: () => false, dataset: { category: 'ui' } }) } });
  const ui = element('skills-content').innerHTML;
  assert.match(ui, /aria-labelledby="skills-tab-ui"/);
  assert.match(ui, /id="skill-design-dna"/);
  assert.doesNotMatch(ui, /id="skill-rtk"/);
  assert.doesNotMatch(ui, /data-action="lite"/);
  assert.equal((ui.match(/data-action="use"/g) || []).length, 4);
  await listeners.get('skills-content:click')({ target: { closest: () => ({ matches: () => false, dataset: { category: 'token-saver' } }) } });

  const retry = listeners.get('skills-refresh:click')();
  resolveLoad([{ ...SKILLS[0], provider: 'claude', installed: true, statusError: 'Unreadable state' }]);
  await retry;
  assert.match(element('skills-content').innerHTML, /skill-error" role="status">Status unavailable/);
});
