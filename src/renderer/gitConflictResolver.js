/**
 * Git Conflict Resolver Module
 * Handles conflict modal display and resolution
 */

const { ipcRenderer, pathApi } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');

let _activeConflictState = null;

// Callbacks (set by init)
let _showToast = () => {};
let _loadChanges = () => {};

function init({ showToast, loadChanges }) {
  _showToast = showToast;
  _loadChanges = loadChanges;
  setupConflictModalListeners();
}

function setupConflictModalListeners() {
  const modal = document.getElementById('git-conflict-modal');
  if (!modal) return;

  const closeBtn = modal.querySelector('.conflict-modal-close-btn');
  const useBaseBtn = modal.querySelector('.conflict-use-base-btn');
  const useOursBtn = modal.querySelector('.conflict-use-ours-btn');
  const useTheirsBtn = modal.querySelector('.conflict-use-theirs-btn');
  const resolveBtn = modal.querySelector('.conflict-mark-resolved-btn');
  const cancelBtn = modal.querySelector('.conflict-cancel-btn');
  const resolvedInput = modal.querySelector('.conflict-resolved-input');

  if (closeBtn) closeBtn.addEventListener('click', hideConflictModal);
  if (cancelBtn) cancelBtn.addEventListener('click', hideConflictModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideConflictModal();
    });
  }

  if (useBaseBtn) {
    useBaseBtn.addEventListener('click', () => {
      if (!_activeConflictState || !resolvedInput) return;
      resolvedInput.value = _activeConflictState.base || '';
    });
  }
  if (useOursBtn) {
    useOursBtn.addEventListener('click', () => {
      if (!_activeConflictState || !resolvedInput) return;
      resolvedInput.value = _activeConflictState.ours || '';
    });
  }
  if (useTheirsBtn) {
    useTheirsBtn.addEventListener('click', () => {
      if (!_activeConflictState || !resolvedInput) return;
      resolvedInput.value = _activeConflictState.theirs || '';
    });
  }

  if (resolveBtn) {
    resolveBtn.addEventListener('click', async () => {
      if (!_activeConflictState || !resolvedInput) return;
      const state = require('./state');
      const projectPath = state.getProjectPath();
      if (!projectPath) return;

      resolveBtn.disabled = true;
      try {
        const result = await ipcRenderer.invoke(IPC.RESOLVE_GIT_CONFLICT, {
          projectPath,
          filePath: _activeConflictState.filePath,
          resolvedContent: resolvedInput.value
        });
        if (result.error) {
          _showToast(result.error, 'error');
          return;
        }
        hideConflictModal();
        _showToast('Conflict resolved and staged', 'success');
        await _loadChanges(true);
      } catch {
        _showToast('Failed to resolve conflict', 'error');
      } finally {
        resolveBtn.disabled = false;
      }
    });
  }
}

async function showConflictModal(filePath) {
  const modal = document.getElementById('git-conflict-modal');
  if (!modal) return;

  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) return;

  const filenameEl = modal.querySelector('.conflict-modal-filename');
  const pathEl = modal.querySelector('.conflict-modal-path');
  const baseInput = modal.querySelector('.conflict-base-input');
  const oursInput = modal.querySelector('.conflict-ours-input');
  const theirsInput = modal.querySelector('.conflict-theirs-input');
  const resolvedInput = modal.querySelector('.conflict-resolved-input');

  if (filenameEl) filenameEl.textContent = pathApi.basename(filePath);
  if (pathEl) pathEl.textContent = filePath;
  if (baseInput) baseInput.value = '';
  if (oursInput) oursInput.value = '';
  if (theirsInput) theirsInput.value = '';
  if (resolvedInput) resolvedInput.value = '';
  _activeConflictState = null;
  modal.classList.add('visible');

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_GIT_CONFLICT, { projectPath, filePath });
    if (result.error) {
      hideConflictModal();
      _showToast(result.error, 'error');
      return;
    }

    _activeConflictState = result;
    if (baseInput) baseInput.value = result.base || '';
    if (oursInput) oursInput.value = result.ours || '';
    if (theirsInput) theirsInput.value = result.theirs || '';
    if (resolvedInput) resolvedInput.value = result.current || result.ours || result.theirs || '';
  } catch {
    hideConflictModal();
    _showToast('Failed to load conflict details', 'error');
  }
}

function hideConflictModal() {
  const modal = document.getElementById('git-conflict-modal');
  if (modal) modal.classList.remove('visible');
  _activeConflictState = null;
}

module.exports = {
  init,
  showConflictModal,
  hideConflictModal
};
