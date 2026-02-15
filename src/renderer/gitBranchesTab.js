/**
 * Git Branches Tab Module
 * Handles branches list rendering, branch switching, creation, and deletion
 *
 * Security: All user-provided data (branch names, messages) is sanitized
 * through escapeHtml() and escapeAttr() before DOM interpolation.
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { escapeHtml, escapeAttr } = require('./escapeHtml');

// Module state
let branchesData = { currentBranch: '', branches: [] };
let _branchesGeneration = 0;
let _hasBranchesData = false;

// Callbacks and refs (set by init)
let _showToast = () => {};
let _renderLoading = () => {};
let _getContentElement = () => null;

function init({ showToast, renderLoading, getContentElement }) {
  _showToast = showToast;
  _renderLoading = renderLoading;
  _getContentElement = getContentElement;
  setupModalListeners();
}

function resetData() {
  _hasBranchesData = false;
}

/**
 * Load git branches
 */
async function loadBranches() {
  const state = require('./state');
  const projectPath = state.getProjectPath();

  if (!projectPath) {
    renderBranchesError('No project selected');
    return;
  }

  const gen = ++_branchesGeneration;

  if (!_hasBranchesData) {
    _renderLoading('Loading branches...');
  }

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_GIT_BRANCHES, projectPath);

    if (gen !== _branchesGeneration) return;

    if (result.error) {
      renderBranchesError(result.error);
    } else {
      branchesData = result;
      _hasBranchesData = true;
      renderBranches();
    }
  } catch (err) {
    if (gen !== _branchesGeneration) return;
    console.error('Error loading branches:', err);
    renderBranchesError('Failed to load branches');
  }
}

/**
 * Render branches list using escaped values for safe DOM manipulation.
 */
function renderBranches() {
  const contentElement = _getContentElement();
  if (!contentElement) return;

  const { currentBranch, branches } = branchesData;

  if (!branches || branches.length === 0) {
    contentElement.textContent = '';
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'github-empty';
    const iconDiv = document.createElement('div');
    iconDiv.className = 'github-empty-icon';
    iconDiv.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
    const p = document.createElement('p');
    p.textContent = 'No branches found';
    const span = document.createElement('span');
    span.textContent = 'Not a git repository?';
    emptyDiv.appendChild(iconDiv);
    emptyDiv.appendChild(p);
    emptyDiv.appendChild(span);
    contentElement.appendChild(emptyDiv);
    return;
  }

  // Separate local and remote branches
  const localBranches = branches.filter(b => !b.isRemote);
  const remoteBranches = branches.filter(b => b.isRemote);

  // Build HTML with escaped values (all user data goes through escapeHtml/escapeAttr)
  const parts = [];
  parts.push('<div class="git-branches-section">');
  parts.push('<h4 class="git-branches-section-title">Local Branches</h4>');
  localBranches.forEach(branch => parts.push(renderBranchItem(branch, currentBranch)));
  parts.push('</div>');

  if (remoteBranches.length > 0) {
    parts.push('<div class="git-branches-section">');
    parts.push('<h4 class="git-branches-section-title">Remote Branches</h4>');
    remoteBranches.forEach(branch => parts.push(renderBranchItem(branch, currentBranch)));
    parts.push('</div>');
  }

  // Safe: all user data (branch names) escaped via escapeHtml/escapeAttr
  contentElement.innerHTML = parts.join('');

  attachBranchEventListeners(contentElement);
}

/**
 * Render single branch item (returns escaped HTML string)
 */
