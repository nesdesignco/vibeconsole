const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { THEMES, STYLES, COLOR_LABELS, HEX, defaults, normalize, variables, contrast } = require('../shared/appearance');
const { escapeHtml, escapeAttr } = require('./escapeHtml');
const { createPanelVisibility } = require('./panelVisibility');
const { registerPanel, togglePanel, hidePanel } = require('./panelCoordinator');

const media = window.matchMedia('(prefers-color-scheme: dark)');
let settings = window.vibe?.appearance?.settings ? normalize(window.vibe.appearance.settings) : defaults();
let error = window.vibe?.appearance?.error || '';
let editing = variables(settings, media.matches).mode;
let saving = false;
let panel;

function apply() {
  const resolved = variables(settings, media.matches);
  for (const [key, value] of Object.entries(resolved.values)) document.documentElement.style.setProperty(`--${key}`, value);
  document.documentElement.style.colorScheme = resolved.mode;
  document.documentElement.dataset.theme = resolved.mode;
  document.documentElement.dataset.themeStyle = settings.style.id;
  window.vibeAppearance = resolved;
  window.dispatchEvent(new CustomEvent('vibe:appearance-changed', { detail: resolved }));
}
apply();
media.addEventListener('change', () => { if (settings.mode === 'system') { apply(); render(); } });

