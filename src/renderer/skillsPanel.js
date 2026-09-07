/** Optional tools, grouped inside the Skills side panel. */
const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { SKILLS } = require('../shared/skillsCatalog');
const { escapeHtml, escapeAttr } = require('./escapeHtml');
const { createPanelVisibility } = require('./panelVisibility');
const { registerPanel, togglePanel, hidePanel } = require('./panelCoordinator');
const { createToast } = require('./toast');
const { writeClipboardText } = require('./clipboardWrite');
const { withSpinner } = require('./spinnerButton');

let content = null;
let toast = null;
let skills = [];
let provider = 'claude';
let category = 'token-saver';
let loadVersion = 0;
const busy = new Set();
const errors = new Map();
const names = { claude: 'Claude Code', codex: 'Codex' };
const categories = { 'token-saver': 'Token Saver', ui: 'UI' };

function init() {
  const panel = document.getElementById('skills-panel');
  if (!panel) return;
  content = document.getElementById('skills-content');
  toast = createToast(panel);
  registerPanel('skills', createPanelVisibility(panel, { onShow: loadSkills }));
  document.getElementById('skills-close').addEventListener('click', () => hidePanel('skills'));
  const refreshButton = document.getElementById('skills-refresh');
  refreshButton.addEventListener('click', () => withSpinner(refreshButton, loadSkills));
  content.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.category) {
      category = button.dataset.category;
      render();
      content.querySelector(`[data-category="${category}"]`).focus({ preventScroll: true });
      return;
    }
    if (button.dataset.provider) {
      provider = button.dataset.provider;
      skills = [];
      await loadSkills();
      return;
    }
    const skill = skills.find(item => item.id === button.dataset.skill);
    if (skill) await runAction(skill, button.dataset.action);
  });
  content.addEventListener('keydown', event => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...content.querySelectorAll('[role="tab"]')];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].click();
  });
}

async function loadSkills() {
  const version = ++loadVersion;
  const selectedProvider = provider;
  if (!skills.length) content.innerHTML = '<p class="skills-note" role="status">Checking installed skills…</p>';
  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_SKILLS, selectedProvider);
    if (version !== loadVersion) return;
    skills = result;
    render();
  } catch (err) {
    if (version !== loadVersion) return;
    skills = SKILLS.map(skill => ({ ...skill, provider, installed: false, statusError: 'Could not read installed state. Refresh to retry.' }));
    render();
    console.error('Error loading skills:', err);
  }
}

