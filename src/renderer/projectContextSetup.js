/**
 * VibeConsole project-context initialization and audit workflow.
 * Prepares an English prompt in a ready Claude/Codex terminal without submitting it.
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { buildProjectContextPrompt } = require('../shared/projectContextPrompt');
const state = require('./state');
const terminal = require('./terminal');
const aiToolSelector = require('./aiToolSelector');
const { createToast } = require('./toast');

const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 200;

let actionButton = null;
let currentStatus = null;
let statusRequestId = 0;
let refreshTimer = null;
let toast = null;

function getActionLabel(status) {
  return status?.mode === 'audit' ? 'Audit Context' : 'Initialize Context';
}

function updateButton(status) {
  currentStatus = status;
  if (!actionButton) return;

  const isBusy = actionButton.dataset.busy === '1';
  if (!isBusy) {
    actionButton.textContent = getActionLabel(status);
  }
  actionButton.title = status?.mode === 'audit'
    ? 'Audit VibeConsole project context with the selected AI tool'
    : 'Initialize VibeConsole project context with the selected AI tool';
  actionButton.disabled = isBusy || !state.getProjectPath() || status?.success === false;
}

async function refreshStatus() {
  const projectPath = state.getProjectPath();
  const requestId = ++statusRequestId;

  if (!projectPath) {
    updateButton(null);
    return null;
  }

  try {
    const status = await ipcRenderer.invoke(IPC.GET_PROJECT_CONTEXT_STATUS, projectPath);
    if (requestId !== statusRequestId || projectPath !== state.getProjectPath()) return null;
    updateButton(status);
    return status;
  } catch (error) {
    console.error('Failed to inspect VibeConsole project context:', error);
    if (requestId === statusRequestId) {
      updateButton({ success: false, mode: 'initialize' });
    }
    return null;
  }
}

function scheduleStatusRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshStatus();
  }, 100);
}

function findReadyTerminal(projectPath, aiToolId) {
  const manager = terminal.getTerminal();
  if (!manager) return null;

  const active = manager.getActiveTerminalState();
  if (active?.projectPath === projectPath
      && active.aiTool === aiToolId
      && active.aiToolProcessDetected === true) {
    return active;
  }

  return manager.getTerminalsByProject(projectPath).find((candidate) => (
    candidate.aiTool === aiToolId && candidate.aiToolProcessDetected === true
  )) || null;
}

function waitForReadyTerminal(terminalId, projectPath, aiToolId) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      if (state.getProjectPath() !== projectPath) {
        reject(new Error('The active project changed before the AI tool was ready'));
        return;
      }

      const manager = terminal.getTerminal();
      const instance = manager?.getTerminal(terminalId);
      const terminalState = instance?.state;
      if (terminalState?.missingAiTool === aiToolId) {
        reject(new Error('AI command not found. Use the installation instructions shown in the terminal.'));
        return;
      }
      if (terminalState?.aiTool === aiToolId && terminalState.aiToolProcessDetected === true) {
        resolve(terminalState);
        return;
      }

      if ((Date.now() - startedAt) >= READY_TIMEOUT_MS) {
        reject(new Error('The AI tool started, but readiness could not be confirmed'));
        return;
      }

      setTimeout(poll, READY_POLL_MS);
    };

    poll();
  });
}

async function startAiTerminal(projectPath, aiTool) {
  const terminalId = await terminal.restartTerminal(projectPath, { aiTool: aiTool.id });
  if (!terminalId) throw new Error('Terminal could not be created');

  terminal.setActiveTerminal(terminalId);
  setTimeout(() => terminal.sendCommand(aiTool.command, terminalId), 150);
  await waitForReadyTerminal(terminalId, projectPath, aiTool.id);
  return terminalId;
}

async function prepareContextPrompt() {
  if (!actionButton || actionButton.dataset.busy === '1') return;

  const projectPath = state.getProjectPath();
  const aiTool = aiToolSelector.getCurrentTool();
  if (!projectPath || !aiTool) return;

  actionButton.dataset.busy = '1';
  actionButton.disabled = true;
  actionButton.textContent = 'Preparing…';

  try {
    const status = await refreshStatus();
    if (!status?.success) throw new Error(status?.error || 'Could not inspect the project context');

    let target = findReadyTerminal(projectPath, aiTool.id);
    let terminalId = target?.id || null;
    if (!terminalId) {
      actionButton.textContent = `Starting ${aiTool.name}…`;
      terminalId = await startAiTerminal(projectPath, aiTool);
      target = { id: terminalId };
    }

    terminal.setActiveTerminal(target.id);
    const prompt = buildProjectContextPrompt(status);
    if (!terminal.pasteText(prompt, target.id)) {
      throw new Error('The project-context prompt could not be prepared');
    }

    window.terminalFocus?.();
    toast?.show('Context prompt ready. Review it, then press Enter to begin.', 'success');
  } catch (error) {
    console.error('Project Context workflow failed:', error);
    toast?.show(error?.message || 'Project Context workflow failed', 'error');
  } finally {
    actionButton.dataset.busy = '0';
    actionButton.textContent = getActionLabel(currentStatus);
    actionButton.disabled = !state.getProjectPath() || currentStatus?.success === false;
  }
}

function init() {
  actionButton = document.getElementById('btn-project-context');
  if (!actionButton) {
    console.error('Project Context button not found');
    return;
  }

  toast = createToast(document.getElementById('terminal-container'), { displayTime: 3500 });
  actionButton.addEventListener('click', prepareContextPrompt);
  state.onProjectChange(() => refreshStatus());
  ipcRenderer.on(IPC.FILE_TREE_DATA, scheduleStatusRefresh);
  refreshStatus();
}

module.exports = {
  init,
  getActionLabel,
  refreshStatus
};
