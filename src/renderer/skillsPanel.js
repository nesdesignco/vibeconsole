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
let checkingAll = false;
const names = { claude: 'Claude Code', codex: 'Codex' };
const categories = { 'token-saver': 'Token Saver', ui: 'UI', brain: 'Brain', custom: 'My Skills' };

function init() {
  const panel = document.getElementById('skills-panel');
  if (!panel) return;
  content = document.getElementById('skills-content');
  toast = createToast(panel);
  registerPanel('skills', createPanelVisibility(panel, { onShow: loadSkills }));
  document.getElementById('skills-close').addEventListener('click', () => hidePanel('skills'));
  const refreshButton = document.getElementById('skills-refresh');
  refreshButton.addEventListener('click', () => withSpinner(refreshButton, async () => {
    if (await loadSkills()) toast.show('Installed skills refreshed.', 'success');
    else toast.show('Could not refresh skills. Retry.', 'error');
  }));
  content.addEventListener('submit', event => {
    if (!(event.target instanceof HTMLFormElement) || event.target.id !== 'skill-repository-form') return;
    event.preventDefault();
    const form = event.target;
    const input = form.querySelector('input');
    const button = form.querySelector('button');
    if (button.disabled) return;
    withSpinner(button, async () => {
      const error = form.querySelector('[role="alert"]');
      error.textContent = '';
      try {
        const result = await ipcRenderer.invoke(IPC.ADD_SKILL_REPOSITORY, input.value);
        if (!result.success) throw new Error(result.error);
        category = result.category;
        await loadSkills();
        content.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
        toast.show(result.alreadyAdded ? 'Repository is already in your list.' : 'Repository saved. Choose skills to install.', 'success');
      } catch (err) { error.textContent = err.message || 'Could not save repository. Please retry.'; }
    });
  });
  content.addEventListener('click', async event => {
    const button = event.target.closest('button, a[data-action="source"]');
    if (!button || button.disabled) return;
    if (button.matches('a')) event.preventDefault();
    if (button.dataset.action === 'check-all') {
      if (checkingAll) return;
      checkingAll = true;
      const selectedSkills = [...skills];
      render();
      try { for (const skill of selectedSkills) await runAction(skill, 'check-update'); }
      finally { checkingAll = false; render(); }
      return;
    }
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
    return true;
  } catch (err) {
    if (version !== loadVersion) return;
    skills = SKILLS.map(skill => ({ ...skill, provider, installed: false, statusError: 'Could not read installed state. Refresh to retry.' }));
    render();
    console.error('Error loading skills:', err);
    return false;
  }
}

function actionButton(skill, action, label, disabled = false) {
  return `<button class="skill-action" data-action="${escapeAttr(action)}" data-skill="${skill.id}" aria-label="${escapeAttr(label)} ${skill.name} for ${names[provider]}" ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
}

function renderSkill(skill) {
  const key = `${skill.provider}:${skill.id}`;
  const pending = busy.has(key);
  const state = pending ? 'Working…' : skill.statusError ? 'Status unavailable' : skill.kind === 'service' ? 'External setup'
    : skill.kind === 'repository' ? skill.installed ? `${skill.installedSkills.length} skills installed` : 'Not detected'
    : !skill.installed ? 'Not installed' : skill.kind === 'cli' && skill.setupUrl ? 'CLI installed' : skill.enabled == null ? 'Installed' : skill.enabled ? 'Enabled' : 'Disabled';
  const stateClass = pending ? 'status-available' : skill.statusError ? 'skill-error' : skill.installed && skill.enabled !== false ? 'status-enabled' : 'status-available';
  let controls = actionButton(skill, 'install', pending ? 'Installing…' : 'Install', pending || !!skill.statusError);
  let help = '';
  if (skill.kind === 'service') {
    controls = actionButton(skill, 'guide', 'Set up');
    help = skill.setupNote;
  } else if (skill.kind === 'repository') {
    controls = actionButton(skill, 'setup', 'Choose skills', pending);
    help = 'Opens the native installer for the selected agent. Review skills and existing files there, then refresh this panel. Detected installs come from the skills CLI.';
    if (skill.custom) controls += actionButton(skill, 'remove', 'Remove from list', pending);
  } else if (skill.installed) {
    if (skill.setupUrl) {
      controls = actionButton(skill, 'guide', 'Set up connection');
      help = skill.setupNote;
    } else if (skill.id === 'rtk') {
      controls = actionButton(skill, 'setup', `Configure ${names[provider]}`, pending) + actionButton(skill, 'disable', 'Remove integration', pending);
      help = provider === 'codex' ? 'RTK is installed. Configure adds or updates Codex guidance; it does not reinstall RTK.' : 'RTK is installed. Configure adds or updates the Claude Code integration; it does not reinstall RTK.';
    } else if (skill.id === 'headroom') {
      controls = actionButton(skill, 'start', 'Start session', pending) + actionButton(skill, 'disable', 'Unwrap', pending);
      help = 'Starts a new agent session through a local proxy. Stop that session with Ctrl+C; Unwrap restores the tool configuration.';
    } else {
      controls = skill.toggleable
        ? `<button class="skill-toggle ${skill.enabled ? 'enabled' : ''}" data-action="toggle" data-skill="${skill.id}" role="switch" aria-checked="${skill.enabled}" aria-label="Enable ${skill.name} for Claude Code" ${pending ? 'disabled' : ''}><span class="toggle-track"><span class="toggle-thumb"></span></span></button>`
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
  const update = skill.update || {};
  const updateLabel = update.recoveryNeeded ? 'Recovery needed' : update.available ? update.comparison === 'files' ? 'Source differs — review changes' : 'Update available' : update.checkedAt ? update.canApply === false && !skill.installed ? 'Release information' : update.latest && update.available == null ? 'Release information' : 'Up to date' : 'Updates';
  return `<article class="skill-entry" aria-labelledby="skill-${escapeAttr(skill.id)}">
    <div class="skill-heading">
      ${skill.logo ? `<img class="skill-logo" src="vendor/skills/${escapeAttr(skill.logo)}" width="40" height="40" alt="">`
        : '<svg class="skill-logo" width="40" height="40" aria-hidden="true"><use href="#icon-skills"/></svg>'}
      <div class="skill-identity"><h5 id="skill-${escapeAttr(skill.id)}"><a class="skill-source" href="https://github.com/${escapeAttr(skill.repo)}" data-action="source" data-skill="${escapeAttr(skill.id)}" title="${escapeAttr(skill.repo)}">${escapeHtml(skill.name)}</a></h5>
      </div>
      <span class="skill-status ${stateClass}" role="status">${state}</span>
    </div>
    <p class="skill-subtitle">${escapeHtml(skill.title)}</p>
    <p class="skills-description">${escapeHtml(skill.description)}</p>
    <div class="skill-controls">${controls}</div>
    ${help ? `<p class="skills-note">${help}</p>` : ''}
    <details class="skill-update" ${update.checkedAt || update.canRollback || error ? 'open' : ''}>
      <summary>${escapeHtml(updateLabel)}</summary>
      ${update.latest ? `<p class="skills-note">${update.current ? `${escapeHtml(update.current)} → ` : ''}${escapeHtml(update.latest)}</p>` : ''}
      ${update.note ? `<p class="skills-note">${escapeHtml(update.note)}</p>` : ''}
      ${update.lastAction === 'applied' ? '<p class="skills-note">Update completed. Previous files are available in the backup.</p>' : update.lastAction === 'rolled-back' ? '<p class="skills-note">Previous files restored.</p>' : ''}
      ${update.changesUrl ? `<button class="skill-update-link skill-source" data-action="release-notes" data-skill="${escapeAttr(skill.id)}">Release / source changes</button>` : ''}
      ${update.changes || update.diff ? `<details><summary>Review file changes</summary><pre class="skill-update-diff" tabindex="0">${escapeHtml(update.changes || '')}\n${escapeHtml(update.diff || '')}</pre></details>` : ''}
      <div class="skill-controls">
        ${actionButton(skill, 'check-update', pending ? 'Checking…' : 'Check updates', pending || checkingAll)}
        ${update.canApply ? actionButton(skill, 'apply-update', 'Back up & update', pending || checkingAll) : ''}
        ${update.diff ? actionButton(skill, 'open-review', 'Open full review', pending) : ''}
        ${update.canRollback ? actionButton(skill, 'rollback-update', 'Roll back', pending || checkingAll || update.recoveryNeeded) + actionButton(skill, 'open-backup', 'Open backup', pending) : ''}
      </div>
      ${update.error ? `<p class="skills-note skill-error" role="alert">${escapeHtml(update.error)}</p>` : ''}
    </details>
    ${error ? `<p class="skills-note skill-error" role="alert">${escapeHtml(error)}</p>` : ''}
  </article>`;
}

function render() {
  content.innerHTML = `<div class="skills-providers" role="group" aria-label="Install skills for">
    ${Object.entries(names).map(([id, name]) => `<button class="skill-action" data-provider="${id}" aria-pressed="${provider === id}">${name}</button>`).join('')}
  </div><div class="skills-tabs" role="tablist" aria-label="Skill categories">
    ${Object.entries(categories).map(([id, label]) => `<button class="btn" data-variant="ghost" id="skills-tab-${id}" role="tab" data-category="${id}" aria-selected="${category === id}" aria-controls="skills-list" tabindex="${category === id ? 0 : -1}">${label}</button>`).join('')}
  </div><div class="skills-update-toolbar"><button class="skill-action" data-action="check-all" ${checkingAll ? 'disabled aria-busy="true"' : ''}>${checkingAll ? 'Checking all tools…' : 'Check all updates'}</button></div><section id="skills-list" role="tabpanel" aria-labelledby="skills-tab-${category}" tabindex="0">
    ${category === 'custom' ? `<form id="skill-repository-form" class="skill-repository-form">
      <label for="skill-repository-url">GitHub repository</label>
      <input id="skill-repository-url" name="repository" type="text" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="300" required placeholder="https://github.com/owner/repository" aria-describedby="skill-repository-help skill-repository-error">
      <button class="skill-action" type="submit">Add repository</button>
      <p id="skill-repository-help" class="skills-note">Add a skill repository, then choose what to install. Saved repositories stay here across app updates.</p>
      <p id="skill-repository-error" class="skills-note skill-error" role="alert"></p>
    </form>` : ''}
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
  if (action === 'guide') {
    if (skill.setupUrl) ipcRenderer.send(IPC.OPEN_EXTERNAL_URL, skill.setupUrl);
    return;
  }
  if (action === 'release-notes') {
    if (skill.update?.changesUrl) ipcRenderer.send(IPC.OPEN_EXTERNAL_URL, skill.update.changesUrl);
    return;
  }
  if (action === 'use' || (skill.modes && ['lite', 'full', 'ultra', 'off'].includes(action))) {
    const prefix = skill.provider === 'codex' ? '$' : '/';
    const copied = await writeClipboardText(`${prefix}${skill.commandName || skill.id}${action === 'use' ? '' : ` ${action}`}`);
    toast.show(copied ? 'Command copied. Paste it into your agent conversation.' : 'Could not copy the command.', copied ? 'success' : 'error');
    return;
  }
  busy.add(key);
  errors.delete(key);
  render();
  try {
    if (['check-update', 'apply-update', 'rollback-update', 'open-backup', 'open-review'].includes(action)) {
      const channel = { 'check-update': IPC.CHECK_SKILL_UPDATE, 'apply-update': IPC.APPLY_SKILL_UPDATE,
        'rollback-update': IPC.ROLLBACK_SKILL_UPDATE, 'open-backup': IPC.OPEN_SKILL_BACKUP, 'open-review': IPC.OPEN_SKILL_BACKUP }[action];
      const result = await ipcRenderer.invoke(channel, skill.provider, skill.id,
        channel === IPC.OPEN_SKILL_BACKUP ? action === 'open-review' : skill.update?.token);
      if (!result.success) throw new Error(result.error);
      if (action === 'apply-update' || action === 'rollback-update') toast.show(action === 'apply-update' ? 'Updated. Restart your agent to use the new version.' : 'Previous files restored. Restart your agent.', 'success');
    } else if (action === 'remove') {
      const result = await ipcRenderer.invoke(IPC.REMOVE_SKILL_REPOSITORY, skill.id);
      if (!result.success) throw new Error(result.error);
      toast.show('Removed from list. Installed skills are kept.', 'success');
    } else if (['setup', 'start', 'disable'].includes(action)) {
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