function actionButton(skill, action, label, disabled = false) {
  return `<button class="plugin-install-btn" data-action="${escapeAttr(action)}" data-skill="${skill.id}" aria-label="${escapeAttr(label)} ${skill.name} for ${names[provider]}" ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
}

function renderSkill(skill) {
  const key = `${skill.provider}:${skill.id}`;
  const pending = busy.has(key);
  const state = pending ? 'Working…' : skill.statusError ? 'Status unavailable' : !skill.installed ? 'Not installed' : skill.enabled == null ? 'Installed' : skill.enabled ? 'Enabled' : 'Disabled';
  const stateClass = pending ? 'status-available' : skill.statusError ? 'skill-error' : skill.installed && skill.enabled !== false ? 'status-enabled' : 'status-available';
  let controls = actionButton(skill, 'install', pending ? 'Installing…' : 'Install', pending || !!skill.statusError);
  let help = '';
  if (skill.installed) {
    if (skill.id === 'rtk') {
      controls = actionButton(skill, 'setup', 'Set up', pending) + actionButton(skill, 'disable', 'Remove setup', pending);
      help = provider === 'codex' ? 'Set up adds RTK guidance to Codex. Commands run through RTK when the agent follows that guidance.' : 'Set up connects RTK to Claude Code. The terminal shows any setup questions.';
    } else if (skill.id === 'headroom') {
      controls = actionButton(skill, 'start', 'Start session', pending) + actionButton(skill, 'disable', 'Unwrap', pending);
      help = 'Starts a new agent session through a local proxy. Stop that session with Ctrl+C; Unwrap restores the tool configuration.';
    } else {
      controls = skill.toggleable
        ? `<button class="plugin-toggle-btn ${skill.enabled ? 'enabled' : ''}" data-action="toggle" data-skill="${skill.id}" role="switch" aria-checked="${skill.enabled}" aria-label="Enable ${skill.name} for Claude Code" ${pending ? 'disabled' : ''}><span class="toggle-track"><span class="toggle-thumb"></span></span></button>`
        : '';
      help = skill.id === 'impeccable' && provider === 'codex'
        ? 'Start a new thread and use $impeccable. Project hooks are optional and require separate setup and trust in Codex.'
        : skill.id === 'ponytail' && provider === 'codex'
        ? 'Manage in Codex with /plugins. Review Ponytail in /hooks, then start a new thread.'
        : 'Start a new session after installation. Lite / Full / Ultra / Off copy a mode command to send in your agent conversation.';
      if (skill.modes) {
        controls += `<div class="skill-modes" role="group" aria-label="Copy ${skill.name} mode command">${['lite', 'full', 'ultra', 'off'].map(mode => actionButton(skill, mode, mode[0].toUpperCase() + mode.slice(1), pending)).join('')}</div>`;
      } else {
        controls += actionButton(skill, 'use', 'Copy command', pending);
        if (skill.id !== 'impeccable' || provider !== 'codex') help = 'Start a new agent session, then paste the command with your task or reference.';
      }
    }
  }
  const error = errors.get(key) || skill.statusError;
  return `<article class="skill-entry" aria-labelledby="skill-${skill.id}">
    <div class="skill-heading">
      <img class="skill-logo" src="vendor/skills/${escapeAttr(skill.logo)}" width="40" height="40" alt="">
      <div class="skill-identity"><h5 id="skill-${skill.id}">${escapeHtml(skill.title)}</h5>
        <button class="skill-source" data-action="source" data-skill="${skill.id}">${skill.name}</button>
      </div>
      <span class="plugin-status ${stateClass}" role="status">${state}</span>
    </div>
    <p class="skills-description">${escapeHtml(skill.description)}</p>
    <div class="skill-controls">${controls}</div>
    ${help ? `<p class="skills-note">${help}</p>` : ''}
    ${error ? `<p class="skills-note skill-error" role="alert">${escapeHtml(error)}</p>` : ''}
  </article>`;
}

function render() {
  content.innerHTML = `<div class="skills-providers" role="group" aria-label="Install skills for">
    ${Object.entries(names).map(([id, name]) => `<button class="plugin-install-btn" data-provider="${id}" aria-pressed="${provider === id}">${name}</button>`).join('')}
  </div><div class="skills-tabs" role="tablist" aria-label="Skill categories">
    ${Object.entries(categories).map(([id, label]) => `<button class="btn" data-variant="ghost" id="skills-tab-${id}" role="tab" data-category="${id}" aria-selected="${category === id}" aria-controls="skills-list" tabindex="${category === id ? 0 : -1}">${label}</button>`).join('')}
  </div><section id="skills-list" role="tabpanel" aria-labelledby="skills-tab-${category}" tabindex="0">
    ${skills.filter(skill => skill.category === category).map(renderSkill).join('')}
    <p class="skills-note">Optional installs. Your tools and settings stay in your user profile across VibeConsole updates.</p>
  </section>`;
}

async function runAction(skill, action) {
  const key = `${skill.provider}:${skill.id}`;
  if (busy.has(key)) return;
  if (action === 'source') {
    ipcRenderer.send(IPC.OPEN_EXTERNAL_URL, `https://github.com/${skill.repo}`);
    return;
  }
  if (action === 'use' || (skill.modes && ['lite', 'full', 'ultra', 'off'].includes(action))) {
    const prefix = skill.provider === 'codex' ? '$' : '/';
    const copied = await writeClipboardText(`${prefix}${skill.id}${action === 'use' ? '' : ` ${action}`}`);
    toast.show(copied ? 'Command copied. Paste it into your agent conversation.' : 'Could not copy the command.', copied ? 'success' : 'error');
    return;
  }
  busy.add(key);
  errors.delete(key);
  render();
  try {
    if (['setup', 'start', 'disable'].includes(action)) {
      const command = await ipcRenderer.invoke(IPC.GET_SKILL_COMMAND, skill.provider, skill.id, action);
      if (!window.terminalRunInNewSession) throw new Error('Terminal is not ready');
      await window.terminalRunInNewSession(command);
      hidePanel('skills');
      window.terminalFocus?.();
    } else {
      const result = action === 'toggle'
        ? await ipcRenderer.invoke(IPC.TOGGLE_SKILL, skill.provider, skill.id, !skill.enabled)
        : await ipcRenderer.invoke(IPC.INSTALL_SKILL, skill.provider, skill.id);
      if (!result.success) throw new Error(result.error || 'Operation failed');
      toast.show(result.alreadyInstalled ? `${skill.name} is already installed.` : action === 'toggle'
        ? `${skill.name} updated. Restart ${names[skill.provider]} to apply.`
        : `${skill.name} installed. Setup options are now available.`, 'success');
    }
  } catch (err) {
    errors.set(key, err.message || 'Operation failed. Try again.');
  } finally {
    busy.delete(key);
    await loadSkills();
  }
}

module.exports = { init, toggle: () => togglePanel('skills') };