function paletteButtons(mode) {
  return THEMES.filter(theme => theme.mode === mode).map(theme => {
    const c = theme.colors;
    return `<button type="button" class="appearance-preset" data-theme="${theme.id}" aria-pressed="${settings[mode].id === theme.id && window.vibeAppearance.mode === mode}" style="--preview-bg:${c['bg-primary']};--preview-panel:${c['bg-secondary']};--preview-text:${c['text-primary']};--preview-accent:${c['accent-primary']}">
      <span class="appearance-swatch" aria-hidden="true"><span></span><i></i><i></i><i></i></span><span>${theme.name}</span>
    </button>`;
  }).join('');
}
function colorControl(key, label) {
  const value = settings[editing].colors[key];
  return `<label class="appearance-color"><span>${escapeHtml(label)}</span><input type="color" data-color="${key}" value="${value}" aria-label="${escapeAttr(label)} color"><input type="text" data-hex="${key}" value="${value}" pattern="#[0-9a-fA-F]{6}" maxlength="7" spellcheck="false" aria-label="${escapeAttr(label)} HEX"></label>`;
}
function render() {
  if (!panel) return;
  const c = settings[editing].colors;
  const lowContrast = contrast(c['text-primary'], c['bg-primary']) < 4.5 || contrast(c['terminal-fg'], c['terminal-bg']) < 4.5;
  const expanded = [...panel.querySelectorAll('details[open]')].map(element => element.id);
  panel.querySelector('.appearance-content').innerHTML = `
    <fieldset ${saving ? 'disabled' : ''}>
      <legend class="appearance-title">Appearance</legend>
      <label class="appearance-row">Mode<span class="appearance-select"><select id="appearance-mode">${[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([id, name]) => `<option value="${id}" ${settings.mode === id ? 'selected' : ''}>${name}</option>`).join('')}</select></span></label>
      <h4>Light themes</h4><div class="appearance-presets">${paletteButtons('light')}</div>
      <h4>Dark themes</h4><div class="appearance-presets">${paletteButtons('dark')}</div>
      <h4>Style</h4><div class="appearance-styles">${STYLES.map(style => `<button type="button" class="btn" data-style="${style.id}" aria-pressed="${settings.style.id === style.id}">${style.name}</button>`).join('')}</div>
      <p class="appearance-note">${escapeHtml(settings.style.description)}</p>
      <h4>Personal colors</h4><label class="appearance-row">Edit palette<span class="appearance-select"><select id="appearance-edit"><option value="light" ${editing === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${editing === 'dark' ? 'selected' : ''}>Dark</option></select></span></label>
      ${['accent-primary', 'folder-icon'].map(key => colorControl(key, COLOR_LABELS[key])).join('')}
      <details id="appearance-colors"><summary>All interface colors</summary>${Object.entries(COLOR_LABELS).filter(([key]) => !['accent-primary', 'folder-icon'].includes(key)).map(([key, label]) => colorControl(key, label)).join('')}</details>
      <details id="appearance-ansi"><summary>Terminal palette</summary>${Object.keys(settings[editing].colors).filter(key => key.startsWith('ansi-')).map(key => colorControl(key, key.slice(5).replace('bright', 'Bright '))).join('')}</details>
      <button type="button" class="btn appearance-reset" data-reset>Reset appearance</button>
    </fieldset>
    <p class="appearance-note" role="status">${escapeHtml(error || (saving ? 'Saving…' : lowContrast ? 'Saved. Text contrast is low; choose more distinct foreground and background colors.' : 'Saved on this Mac. Kept across app updates.'))}</p>`;
  for (const id of expanded) panel.querySelector(`#${id}`)?.setAttribute('open', '');
}
async function save() {
  const active = document.activeElement;
  const focusAttribute = ['id', 'data-theme', 'data-style', 'data-color', 'data-hex', 'data-reset'].find(key => active?.hasAttribute(key));
  const focusSelector = panel.contains(active) && focusAttribute ? `[${focusAttribute}="${CSS.escape(active.getAttribute(focusAttribute))}"]` : null;
  saving = true;
  render();
  try {
    const result = await ipcRenderer.invoke(IPC.SAVE_APPEARANCE, settings);
    if (!result.success) throw new Error(result.error);
    settings = normalize(result.settings);
    error = '';
  } catch (err) { error = `Not saved: ${err.message}`; }
  finally {
    saving = false; apply(); render();
    if (focusSelector && document.activeElement === document.body) panel.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
}
function init() {
  panel = document.createElement('aside');
  panel.id = 'appearance-panel';
  panel.inert = true;
  panel.setAttribute('aria-label', 'Settings');
  panel.innerHTML = `<div class="panel-header"><h3 class="panel-title">Settings</h3><button type="button" class="btn btn-close" aria-label="Close settings" data-close>✕</button></div><div class="appearance-content"></div>`;
  document.body.appendChild(panel);
  const visibilityChanged = visible => {
    panel.inert = !visible;
    document.querySelector('.btn-settings')?.setAttribute('aria-expanded', String(visible));
  };
  registerPanel('appearance', createPanelVisibility(panel, {
    onShow: () => visibilityChanged(true), onHide: () => visibilityChanged(false)
  }));
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || saving) return;
    if (button.hasAttribute('data-close')) { close(); return; }
    if (button.dataset.theme) {
      const theme = THEMES.find(item => item.id === button.dataset.theme);
      settings[theme.mode] = JSON.parse(JSON.stringify(theme));
      editing = theme.mode;
      settings.mode = theme.mode === 'light' ? 'light' : 'dark';
    } else if (button.dataset.style) {
      settings.style = { ...STYLES.find(item => item.id === button.dataset.style) };
    } else if (button.hasAttribute('data-reset')) {
      if (!window.confirm('Reset all appearance settings to the defaults?')) return;
      settings = defaults(); editing = 'dark';
    } else return;
    apply(); await save();
  });
  panel.addEventListener('input', event => {
    const target = /** @type {HTMLInputElement} */ (event.target);
    const key = target.dataset.color || target.dataset.hex;
    if (key && HEX.test(target.value)) {
      settings[editing].colors[key] = target.value.toLowerCase();
      settings[editing].id = 'custom';
      apply();
      const sibling = target.closest('label').querySelector(target.dataset.color ? '[data-hex]' : '[data-color]');
      sibling.value = target.value;
    }
  });
  panel.addEventListener('change', async event => {
    if (saving) return;
    const target = /** @type {HTMLInputElement} */ (event.target);
    if (target.id === 'appearance-edit') { editing = target.value; render(); return; }
    if (target.id === 'appearance-mode') {
      settings.mode = /** @type {'dark'|'light'|'system'} */ (target.value);
      editing = variables(settings, media.matches).mode;
    } else if (!target.dataset.color && !target.dataset.hex) return;
    else if (!HEX.test(target.value)) { target.reportValidity(); return; }
    apply(); await save();
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  ipcRenderer.on(IPC.APPEARANCE_CHANGED, (_event, value) => {
    if (saving) return;
    settings = normalize(value); error = ''; apply(); render();
  });
  render();
}
function close() {
  hidePanel('appearance');
  const button = document.querySelector('.btn-settings');
  if (button instanceof HTMLElement) button.focus();
}
function toggle() { if (togglePanel('appearance')) panel.querySelector('#appearance-mode').focus(); }
module.exports = { init, toggle };
