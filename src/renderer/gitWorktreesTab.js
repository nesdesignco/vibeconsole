/**
 * Git Worktrees Tab Module
 * Handles worktrees list rendering, addition, and removal
 *
 * Security: All user-provided data is sanitized through escapeHtml()
 * and escapeAttr() before any DOM interpolation.
 */

const { ipcRenderer, pathApi } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');

// Module state
let worktreesData = { worktrees: [] };
let _worktreesGeneration = 0;
let _hasWorktreesData = false;

// Callbacks and refs (set by init)
let _showToast = () => {};
let _renderLoading = () => {};
let _getContentElement = () => null;

function init({ showToast, renderLoading, getContentElement }) {
  _showToast = showToast;
  _renderLoading = renderLoading;
  _getContentElement = getContentElement;
}

function resetData() {
  _hasWorktreesData = false;
}

/**
 * Load git worktrees
 */
async function loadWorktrees() {
  const state = require('./state');
  const projectPath = state.getProjectPath();

  if (!projectPath) {
    renderWorktreesError('No project selected');
    return;
  }

  const gen = ++_worktreesGeneration;

  if (!_hasWorktreesData) {
    _renderLoading('Loading worktrees...');
  }

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_GIT_WORKTREES, projectPath);

    if (gen !== _worktreesGeneration) return;

    if (result.error) {
      renderWorktreesError(result.error);
    } else {
      worktreesData = result;
      _hasWorktreesData = true;
      renderWorktrees();
    }
  } catch (err) {
    if (gen !== _worktreesGeneration) return;
    console.error('Error loading worktrees:', err);
    renderWorktreesError('Failed to load worktrees');
  }
}

// Static SVG constants (no user data)
const FOLDER_SVG_48 = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const FOLDER_SVG_16 = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const CLOSE_SVG_12 = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/**
 * Render worktrees list using safe DOM construction
 */
function renderWorktrees() {
  const contentElement = _getContentElement();
  if (!contentElement) return;

  const { worktrees } = worktreesData;

  if (!worktrees || worktrees.length === 0) {
    contentElement.textContent = '';
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'github-empty';
    const iconDiv = document.createElement('div');
    iconDiv.className = 'github-empty-icon';
    iconDiv.innerHTML = FOLDER_SVG_48; // static SVG, no user data
    const p = document.createElement('p');
    p.textContent = 'No worktrees';
    const span = document.createElement('span');
    span.textContent = 'Add a worktree to work on multiple branches';
    emptyDiv.appendChild(iconDiv);
    emptyDiv.appendChild(p);
    emptyDiv.appendChild(span);
    contentElement.appendChild(emptyDiv);
    return;
  }

  contentElement.textContent = '';
  const listDiv = document.createElement('div');
  listDiv.className = 'git-worktrees-list';

  worktrees.forEach(wt => {
    const item = buildWorktreeElement(wt);
    listDiv.appendChild(item);
  });

  contentElement.appendChild(listDiv);
  attachWorktreeEventListeners(contentElement);
}

/**
 * Build a single worktree DOM element using safe APIs
 */
function buildWorktreeElement(worktree) {
  const canRemove = !worktree.isMain;
  const pathName = pathApi.basename(worktree.path) || worktree.path;

  const item = document.createElement('div');
  item.className = `git-worktree-item ${worktree.isMain ? 'main' : ''}`;
  item.dataset.path = worktree.path;

  const iconDiv = document.createElement('div');
  iconDiv.className = 'git-worktree-icon';
  iconDiv.innerHTML = FOLDER_SVG_16; // static SVG, no user data

  const contentDiv = document.createElement('div');
  contentDiv.className = 'git-worktree-content';

  const nameDiv = document.createElement('div');
  nameDiv.className = 'git-worktree-name';
  nameDiv.textContent = pathName;

  const metaDiv = document.createElement('div');
  metaDiv.className = 'git-worktree-meta';
  const branchSpan = document.createElement('span');
  branchSpan.className = 'git-worktree-branch';
  branchSpan.textContent = worktree.branch || 'detached';
  metaDiv.appendChild(branchSpan);
  if (worktree.isMain) {
    const badge = document.createElement('span');
    badge.className = 'git-worktree-badge';
    badge.textContent = 'main';
    metaDiv.appendChild(badge);
  }

  const pathDiv = document.createElement('div');
  pathDiv.className = 'git-worktree-path';
  pathDiv.textContent = worktree.path;

  contentDiv.appendChild(nameDiv);
  contentDiv.appendChild(metaDiv);
  contentDiv.appendChild(pathDiv);

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'git-worktree-actions';
  if (canRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'git-worktree-action-btn remove';
    removeBtn.title = 'Remove worktree';
    removeBtn.innerHTML = CLOSE_SVG_12; // static SVG, no user data
    actionsDiv.appendChild(removeBtn);
  }

  item.appendChild(iconDiv);
  item.appendChild(contentDiv);
  item.appendChild(actionsDiv);

  return item;
}

/**
 * Attach worktree event listeners
 */
function attachWorktreeEventListeners(contentElement) {
  contentElement.querySelectorAll('.git-worktree-action-btn.remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const wtPath = btn.closest('.git-worktree-item').dataset.path;
      await handleRemoveWorktree(wtPath);
    });
  });
}

/**
 * Handle worktree removal
 */
async function handleRemoveWorktree(wtPath) {
  if (!confirm(`Remove worktree at "${wtPath}"?`)) return;

  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.REMOVE_GIT_WORKTREE, { projectPath, worktreePath: wtPath, force: false });

    if (result.error) {
      const forceRemove = confirm(`Worktree has local changes.\n\nForce remove?`);
      if (forceRemove) {
        await ipcRenderer.invoke(IPC.REMOVE_GIT_WORKTREE, { projectPath, worktreePath: wtPath, force: true });
      } else {
        return;
      }
    }

    _showToast('Worktree removed', 'success');
    await loadWorktrees();
  } catch {
    _showToast('Failed to remove worktree', 'error');
  }
}

/**
 * Render worktrees error using safe DOM APIs
 */
function renderWorktreesError(message) {
  const contentElement = _getContentElement();
  if (!contentElement) return;

  contentElement.textContent = '';
  const errDiv = document.createElement('div');
  errDiv.className = 'github-error';
  const iconDiv = document.createElement('div');
  iconDiv.className = 'github-error-icon';
  iconDiv.innerHTML = FOLDER_SVG_48; // static SVG, no user data
  const p = document.createElement('p');
  p.textContent = message;
  errDiv.appendChild(iconDiv);
  errDiv.appendChild(p);
  contentElement.appendChild(errDiv);
}

module.exports = {
  init,
  loadWorktrees,
  resetData
};