function renderBranchItem(branch, currentBranch) {
  const isCurrent = branch.name === currentBranch;
  const canDelete = !isCurrent && !branch.isRemote;

  return `
    <div class="git-branch-item ${isCurrent ? 'current' : ''}" data-branch="${escapeAttr(branch.name)}">
      <div class="git-branch-indicator">
        ${isCurrent ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>' : ''}
      </div>
      <div class="git-branch-content">
        <div class="git-branch-name">${escapeHtml(branch.name)}</div>
        <div class="git-branch-meta">
          <span class="git-branch-commit">${escapeHtml(branch.commit || '')}</span>
          <span class="git-branch-date">${escapeHtml(branch.date || '')}</span>
        </div>
      </div>
      <div class="git-branch-actions">
        ${canDelete ? `<button class="git-branch-action-btn delete" title="Delete branch"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ''}
      </div>
    </div>
  `;
}

/**
 * Attach branch event listeners
 */
function attachBranchEventListeners(contentElement) {
  contentElement.querySelectorAll('.git-branch-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      const target = e.target;
      if (target && typeof target.closest === 'function' && target.closest('button')) return;
      if (item.classList.contains('current')) return;
      const branchName = item.dataset.branch;
      if (!branchName) return;
      await handleSwitchBranch(branchName);
    });
  });

  // Delete buttons
  contentElement.querySelectorAll('.git-branch-action-btn.delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const branchName = btn.closest('.git-branch-item').dataset.branch;
      await handleDeleteBranch(branchName);
    });
  });
}

/**
 * Handle branch switch
 */
async function handleSwitchBranch(branchName, { allowAutoStash = true } = {}) {
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.SWITCH_GIT_BRANCH, { projectPath, branchName });

    if (result.error) {
      const raw = (typeof result.message === 'string' && result.message.trim())
        ? result.message.trim()
        : (typeof result.error === 'string' && result.error.trim())
          ? result.error.trim()
          : '';
      const compact = raw.replace(/\s+/g, ' ').trim();

      const shouldOfferStash = allowAutoStash && (
        result.error === 'uncommitted_changes' ||
        /commit(\s+or\s+stash|\s+your\s+changes\s+or\s+stash\s+them)|stash\s+them\s+before\s+you\s+switch|would\s+be\s+overwritten\s+by\s+checkout|untracked\s+working\s+tree\s+files\s+would\s+be\s+overwritten/i.test(raw)
      );

      if (shouldOfferStash) {
        const ok = confirm(
          `Local changes are blocking the branch switch.\n\nStash changes (including untracked files) and switch to "${branchName}"?`
        );
        if (ok) {
          const stashResult = await ipcRenderer.invoke(IPC.STASH_CHANGES, {
            projectPath,
            message: `Auto-stash before switching to ${branchName}`,
            includeUntracked: true
          });

          if (stashResult?.error) {
            _showToast(String(stashResult.error), 'error');
            return;
          }

          await handleSwitchBranch(branchName, { allowAutoStash: false });
          return;
        }
      }

      const message = compact && compact.length > 260 ? (compact.slice(0, 257) + '...') : (compact || 'Operation failed');
      _showToast(message, 'error');
      return;
    }

    _showToast(`Switched to ${result.branch}`, 'success');
    await loadBranches();
  } catch {
    _showToast('Failed to switch branch', 'error');
  }
}

/**
 * Handle branch deletion
 */
async function handleDeleteBranch(branchName) {
  if (!confirm(`Delete branch "${branchName}"?`)) return;

  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.DELETE_GIT_BRANCH, { projectPath, branchName, force: false });

    if (result.error) {
      const forceDelete = confirm(`Branch "${branchName}" is not fully merged.\n\nForce delete?`);
      if (forceDelete) {
        const forceResult = await ipcRenderer.invoke(IPC.DELETE_GIT_BRANCH, { projectPath, branchName, force: true });
        if (forceResult.error) {
          _showToast('Operation failed', 'error');
          return;
        }
      } else {
        return;
      }
    }

    _showToast(`Deleted ${branchName}`, 'success');
    await loadBranches();
  } catch {
    _showToast('Failed to delete branch', 'error');
  }
}

/**
 * Render branches error using safe DOM APIs
 */
function renderBranchesError(message) {
  const contentElement = _getContentElement();
  if (!contentElement) return;

  contentElement.textContent = '';
  const errDiv = document.createElement('div');
  errDiv.className = 'github-error';
  const iconDiv = document.createElement('div');
  iconDiv.className = 'github-error-icon';
  iconDiv.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  const p = document.createElement('p');
  p.textContent = message;
  errDiv.appendChild(iconDiv);
  errDiv.appendChild(p);
  contentElement.appendChild(errDiv);
}

// ==================== CREATE BRANCH MODAL ====================

function setupModalListeners() {
  const modal = document.getElementById('create-branch-modal');
  const input = document.getElementById('new-branch-name');
  const closeBtn = document.getElementById('create-branch-modal-close');
  const cancelBtn = document.getElementById('create-branch-cancel');
  const confirmBtn = document.getElementById('create-branch-confirm');
  const createBranchBtn = document.getElementById('github-create-branch-btn');

  if (createBranchBtn) {
    createBranchBtn.addEventListener('click', () => showCreateBranchModal());
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => hideCreateBranchModal());
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => hideCreateBranchModal());
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => handleCreateBranch());
  }

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleCreateBranch();
      } else if (e.key === 'Escape') {
        hideCreateBranchModal();
      }
    });
  }

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        hideCreateBranchModal();
      }
    });
  }
}

function showCreateBranchModal() {
  const modal = document.getElementById('create-branch-modal');
  const input = document.getElementById('new-branch-name');
  const select = document.getElementById('base-branch-select');
  const checkbox = document.getElementById('switch-to-branch');

  if (modal) {
    modal.classList.add('visible');

    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 100);
    }
    if (checkbox) {
      checkbox.checked = true;
    }

    populateBaseBranchSelect(select);
  }
}

/**
 * Populate base branch select dropdown using safe DOM APIs
 */
async function populateBaseBranchSelect(select) {
  if (!select) return;

  select.textContent = '';
  const loadingOpt = document.createElement('option');
  loadingOpt.value = '';
  loadingOpt.textContent = 'Loading...';
  select.appendChild(loadingOpt);

  const state = require('./state');
  const projectPath = state.getProjectPath();

  if (!projectPath) {
    select.textContent = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No project selected';
    select.appendChild(opt);
    return;
  }

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_GIT_BRANCHES, projectPath);

    if (result.error || !result.branches) {
      select.textContent = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Failed to load branches';
      select.appendChild(opt);
      return;
    }

    const localBranches = result.branches.filter(b => !b.isRemote);
    const currentBranch = result.currentBranch;

    select.textContent = '';
    localBranches.forEach(branch => {
      const opt = document.createElement('option');
      opt.value = branch.name;
      opt.textContent = branch.name === currentBranch
        ? `${branch.name} (current)`
        : branch.name;
      if (branch.name === currentBranch) opt.selected = true;
      select.appendChild(opt);
    });

  } catch (err) {
    console.error('Failed to load branches for select:', err);
    select.textContent = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Failed to load branches';
    select.appendChild(opt);
  }
}

function hideCreateBranchModal() {
  const modal = document.getElementById('create-branch-modal');
  if (modal) {
    modal.classList.remove('visible');
  }
}

async function handleCreateBranch() {
  const input = document.getElementById('new-branch-name');
  const select = document.getElementById('base-branch-select');
  const checkbox = document.getElementById('switch-to-branch');

  const branchName = input?.value?.trim();
  const baseBranch = select?.value;
  const shouldCheckout = checkbox?.checked ?? true;

  if (!branchName) {
    _showToast('Please enter a branch name', 'error');
    return;
  }

  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.CREATE_GIT_BRANCH, {
      projectPath,
      branchName,
      baseBranch,
      checkout: shouldCheckout
    });

    if (result.error) {
      _showToast('Operation failed', 'error');
      return;
    }

    hideCreateBranchModal();
    const message = shouldCheckout
      ? `Created and switched to ${branchName}`
      : `Created ${branchName}`;
    _showToast(message, 'success');
    await loadBranches();
  } catch {
    _showToast('Failed to create branch', 'error');
  }
}

module.exports = {
  init,
  loadBranches,
  resetData
};
