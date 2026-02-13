/**
 * GitHub Panel Module
 * UI for displaying GitHub issues, branches, and worktrees
 */

const { ipcRenderer, pathApi } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { createPanelHeaderDropdown } = require('./panelHeaderDropdown');

let isVisible = false;
let gitAutoRefreshInterval = null;
let branchesData = { currentBranch: '', branches: [] };
let worktreesData = { worktrees: [] };
let changesData = {
  conflicts: [],
  staged: [],
  unstaged: [],
  untracked: [],
  totalCount: 0,
  unpushedCommits: [],
  outgoingCommits: [],
  incomingCommits: [],
  localCommits: [],
  commitGraphByHash: {},
  activity: [],
  activityTotal: 0,
  hasUpstream: false,
  trackingBranch: null
};
let currentTab = 'changes'; // changes, branches, worktrees
let operationInProgress = false;
let _commitMessage = '';
let _commitDescription = '';
let _descriptionVisible = false;
let _commitReplaceAllArmed = false;
let _collapsedSections = new Set();
let _syncData = { ahead: 0, behind: 0, branch: null, hasUpstream: false };
let _diffViewMode = 'split';
let _currentDiffState = null;
let _diffSearchQuery = '';
let _diffHideContext = false;
let _selectedHunkIndex = -1;
let _hunkActionInProgress = false;
let _fetchInProgress = false;
let _pullInProgress = false;
let _lastAutoFetchAt = 0;
let _activeConflictState = null;
let _activityPending = false;

const AUTO_FETCH_INTERVAL_MS = 30000;

// Load deduplication: generation counters discard stale IPC responses,
// _hasData flags prevent showing the loading spinner on subsequent refreshes.
let _changesGeneration = 0;
let _branchesGeneration = 0;
let _worktreesGeneration = 0;
let _hasChangesData = false;
let _hasBranchesData = false;
let _hasWorktreesData = false;

// Anti-flicker & anti-loop: data hash prevents unnecessary re-renders,
// cooldown suppresses watcher events after a load, promise coalescing
// prevents concurrent git status calls (VS Code-style throttle pattern).
let _lastChangesHash = null;
let _watcherCooldownUntil = 0;
let _loadChangesPromise = null;

// DOM Elements
let panelElement = null;
let contentElement = null;
let branchesActionsElement = null;
let activitySlotElement = null;
let branchBarElement = null;
let tabDropdownControl = null;

const HEATMAP_DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const HEATMAP_CELL_SIZE = 10;
const HEATMAP_GAP = 3;
const HEATMAP_LABEL_WIDTH = 24;
const HEATMAP_MIN_MONTH_GAP = 28;
const GIT_CHANGES_COUNT_EVENT = 'vibe:git-changes-count';
const AUTO_STAGE_STORAGE_KEY = 'vibe.git.autoStageBeforeCommit';
let _autoStageBeforeCommit = true;

/**
 * Initialize GitHub panel
 */
function init() {
  panelElement = document.getElementById('github-panel');
  contentElement = document.getElementById('github-content');
  branchesActionsElement = document.getElementById('github-branches-actions');
  activitySlotElement = document.getElementById('sc-activity-slot');
  branchBarElement = document.getElementById('sc-branch-bar');

  if (!panelElement) {
    console.error('GitHub panel element not found');
    return;
  }

  setupEventListeners();
  setupIPCListeners();
  setupModalListeners();
  setupDiffModalListeners();
  setupConflictModalListeners();
  loadAutoStagePreference();
  setupCommitArea();
  setupGitWatcher();

  // Reset changesData when project changes
  const state = require('./state');
  state.onProjectChange(() => {
    changesData = {
      conflicts: [],
      staged: [],
      unstaged: [],
      untracked: [],
      totalCount: 0,
      unpushedCommits: [],
      outgoingCommits: [],
      incomingCommits: [],
      localCommits: [],
      commitGraphByHash: {},
      activity: [],
      activityTotal: 0,
      hasUpstream: false,
      trackingBranch: null
    };
    _hasChangesData = false;
    _hasBranchesData = false;
    _hasWorktreesData = false;
    _lastChangesHash = null;
    _activityPending = false;
    clearCommitInputs();
    clearActivitySlot();
    publishGitChangesCount(0);
    setupGitWatcher();
    if (isVisible) setTab(currentTab);
  });
}

/**
 * Setup .git directory watcher for auto-refresh when panel is visible
 */
function setupGitWatcher() {
  if (gitAutoRefreshInterval) {
    clearInterval(gitAutoRefreshInterval);
    gitAutoRefreshInterval = null;
  }

  // Periodic refresh to avoid direct fs.watch dependency in renderer.
  gitAutoRefreshInterval = setInterval(() => {
    if (!isVisible || operationInProgress) return;
    if (Date.now() < _watcherCooldownUntil) return;

    if (currentTab === 'changes') {
      const now = Date.now();
      const shouldAutoFetch = _syncData.hasUpstream && (now - _lastAutoFetchAt) >= AUTO_FETCH_INTERVAL_MS;
      if (shouldAutoFetch && !_fetchInProgress) {
        _lastAutoFetchAt = now;
        handleFetch({ silent: true, auto: true });
      } else {
        loadChanges();
        updateSyncStatus();
      }
    } else if (currentTab === 'branches') {
      loadBranches();
    }
  }, 5000);
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Close button
  const closeBtn = document.getElementById('github-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', hide);
  }

  // Collapse button
  const collapseBtn = document.getElementById('github-collapse-btn');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', hide);
  }

  // Refresh button
  const refreshBtn = document.getElementById('github-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshIssues);
  }

  // Header dropdown tab selector
  const tabDropdown = document.getElementById('github-tab-dropdown');
  if (tabDropdown) {
    tabDropdownControl = createPanelHeaderDropdown(tabDropdown, {
      onChange: (tab) => setTab(tab, { syncDropdown: false })
    });
  }

}

/**
 * Setup IPC listeners
 */
function setupIPCListeners() {
  ipcRenderer.on(IPC.TOGGLE_GITHUB_PANEL, () => {
    toggle();
  });
}

/**
 * Refresh current tab
 */
async function refreshIssues() {
  const refreshBtn = document.getElementById('github-refresh-btn');

  try {
    if (refreshBtn) {
      refreshBtn.classList.add('spinning');
      refreshBtn.disabled = true;
    }

    if (currentTab === 'changes') {
      await loadChanges(true);
      showToast('Changes refreshed', 'success');
    } else if (currentTab === 'branches') {
      await loadBranches();
      showToast('Branches refreshed', 'success');
    } else if (currentTab === 'worktrees') {
      await loadWorktrees();
      showToast('Worktrees refreshed', 'success');
    }
  } finally {
    if (refreshBtn) {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  }
}

/**
 * Show GitHub panel
 */
function show() {
  if (panelElement) {
    panelElement.classList.add('visible');
    isVisible = true;
    setTab('changes');
    updateSyncStatus();
    handleFetch({ silent: true, auto: true });
  }
}

/**
 * Hide GitHub panel
 */
function hide() {
  if (panelElement) {
    panelElement.classList.remove('visible');
    isVisible = false;
  }
}

/**
 * Toggle GitHub panel visibility
 */
function toggle() {
  if (isVisible) {
    hide();
  } else {
    show();
  }
}

/**
 * Set active tab
 */
function setTab(tab, options = {}) {
  const { syncDropdown = true } = options;
  currentTab = tab;
  _lastChangesHash = null;

  if (syncDropdown && tabDropdownControl) {
    tabDropdownControl.setValue(tab);
  }

  // Show/hide branches actions for branches tab
  if (branchesActionsElement) {
    branchesActionsElement.style.display = tab === 'branches' ? 'flex' : 'none';
  }

  // Show/hide activity, branch bar and commit area for changes tab
  if (activitySlotElement) {
    activitySlotElement.style.display = tab === 'changes' ? '' : 'none';
  }
  if (branchBarElement) {
    branchBarElement.style.display = 'none';
  }
  const commitArea = document.getElementById('git-commit-area');
  if (commitArea) {
    commitArea.style.display = tab === 'changes' ? '' : 'none';
  }

  // Load content based on tab
  if (tab === 'changes') {
    loadChanges();
  } else if (tab === 'branches') {
    loadBranches();
  } else if (tab === 'worktrees') {
    loadWorktrees();
  }
}

/**
 * Render loading state
 */
function renderLoading(message = 'Loading...') {
  if (!contentElement) return;
  if (currentTab === 'changes') {
    clearActivitySlot();
  }

  contentElement.innerHTML = `
    <div class="github-loading">
      <div class="github-loading-spinner"></div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

/**
 * Render error state
 */
function renderError(message) {
  if (!contentElement) return;
  if (currentTab === 'changes') {
    clearActivitySlot();
    publishGitChangesCount(0);
  }

  contentElement.innerHTML = `
    <div class="github-error">
      <div class="github-error-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
  const existingToast = document.querySelector('.github-toast');
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement('div');
  toast.className = `github-toast github-toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${getToastIcon(type)}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;

  if (panelElement) {
    panelElement.appendChild(toast);
  }

  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

function publishGitChangesCount(count) {
  const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
  window.dispatchEvent(new CustomEvent(GIT_CHANGES_COUNT_EVENT, {
    detail: { count: safeCount }
  }));
}

function loadAutoStagePreference() {
  try {
    const raw = window.localStorage.getItem(AUTO_STAGE_STORAGE_KEY);
    if (raw === 'true' || raw === 'false') {
      _autoStageBeforeCommit = raw === 'true';
    }
  } catch {
    _autoStageBeforeCommit = true;
  }
}

function persistAutoStagePreference() {
  try {
    window.localStorage.setItem(AUTO_STAGE_STORAGE_KEY, _autoStageBeforeCommit ? 'true' : 'false');
  } catch {
    // Ignore persistence errors.
  }
}

function syncAutoStageToggle() {
  const toggle = document.getElementById('git-auto-stage-toggle');
  if (!toggle) return;
  toggle.classList.toggle('is-on', _autoStageBeforeCommit);
  toggle.setAttribute('aria-pressed', _autoStageBeforeCommit ? 'true' : 'false');
  toggle.title = _autoStageBeforeCommit
    ? 'Auto-stage: on (stage all local changes before commit)'
    : 'Auto-stage: off (only commit already staged changes)';
}

/**
 * Get toast icon based on type
 */
function getToastIcon(type) {
  switch (type) {
    case 'success':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    case 'error':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    default:
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }
}

const { escapeHtml, escapeAttr } = require('./escapeHtml');

// ==================== BRANCHES FUNCTIONALITY ====================

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
    renderLoading('Loading branches...');
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
 * Render branches list
 */
function renderBranches() {
  if (!contentElement) return;

  const { currentBranch, branches } = branchesData;

  if (!branches || branches.length === 0) {
    contentElement.innerHTML = `
      <div class="github-empty">
        <div class="github-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="6" y1="3" x2="6" y2="15"/>
            <circle cx="18" cy="6" r="3"/>
            <circle cx="6" cy="18" r="3"/>
            <path d="M18 9a9 9 0 0 1-9 9"/>
          </svg>
        </div>
        <p>No branches found</p>
        <span>Not a git repository?</span>
      </div>
    `;
    return;
  }

  // Separate local and remote branches
  const localBranches = branches.filter(b => !b.isRemote);
  const remoteBranches = branches.filter(b => b.isRemote);

  contentElement.innerHTML = `
    <div class="git-branches-section">
      <h4 class="git-branches-section-title">Local Branches</h4>
      ${localBranches.map(branch => renderBranchItem(branch, currentBranch)).join('')}
    </div>
    ${remoteBranches.length > 0 ? `
      <div class="git-branches-section">
        <h4 class="git-branches-section-title">Remote Branches</h4>
        ${remoteBranches.map(branch => renderBranchItem(branch, currentBranch)).join('')}
      </div>
    ` : ''}
  `;

  attachBranchEventListeners();
}

/**
 * Render single branch item
 */
function renderBranchItem(branch, currentBranch) {
  const isCurrent = branch.name === currentBranch;
  const canDelete = !isCurrent && !branch.isRemote;
  const canSwitch = !isCurrent;

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
        ${canSwitch ? `<button class="git-branch-action-btn checkout" title="Switch to branch"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>` : ''}
        ${canDelete ? `<button class="git-branch-action-btn delete" title="Delete branch"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ''}
      </div>
    </div>
  `;
}

/**
 * Attach branch event listeners
 */
function attachBranchEventListeners() {
  // Checkout buttons
  contentElement.querySelectorAll('.git-branch-action-btn.checkout').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const branchName = btn.closest('.git-branch-item').dataset.branch;
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
async function handleSwitchBranch(branchName) {
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.SWITCH_GIT_BRANCH, { projectPath, branchName });

    if (result.error === 'uncommitted_changes') {
      showToast('Commit or stash changes first', 'error');
      return;
    }

    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }

    showToast(`Switched to ${result.branch}`, 'success');
    await loadBranches();
  } catch {
    showToast('Failed to switch branch', 'error');
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
          showToast('Operation failed', 'error');
          return;
        }
      } else {
        return;
      }
    }

    showToast(`Deleted ${branchName}`, 'success');
    await loadBranches();
  } catch {
    showToast('Failed to delete branch', 'error');
  }
}

/**
 * Render branches error
 */
function renderBranchesError(message) {
  if (!contentElement) return;

  contentElement.innerHTML = `
    <div class="github-error">
      <div class="github-error-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="6" y1="3" x2="6" y2="15"/>
          <circle cx="18" cy="6" r="3"/>
          <circle cx="6" cy="18" r="3"/>
          <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
      </div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

// ==================== WORKTREES FUNCTIONALITY ====================

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
    renderLoading('Loading worktrees...');
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

/**
 * Render worktrees list
 */
function renderWorktrees() {
  if (!contentElement) return;

  const { worktrees } = worktreesData;

  if (!worktrees || worktrees.length === 0) {
    contentElement.innerHTML = `
      <div class="github-empty">
        <div class="github-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <p>No worktrees</p>
        <span>Add a worktree to work on multiple branches</span>
      </div>
    `;
    return;
  }

  contentElement.innerHTML = `
    <div class="git-worktrees-list">
      ${worktrees.map(wt => renderWorktreeItem(wt)).join('')}
    </div>
  `;

  attachWorktreeEventListeners();
}

/**
 * Render single worktree item
 */
function renderWorktreeItem(worktree) {
  const canRemove = !worktree.isMain;
  const pathName = pathApi.basename(worktree.path) || worktree.path;

  return `
    <div class="git-worktree-item ${worktree.isMain ? 'main' : ''}" data-path="${escapeAttr(worktree.path)}">
      <div class="git-worktree-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="git-worktree-content">
        <div class="git-worktree-name">${escapeHtml(pathName)}</div>
        <div class="git-worktree-meta">
          <span class="git-worktree-branch">${escapeHtml(worktree.branch || 'detached')}</span>
          ${worktree.isMain ? '<span class="git-worktree-badge">main</span>' : ''}
        </div>
        <div class="git-worktree-path">${escapeHtml(worktree.path)}</div>
      </div>
      <div class="git-worktree-actions">
        ${canRemove ? `<button class="git-worktree-action-btn remove" title="Remove worktree"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ''}
      </div>
    </div>
  `;
}

/**
 * Attach worktree event listeners
 */
function attachWorktreeEventListeners() {
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

    showToast('Worktree removed', 'success');
    await loadWorktrees();
  } catch {
    showToast('Failed to remove worktree', 'error');
  }
}

/**
 * Render worktrees error
 */
function renderWorktreesError(message) {
  if (!contentElement) return;

  contentElement.innerHTML = `
    <div class="github-error">
      <div class="github-error-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

// ==================== MODAL FUNCTIONALITY ====================

/**
 * Setup modal event listeners
 */
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

/**
 * Show create branch modal
 */
function showCreateBranchModal() {
  const modal = document.getElementById('create-branch-modal');
  const input = document.getElementById('new-branch-name');
  const select = document.getElementById('base-branch-select');
  const checkbox = document.getElementById('switch-to-branch');

  if (modal) {
    modal.classList.add('visible');

    // Reset form
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 100);
    }
    if (checkbox) {
      checkbox.checked = true;
    }

    // Populate base branch dropdown
    populateBaseBranchSelect(select);
  }
}

/**
 * Populate base branch select dropdown
 */
async function populateBaseBranchSelect(select) {
  if (!select) return;

  select.innerHTML = '<option value="">Loading...</option>';

  const state = require('./state');
  const projectPath = state.getProjectPath();

  if (!projectPath) {
    select.innerHTML = '<option value="">No project selected</option>';
    return;
  }

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_GIT_BRANCHES, projectPath);

    if (result.error || !result.branches) {
      select.innerHTML = '<option value="">Failed to load branches</option>';
      return;
    }

    // Get local branches only for base branch selection
    const localBranches = result.branches.filter(b => !b.isRemote);
    const currentBranch = result.currentBranch;

    select.innerHTML = localBranches.map(branch => {
      const isDefault = branch.name === currentBranch;
      return `<option value="${escapeAttr(branch.name)}" ${isDefault ? 'selected' : ''}>${escapeHtml(branch.name)}${isDefault ? ' (current)' : ''}</option>`;
    }).join('');

  } catch (err) {
    console.error('Failed to load branches for select:', err);
    select.innerHTML = '<option value="">Failed to load branches</option>';
  }
}

/**
 * Hide create branch modal
 */
function hideCreateBranchModal() {
  const modal = document.getElementById('create-branch-modal');
  if (modal) {
    modal.classList.remove('visible');
  }
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
          showToast(result.error, 'error');
          return;
        }
        hideConflictModal();
        showToast('Conflict resolved and staged', 'success');
        await loadChanges(true);
      } catch {
        showToast('Failed to resolve conflict', 'error');
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
      showToast(result.error, 'error');
      return;
    }

    _activeConflictState = result;
    if (baseInput) baseInput.value = result.base || '';
    if (oursInput) oursInput.value = result.ours || '';
    if (theirsInput) theirsInput.value = result.theirs || '';
    if (resolvedInput) resolvedInput.value = result.current || result.ours || result.theirs || '';
  } catch {
    hideConflictModal();
    showToast('Failed to load conflict details', 'error');
  }
}

function hideConflictModal() {
  const modal = document.getElementById('git-conflict-modal');
  if (modal) modal.classList.remove('visible');
  _activeConflictState = null;
}

/**
 * Handle create branch
 */
async function handleCreateBranch() {
  const input = document.getElementById('new-branch-name');
  const select = document.getElementById('base-branch-select');
  const checkbox = document.getElementById('switch-to-branch');

  const branchName = input?.value?.trim();
  const baseBranch = select?.value;
  const shouldCheckout = checkbox?.checked ?? true;

  if (!branchName) {
    showToast('Please enter a branch name', 'error');
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
      showToast('Operation failed', 'error');
      return;
    }

    hideCreateBranchModal();
    const message = shouldCheckout
      ? `Created and switched to ${branchName}`
      : `Created ${branchName}`;
    showToast(message, 'success');
    await loadBranches();
  } catch {
    showToast('Failed to create branch', 'error');
  }
}

// ==================== CHANGES FUNCTIONALITY ====================

function computeChangesHash(data) {
  const staged = Array.isArray(data.staged) ? data.staged : [];
  const unstaged = Array.isArray(data.unstaged) ? data.unstaged : [];
  const untracked = Array.isArray(data.untracked) ? data.untracked : [];
  const parts = [
    (data.conflicts || []).map(f => f.status + ':' + f.path).join('|'),
    staged.map(f => f.status + ':' + f.path).join('|'),
    unstaged.map(f => f.status + ':' + f.path).join('|'),
    untracked.map(f => f.path).join('|'),
    (data.outgoingCommits || data.unpushedCommits || []).map(c => `${c.hash}:${c.graph || ''}`).join('|'),
    (data.incomingCommits || []).map(c => `${c.hash}:${c.graph || ''}`).join('|'),
    (data.localCommits || []).map(c => `${c.hash}:${c.graph || ''}`).join('|'),
    (data.activity || []).map(a => `${a.date}:${a.count}`).join('|'),
    String(data.activityTotal || 0),
    String(data.hasUpstream),
    data.trackingBranch || ''
  ];
  return parts.join('\n');
}

function formatActivityDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function activityLevel(count) {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 7) return 3;
  return 4;
}

function buildActivityGrid(activity) {
  if (!Array.isArray(activity) || activity.length === 0) {
    return { cols: [], monthLabels: [], total: 0 };
  }

  const dayMap = new Map();
  let total = 0;
  for (const item of activity) {
    if (!item || typeof item.date !== 'string') continue;
    const count = Number(item.count) || 0;
    dayMap.set(item.date, count);
    total += count;
  }

  const start = new Date(`${activity[0].date}T12:00:00`);
  const end = new Date(`${activity[activity.length - 1].date}T12:00:00`);
  const mondayAligned = new Date(start);
  const dow = (mondayAligned.getDay() + 6) % 7; // Monday=0
  mondayAligned.setDate(mondayAligned.getDate() - dow);

  const cells = [];
  const cursor = new Date(mondayAligned);
  while (cursor <= end) {
    const date = formatActivityDate(cursor);
    const count = dayMap.get(date) || 0;
    cells.push({ date, count, level: activityLevel(count) });
    cursor.setDate(cursor.getDate() + 1);
  }

  while (cells.length % 7 !== 0) {
    const last = new Date(`${cells[cells.length - 1].date}T12:00:00`);
    last.setDate(last.getDate() + 1);
    cells.push({ date: formatActivityDate(last), count: 0, level: 0 });
  }

  const cols = [];
  for (let i = 0; i < cells.length; i += 7) {
    cols.push(cells.slice(i, i + 7));
  }

  const monthLabels = [];
  let lastMonth = -1;
  for (let i = 0; i < cols.length; i++) {
    const date = new Date(`${cols[i][0].date}T12:00:00`);
    const month = date.getMonth();
    if (month === lastMonth) continue;

    const x = HEATMAP_LABEL_WIDTH + i * (HEATMAP_CELL_SIZE + HEATMAP_GAP);
    if (monthLabels.length > 0) {
      const prev = monthLabels[monthLabels.length - 1];
      if ((x - prev.x) < HEATMAP_MIN_MONTH_GAP) {
        lastMonth = month;
        continue;
      }
    }

    monthLabels.push({
      text: date.toLocaleDateString('en-US', { month: 'short' }),
      x
    });
    lastMonth = month;
  }

  return { cols, monthLabels, total };
}

function renderActivityHeatmapSection(activity, totalHint = null, options = {}) {
  const grid = buildActivityGrid(activity);
  if (grid.cols.length === 0) return '';

  const gridWidth = HEATMAP_LABEL_WIDTH + grid.cols.length * (HEATMAP_CELL_SIZE + HEATMAP_GAP);
  const displayTotal = typeof totalHint === 'number' && totalHint > 0 ? totalHint : grid.total;
  const legend = ['None', 'Low', 'Mid', 'High', 'Max'];
  const pending = Boolean(options.pending);
  const sync = options.sync || {};
  const branch = typeof sync.branch === 'string' && sync.branch.trim() ? sync.branch : null;
  const hasUpstream = Boolean(sync.hasUpstream);
  const upstream = hasUpstream && typeof sync.upstream === 'string' && sync.upstream.trim() ? sync.upstream : null;
  const syncHeader = branch ? `
        <div class="sc-activity-sync">
          <span class="sc-activity-branch-name">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"/>
              <circle cx="18" cy="6" r="3"/>
              <circle cx="6" cy="18" r="3"/>
              <path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
            ${escapeHtml(branch)}
          </span>
          ${upstream
            ? `<span class="sc-upstream-name" title="Tracking ${escapeAttr(upstream)}">${escapeHtml(upstream)}</span>`
            : '<span class="sc-upstream-name no-upstream">No upstream</span>'}
        </div>
      ` : '';

  return `
    <div class="sc-activity-card">
      <div class="sc-activity-header">
        <div class="sc-activity-header-main">
          <h4 class="sc-activity-title">Activity</h4>
          <div class="sc-activity-meta">
            <span class="sc-activity-total">${displayTotal} commit${displayTotal === 1 ? '' : 's'} last year</span>
            ${pending ? '<span class="sc-activity-pending">Committing...</span>' : ''}
          </div>
        </div>
        ${syncHeader}
      </div>
      <div class="sc-activity-heatmap-scroll">
        <div class="sc-activity-heatmap" style="width:${gridWidth}px">
          <div class="sc-activity-months" style="margin-left:${HEATMAP_LABEL_WIDTH}px">
            ${grid.monthLabels.map(label => `
              <span class="sc-activity-month" style="left:${label.x - HEATMAP_LABEL_WIDTH}px">${escapeHtml(label.text)}</span>
            `).join('')}
          </div>
          <div
            class="sc-activity-grid"
            style="
              grid-template-columns:${HEATMAP_LABEL_WIDTH}px repeat(${grid.cols.length}, ${HEATMAP_CELL_SIZE}px);
              grid-template-rows:repeat(7, ${HEATMAP_CELL_SIZE}px);
              gap:${HEATMAP_GAP}px;
            "
          >
            ${Array.from({ length: 7 }).map((_, dayIndex) => `
              <div class="sc-activity-day-label">${HEATMAP_DAY_LABELS[dayIndex]}</div>
              ${grid.cols.map((col) => {
                const cell = col[dayIndex];
                const tip = `${cell.count} commit${cell.count === 1 ? '' : 's'} on ${new Date(`${cell.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
                return `<div class="sc-activity-cell lvl-${cell.level}" title="${escapeAttr(tip)}" aria-label="${escapeAttr(tip)}"></div>`;
              }).join('')}
            `).join('')}
          </div>
        </div>
      </div>
      <div class="sc-activity-legend">
        <span>Less</span>
        ${legend.map((label, i) => `<span class="sc-activity-cell lvl-${i}" title="${label}"></span>`).join('')}
        <span>More</span>
      </div>
    </div>
  `;
}

function clearActivitySlot() {
  if (!activitySlotElement) return;
  activitySlotElement.innerHTML = '';
  activitySlotElement.style.display = 'none';
}

function getActivityRenderOptions() {
  return {
    pending: _activityPending,
    sync: _syncData
  };
}

function renderActivitySlot(activity, totalHint = null, options = {}) {
  if (!activitySlotElement) return;
  if (currentTab !== 'changes') {
    clearActivitySlot();
    return;
  }

  const activityHtml = renderActivityHeatmapSection(activity, totalHint, options);
  if (!activityHtml) {
    clearActivitySlot();
    return;
  }

  activitySlotElement.innerHTML = activityHtml;
  activitySlotElement.style.display = '';

  const heatmapScroll = activitySlotElement.querySelector('.sc-activity-heatmap-scroll');
  if (heatmapScroll) {
    requestAnimationFrame(() => {
      heatmapScroll.scrollLeft = Math.max(0, heatmapScroll.scrollWidth - heatmapScroll.clientWidth);
    });
  }
}

function setActivityPending(pending) {
  const normalized = Boolean(pending);
  if (_activityPending === normalized) return;
  _activityPending = normalized;
  renderActivitySlot(changesData.activity || [], changesData.activityTotal || 0, getActivityRenderOptions());
}

async function loadChanges(force) {
  if (force) { _lastChangesHash = null; _loadChangesPromise = null; }
  if (_loadChangesPromise) return _loadChangesPromise;
  _loadChangesPromise = _loadChangesImpl();
  try { await _loadChangesPromise; } finally { _loadChangesPromise = null; }
}

async function _loadChangesImpl() {
  const state = require('./state');
  const projectPath = state.getProjectPath();

  if (!projectPath) {
    renderError('No project selected');
    return;
  }

  const gen = ++_changesGeneration;

  if (!_hasChangesData) {
    renderLoading('Loading changes...');
  }

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_GIT_CHANGES, projectPath);

    if (gen !== _changesGeneration) return;

    if (result.error) {
      _lastChangesHash = null;
      renderChangesError(result.error);
    } else {
      const newHash = computeChangesHash(result);
      if (newHash === _lastChangesHash && _hasChangesData) {
        return;
      }
      _lastChangesHash = newHash;
      changesData = result;
      _hasChangesData = true;
      renderChanges(gen);
    }
  } catch (err) {
    if (gen !== _changesGeneration) return;
    console.error('Error loading changes:', err);
    renderChangesError('Failed to load changes');
  } finally {
    _watcherCooldownUntil = Date.now() + 1500;
  }
}

/**
 * Render source control sections with clear separation (merge, working tree, staged, sync).
 */
function renderChanges(gen) {
  if (!contentElement) return;

  const {
    conflicts = [],
    staged = [],
    unstaged = [],
    untracked = [],
    outgoingCommits = [],
    incomingCommits = [],
    unpushedCommits = [],
    localCommits = [],
    activity = [],
    activityTotal = 0,
    hasUpstream = false,
    trackingBranch = null
  } = changesData;
  const outgoing = outgoingCommits.length > 0 ? outgoingCommits : unpushedCommits;
  const showLocalCommits = !hasUpstream && Array.isArray(localCommits) && localCommits.length > 0;
  const workingTree = [
    ...unstaged.map(f => ({ ...f, diffType: 'unstaged' })),
    ...untracked.map(f => ({ ...f, diffType: 'untracked' }))
  ];
  const hasLocalChanges = conflicts.length > 0 || staged.length > 0 || workingTree.length > 0;
  const hasSyncChanges = outgoing.length > 0 || incomingCommits.length > 0 || showLocalCommits;

  const outgoingLabel = hasUpstream ? 'Outgoing' : 'Local';
  const outgoingValue = hasUpstream ? outgoing.length : (showLocalCommits ? localCommits.length : 0);
  const summaryCards = [
    { label: 'Merge', value: conflicts.length, tone: 'conflict' },
    { label: 'Working', value: workingTree.length, tone: 'working' },
    { label: 'Staged', value: staged.length, tone: 'staged' },
    { label: outgoingLabel, value: outgoingValue, tone: 'outgoing' },
    { label: 'Incoming', value: incomingCommits.length, tone: 'incoming' }
  ];
  const syncLabel = hasUpstream && trackingBranch
    ? `Tracking ${escapeHtml(trackingBranch)}`
    : (showLocalCommits ? 'No upstream configured (showing local commits)' : 'No tracking branch configured');
  publishGitChangesCount(changesData.totalCount || 0);
  renderActivitySlot(activity, activityTotal, getActivityRenderOptions());

  let html = `
    <div class="sc-overview-card">
      <div class="sc-overview-sync">${syncLabel}</div>
      <div class="sc-overview-grid">
        ${summaryCards.map(card => `
          <div class="sc-overview-item ${card.tone}">
            <span class="sc-overview-value">${card.value}</span>
            <span class="sc-overview-label">${card.label}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  if (!hasLocalChanges && !hasSyncChanges) {
    html += `
      <div class="github-empty">
        <div class="github-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <p>No changes</p>
        <span>Working tree is clean${hasUpstream ? ' and up to date' : ''}</span>
      </div>
    `;
    contentElement.innerHTML = html;
    attachChangesEventListeners();
    loadStashSection(gen);
    updateCommitArea();
    return;
  }

  if (conflicts.length > 0) {
    const collapsed = _collapsedSections.has('merge');
    html += `
      <div class="git-changes-section${collapsed ? ' collapsed' : ''}" data-section="merge">
        <h4 class="git-changes-section-title" data-section-toggle="merge">
          <span class="section-chevron">▾</span>
          <span class="git-changes-section-icon conflict">●</span>
          Merge Changes
          <span class="git-changes-count">${conflicts.length}</span>
        </h4>
        <div class="git-changes-section-body">
          ${conflicts.map(file => renderChangeItem(file, 'conflict')).join('')}
        </div>
      </div>
    `;
  }

  if (workingTree.length > 0) {
    const collapsed = _collapsedSections.has('working');
    html += `
      <div class="git-changes-section${collapsed ? ' collapsed' : ''}" data-section="working">
        <h4 class="git-changes-section-title" data-section-toggle="working">
          <span class="section-chevron">▾</span>
          <span class="git-changes-section-icon unstaged">●</span>
          Working Tree
          <span class="git-changes-count">${workingTree.length}</span>
          <div class="git-changes-section-actions">
            <button class="git-section-action-btn" data-action="stage-all" title="Stage all">+</button>
            <button class="git-section-action-btn discard" data-action="discard-all" title="Discard all unstaged changes"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>
            <button class="git-section-action-btn stash" data-action="stash-all" title="Stash all changes"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg></button>
          </div>
        </h4>
        <div class="git-changes-section-body">
          ${workingTree.map(file => renderChangeItem(file, file.diffType)).join('')}
        </div>
      </div>
    `;
  }

  if (staged.length > 0) {
    const collapsed = _collapsedSections.has('staged');
    html += `
      <div class="git-changes-section${collapsed ? ' collapsed' : ''}" data-section="staged">
        <h4 class="git-changes-section-title" data-section-toggle="staged">
          <span class="section-chevron">▾</span>
          <span class="git-changes-section-icon staged">●</span>
          Staged Changes
          <span class="git-changes-count">${staged.length}</span>
          <div class="git-changes-section-actions">
            <button class="git-section-action-btn" data-action="unstage-all" title="Unstage all">−</button>
          </div>
        </h4>
        <div class="git-changes-section-body">
          ${staged.map(file => renderChangeItem(file, 'staged')).join('')}
        </div>
      </div>
    `;
  }

  if (outgoing.length > 0) {
    const collapsed = _collapsedSections.has('outgoing');
    html += `
      <div class="git-changes-section${collapsed ? ' collapsed' : ''}" data-section="outgoing">
        <h4 class="git-changes-section-title" data-section-toggle="outgoing">
          <span class="section-chevron">▾</span>
          <span class="git-changes-section-icon outgoing">▲</span>
          Outgoing Commits
          <span class="git-changes-count">${outgoing.length}</span>
          <div class="git-changes-section-actions">
            <button class="git-section-action-btn undo" data-action="undo-last-commit" title="Undo last commit (keep changes staged)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10a5 5 0 0 1 0 10H14"/><polyline points="3 10 7 6"/><polyline points="3 10 7 14"/></svg></button>
          </div>
        </h4>
        <div class="git-changes-section-body">
          ${trackingBranch ? `<div class="git-changes-tracking">Ahead of ${escapeHtml(trackingBranch)}</div>` : ''}
          ${outgoing.map(commit => renderCommitItem(commit, { kind: 'outgoing' })).join('')}
        </div>
      </div>
    `;
  } else if (showLocalCommits) {
    const collapsed = _collapsedSections.has('local');
    html += `
      <div class="git-changes-section${collapsed ? ' collapsed' : ''}" data-section="local">
        <h4 class="git-changes-section-title" data-section-toggle="local">
          <span class="section-chevron">▾</span>
          <span class="git-changes-section-icon outgoing">●</span>
          Local Commits
          <span class="git-changes-count">${localCommits.length}</span>
          <div class="git-changes-section-actions">
            <button class="git-section-action-btn undo" data-action="undo-last-commit" title="Undo last commit (keep changes staged)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10a5 5 0 0 1 0 10H14"/><polyline points="3 10 7 6"/><polyline points="3 10 7 14"/></svg></button>
          </div>
        </h4>
        <div class="git-changes-section-body">
          <div class="git-changes-tracking">No upstream configured</div>
          ${localCommits.map(commit => renderCommitItem(commit, { kind: 'local' })).join('')}
        </div>
      </div>
    `;
  } else if (!hasUpstream && hasLocalChanges) {
    html += `
      <div class="git-changes-section">
        <h4 class="git-changes-section-title">
          <span class="section-chevron">▾</span>
          <span class="git-changes-section-icon outgoing">▲</span>
          Outgoing Commits
        </h4>
        <div class="git-changes-tracking">No tracking branch configured</div>
      </div>
    `;
  }

  if (incomingCommits.length > 0) {
    const collapsed = _collapsedSections.has('incoming');
    html += `
      <div class="git-changes-section${collapsed ? ' collapsed' : ''}" data-section="incoming">
        <h4 class="git-changes-section-title" data-section-toggle="incoming">
          <span class="section-chevron">▾</span>
          <span class="git-changes-section-icon incoming">▼</span>
          Incoming Commits
          <span class="git-changes-count">${incomingCommits.length}</span>
        </h4>
        <div class="git-changes-section-body">
          ${trackingBranch ? `<div class="git-changes-tracking">Behind ${escapeHtml(trackingBranch)}</div>` : ''}
          ${incomingCommits.map(commit => renderCommitItem(commit, { kind: 'incoming' })).join('')}
        </div>
      </div>
    `;
  }

  contentElement.innerHTML = html;
  attachChangesEventListeners();

  loadStashSection(gen);
  updateCommitArea();
}

/**
 * Render a single commit item
 */
function renderCommitItem(commit, options = { kind: 'outgoing' }) {
  const isOutgoing = options.kind !== 'incoming';
  const graphLane = typeof commit.graph === 'string' && commit.graph.length > 0 ? commit.graph : '*';
  const actions = isOutgoing ? `
      <div class="git-commit-actions">
        <button class="git-commit-action-btn revert" data-hash="${escapeAttr(commit.hash)}" title="Revert this commit"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10a5 5 0 0 1 0 10H14"/><polyline points="3 10 7 6"/><polyline points="3 10 7 14"/></svg></button>
      </div>
  ` : '';
  return `
    <div class="git-commit-item ${isOutgoing ? 'outgoing' : 'incoming'}" data-hash="${escapeAttr(commit.hash)}">
      <span class="git-commit-graph">${escapeHtml(graphLane)}</span>
      <span class="git-commit-hash">${escapeHtml(commit.shortHash)}</span>
      <span class="git-commit-message">${escapeHtml(commit.message)}</span>
      <span class="git-commit-meta">${escapeHtml(commit.author)} &middot; ${escapeHtml(commit.relativeTime)}</span>
      ${actions}
    </div>
  `;
}

/**
 * Render a single change item
 */
function renderChangeItem(file, diffType) {
  const fileName = pathApi.basename(file.path);
  const dirName = pathApi.dirname(file.path);
  const dirPath = dirName && dirName !== '.' ? `${dirName}${pathApi.sep}` : '';
  const statusClass = diffType === 'conflict'
    ? 'conflict'
    : file.status === 'M'
      ? 'modified'
      : file.status === 'A'
        ? 'added'
        : file.status === 'D'
          ? 'deleted'
          : file.status === 'R'
            ? 'renamed'
            : 'untracked';

  const discardBtn = diffType === 'conflict'
    ? ''
    : `<button class="git-change-action-btn discard" data-path="${escapeAttr(file.path)}" data-diff-type="${diffType}" title="Discard changes"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>`;

  const stashBtn = diffType === 'unstaged'
    ? `<button class="git-change-action-btn stash-file" data-path="${escapeAttr(file.path)}" title="Stash file"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg></button>`
    : '';

  const stageBtn = diffType === 'unstaged' || diffType === 'untracked' || diffType === 'conflict'
    ? `<button class="git-change-action-btn stage" data-path="${escapeAttr(file.path)}" title="Stage file">+</button>`
    : '';
  const unstageBtn = diffType === 'staged'
    ? `<button class="git-change-action-btn unstage" data-path="${escapeAttr(file.path)}" title="Unstage file">−</button>`
    : '';

  return `
    <div class="git-change-item" data-path="${escapeAttr(file.path)}" data-diff-type="${diffType}">
      <span class="git-change-status ${statusClass}">${escapeHtml(file.status)}</span>
      <div class="git-change-file">
        <span class="git-change-filename">${escapeHtml(fileName)}</span>
        ${dirPath ? `<span class="git-change-dir">${escapeHtml(dirPath)}</span>` : ''}
        ${file.oldPath ? `<span class="git-change-dir">renamed from ${escapeHtml(file.oldPath)}</span>` : ''}
      </div>
      <div class="git-change-actions">
        ${discardBtn}${stashBtn}${stageBtn}${unstageBtn}
      </div>
    </div>
  `;
}

/**
 * Toggle a collapsible section
 */
function toggleSection(sectionId) {
  if (_collapsedSections.has(sectionId)) {
    _collapsedSections.delete(sectionId);
  } else {
    _collapsedSections.add(sectionId);
  }
  const el = contentElement.querySelector(`[data-section="${sectionId}"]`);
  if (el) el.classList.toggle('collapsed');
}

/**
 * Attach event listeners for changes
 */
function attachChangesEventListeners() {
  // Section collapse/expand toggle
  contentElement.querySelectorAll('[data-section-toggle]').forEach(title => {
    title.addEventListener('click', (e) => {
      if (e.target.closest('.git-section-action-btn')) return;
      toggleSection(title.dataset.sectionToggle);
    });
  });

  // Click on file -> open diff modal
  contentElement.querySelectorAll('.git-change-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.git-change-action-btn')) return;
      const filePath = item.dataset.path;
      const diffType = item.dataset.diffType;
      if (diffType === 'conflict') {
        showConflictModal(filePath);
      } else {
        showDiffModal(filePath, diffType);
      }
    });
  });

  // Click on commit -> open commit diff modal
  contentElement.querySelectorAll('.git-commit-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.git-commit-action-btn')) return;
      const hash = item.dataset.hash;
      showCommitDiffModal(hash);
    });
  });

  // Stage buttons
  contentElement.querySelectorAll('.git-change-action-btn.stage').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const filePath = btn.dataset.path;
      await handleStageFile(filePath);
    });
  });

  // Unstage buttons
  contentElement.querySelectorAll('.git-change-action-btn.unstage').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const filePath = btn.dataset.path;
      await handleUnstageFile(filePath);
    });
  });

  // Discard buttons (per-file)
  contentElement.querySelectorAll('.git-change-action-btn.discard').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const filePath = btn.dataset.path;
      const diffType = btn.dataset.diffType;
      await handleDiscardFile(filePath, diffType);
    });
  });

  // Stash file buttons
  contentElement.querySelectorAll('.git-change-action-btn.stash-file').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const filePath = btn.dataset.path;
      await handleStashFile(filePath);
    });
  });

  // Revert commit buttons
  contentElement.querySelectorAll('.git-commit-action-btn.revert').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      await handleRevertCommit(hash);
    });
  });

  // Section-level action buttons
  contentElement.querySelectorAll('.git-section-action-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      switch (action) {
        case 'stage-all': await handleStageAll(); break;
        case 'unstage-all': await handleUnstageAll(); break;
        case 'discard-all': await handleDiscardAllUnstaged(); break;
        case 'stash-all': await handleStashAll(); break;
        case 'undo-last-commit': await handleUndoLastCommit(); break;
      }
    });
  });
}

/**
 * Handle staging a file
 */
async function handleStageFile(filePath) {
  if (operationInProgress) return;
  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.STAGE_GIT_FILE, { projectPath, filePath });
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('File staged', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to stage file', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle unstaging a file
 */
async function handleUnstageFile(filePath) {
  if (operationInProgress) return;
  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.UNSTAGE_GIT_FILE, { projectPath, filePath });
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('File unstaged', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to unstage file', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle discarding changes for a file
 */
async function handleDiscardFile(filePath, diffType) {
  if (operationInProgress) return;
  const label = diffType === 'untracked' ? 'delete' : 'discard changes for';
  if (!confirm(`Are you sure you want to ${label} "${filePath}"?\n\nThis cannot be undone.`)) return;

  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.DISCARD_GIT_FILE, { projectPath, filePath, diffType });
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('Changes discarded', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to discard changes', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle stashing a single file
 */
async function handleStashFile(filePath) {
  if (operationInProgress) return;
  const message = prompt('Stash message (optional):');
  if (message === null) return; // cancelled

  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.STASH_CHANGES, { projectPath, filePath, message: message || undefined });
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('File stashed', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to stash file', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle staging all files
 */
async function handleStageAll() {
  if (operationInProgress) return;
  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.STAGE_ALL_GIT, projectPath);
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('All files staged', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to stage all', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle unstaging all files
 */
async function handleUnstageAll() {
  if (operationInProgress) return;
  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.UNSTAGE_ALL_GIT, projectPath);
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('All files unstaged', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to unstage all', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle discarding all unstaged changes
 */
async function handleDiscardAllUnstaged() {
  if (operationInProgress) return;
  if (!confirm('Discard ALL unstaged changes?\n\nThis cannot be undone.')) return;

  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.DISCARD_ALL_UNSTAGED, projectPath);
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('All unstaged changes discarded', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to discard changes', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle stashing all changes
 */
async function handleStashAll() {
  if (operationInProgress) return;
  const message = prompt('Stash message (optional):');
  if (message === null) return; // cancelled

  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.STASH_CHANGES, { projectPath, message: message || undefined });
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('Changes stashed', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to stash changes', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle undoing the last commit
 */
async function handleUndoLastCommit() {
  if (operationInProgress) return;
  if (!confirm('Undo last commit?\n\nChanges will be kept staged.')) return;

  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.UNDO_LAST_COMMIT, projectPath);
    if (result.error) {
      showToast(result.error || 'Operation failed', 'error');
      return;
    }
    showToast('Commit undone, changes kept staged', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to undo commit', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle reverting a specific commit
 */
async function handleRevertCommit(hash) {
  if (operationInProgress) return;
  const shortHash = hash.substring(0, 7);
  if (!confirm(`Revert commit ${shortHash}?\n\nThis will create a new commit that undoes the changes.`)) return;

  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.REVERT_COMMIT, { projectPath, commitHash: hash });
    if (result.error) {
      showToast(result.error || 'Operation failed', 'error');
      return;
    }
    showToast(`Commit ${shortHash} reverted`, 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to revert commit', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle applying a stash
 */
async function handleStashApply(stashRef) {
  if (operationInProgress) return;
  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.STASH_APPLY, { projectPath, stashRef });
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    if (result.conflicts) {
      showToast('Applied with conflicts - resolve manually', 'error');
    } else {
      showToast('Stash applied', 'success');
    }
    await loadChanges(true);
  } catch {
    showToast('Failed to apply stash', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle popping a stash
 */
async function handleStashPop(stashRef) {
  if (operationInProgress) return;
  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.STASH_POP, { projectPath, stashRef });
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    if (result.conflicts) {
      showToast('Popped with conflicts - stash kept', 'error');
    } else {
      showToast('Stash popped', 'success');
    }
    await loadChanges(true);
  } catch {
    showToast('Failed to pop stash', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Handle dropping a stash
 */
async function handleStashDrop(stashRef) {
  if (operationInProgress) return;
  if (!confirm(`Drop ${stashRef}?\n\nThis cannot be undone.`)) return;

  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();

  try {
    const result = await ipcRenderer.invoke(IPC.STASH_DROP, { projectPath, stashRef });
    if (result.error) {
      showToast('Operation failed', 'error');
      return;
    }
    showToast('Stash dropped', 'success');
    await loadChanges(true);
  } catch {
    showToast('Failed to drop stash', 'error');
  } finally {
    operationInProgress = false;
  }
}

/**
 * Show diff modal for a stash
 */
async function showStashDiffModal(stashRef) {
  const state = require('./state');
  const projectPath = state.getProjectPath();
  const modal = document.getElementById('git-diff-modal');
  if (!modal) return;

  modal.querySelector('.diff-modal-filename').textContent = stashRef;
  modal.querySelector('.diff-modal-path').textContent = '';
  modal.querySelector('.diff-modal-body').innerHTML = `
    <div class="github-loading">
      <div class="github-loading-spinner"></div>
      <p>Loading stash diff...</p>
    </div>
  `;
  modal.querySelector('.diff-modal-stats').textContent = '';
  modal.querySelector('.diff-modal-status-badge').textContent = 'stash';
  modal.querySelector('.diff-modal-status-badge').className = 'diff-modal-status-badge stash';
  clearCurrentDiffState();
  setDiffViewMode(_diffViewMode);
  syncDiffSearchControls();

  const editBtn = modal.querySelector('.diff-modal-edit-btn');
  if (editBtn) editBtn.style.display = 'none';

  modal.classList.add('visible');

  try {
    const result = await ipcRenderer.invoke(IPC.STASH_SHOW, { projectPath, stashRef });

    if (result.error) {
      modal.querySelector('.diff-modal-body').innerHTML = `
        <div class="github-error"><p>${escapeHtml(result.error)}</p></div>
      `;
      return;
    }

    const { lines, additions, deletions } = parseDiff(result.diff);
    setCurrentDiffState({
      lines,
      additions,
      deletions,
      diffText: result.diff,
      filePath: null,
      diffType: 'stash',
      hunks: []
    });
    renderDiffContent(modal.querySelector('.diff-modal-body'), lines);
    modal.querySelector('.diff-modal-stats').innerHTML = `
      <span class="diff-stat-add">+${additions}</span>
      <span class="diff-stat-del">-${deletions}</span>
    `;
  } catch (err) {
    console.error('Error loading stash diff:', err);
    modal.querySelector('.diff-modal-body').innerHTML = `
      <div class="github-error"><p>Failed to load stash diff</p></div>
    `;
  }
}

/**
 * Load and render stash section
 */
async function loadStashSection(gen) {
  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath || !contentElement) return;

  try {
    const result = await ipcRenderer.invoke(IPC.STASH_LIST, projectPath);

    // Discard stale stash response
    if (gen !== _changesGeneration) return;
    if (result.error || !result.stashes || result.stashes.length === 0) return;

    const collapsed = _collapsedSections.has('stashes');
    const stashHtml = `
      <div class="git-changes-section git-stash-section${collapsed ? ' collapsed' : ''}" data-section="stashes">
        <h4 class="git-changes-section-title" data-section-toggle="stashes">
          <span class="section-chevron">▾</span>
          <span class="git-changes-section-icon" style="color: var(--info);">◆</span>
          Stashes
          <span class="git-changes-count">${result.stashes.length}</span>
        </h4>
        <div class="git-changes-section-body">
          ${result.stashes.map(stash => `
            <div class="git-stash-item" data-ref="${escapeAttr(stash.ref)}">
              <span class="git-stash-ref">${escapeHtml(stash.ref)}</span>
              <span class="git-stash-message">${escapeHtml(stash.message)}</span>
              <span class="git-stash-time">${escapeHtml(stash.relativeTime)}</span>
              <div class="git-stash-actions">
                <button class="git-stash-action-btn apply" data-ref="${escapeAttr(stash.ref)}" title="Apply stash">Apply</button>
                <button class="git-stash-action-btn pop" data-ref="${escapeAttr(stash.ref)}" title="Pop stash">Pop</button>
                <button class="git-stash-action-btn drop" data-ref="${escapeAttr(stash.ref)}" title="Drop stash">Drop</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // Append stash section to content
    const stashContainer = document.createElement('div');
    stashContainer.innerHTML = stashHtml;
    contentElement.appendChild(stashContainer.firstElementChild);

    // Attach stash event listeners
    attachStashEventListeners();
  } catch {
    // Silently fail - stash section is optional
  }
}

/**
 * Attach event listeners for stash section
 */
function attachStashEventListeners() {
  const stashSection = contentElement.querySelector('.git-stash-section');
  if (!stashSection) return;

  // Section toggle for stash section
  const stashTitle = stashSection.querySelector('[data-section-toggle]');
  if (stashTitle) {
    stashTitle.addEventListener('click', (e) => {
      if (e.target.closest('.git-section-action-btn')) return;
      toggleSection(stashTitle.dataset.sectionToggle);
    });
  }

  // Click on stash item -> show diff
  stashSection.querySelectorAll('.git-stash-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.git-stash-action-btn')) return;
      const ref = item.dataset.ref;
      showStashDiffModal(ref);
    });
  });

  // Apply buttons
  stashSection.querySelectorAll('.git-stash-action-btn.apply').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleStashApply(btn.dataset.ref);
    });
  });

  // Pop buttons
  stashSection.querySelectorAll('.git-stash-action-btn.pop').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleStashPop(btn.dataset.ref);
    });
  });

  // Drop buttons
  stashSection.querySelectorAll('.git-stash-action-btn.drop').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleStashDrop(btn.dataset.ref);
    });
  });
}

/**
 * Render changes error
 */
function renderChangesError(message) {
  if (!contentElement) return;
  clearActivitySlot();
  publishGitChangesCount(0);

  contentElement.innerHTML = `
    <div class="github-error">
      <div class="github-error-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

// ==================== DIFF MODAL ====================

function setDiffViewMode(mode) {
  if (mode !== 'split' && mode !== 'unified') return;
  _diffViewMode = mode;
  const modal = document.getElementById('git-diff-modal');
  if (!modal) return;
  modal.querySelectorAll('.diff-view-btn').forEach(btn => {
    const isActive = btn.dataset.diffView === _diffViewMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  if (_currentDiffState && _currentDiffState.lines) {
    renderDiffContent(modal.querySelector('.diff-modal-body'), _currentDiffState.lines);
  }
}

function setCurrentDiffState(nextState) {
  _currentDiffState = nextState;
  _selectedHunkIndex = nextState && nextState.hunks && nextState.hunks.length > 0
    ? (_selectedHunkIndex >= 0 ? Math.min(_selectedHunkIndex, nextState.hunks.length - 1) : 0)
    : -1;
  syncDiffControls();
}

function clearCurrentDiffState() {
  _currentDiffState = null;
  _selectedHunkIndex = -1;
  syncDiffControls();
}

function extractDiffHunks(diffText) {
  const lines = String(diffText || '').split('\n');
  const prefix = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) {
    if (lines[i] !== '') prefix.push(lines[i]);
    i++;
  }

  const hunks = [];
  while (i < lines.length) {
    if (!lines[i].startsWith('@@')) {
      i++;
      continue;
    }
    const header = lines[i];
    const body = [header];
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      if (lines[i] !== '') body.push(lines[i]);
      i++;
    }
    const match = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    hunks.push({
      header,
      oldStart: match ? parseInt(match[1], 10) : null,
      newStart: match ? parseInt(match[3], 10) : null,
      patch: `${[...prefix, ...body].join('\n')}\n`
    });
  }
  return hunks;
}

function syncDiffControls() {
  const modal = document.getElementById('git-diff-modal');
  if (!modal) return;

  const hunkGroup = modal.querySelector('.diff-hunk-controls');
  const hunkSelect = modal.querySelector('.diff-hunk-select');
  const stageBtn = modal.querySelector('.diff-hunk-action.stage');
  const unstageBtn = modal.querySelector('.diff-hunk-action.unstage');
  const discardBtn = modal.querySelector('.diff-hunk-action.discard');
  if (!hunkGroup || !hunkSelect || !stageBtn || !unstageBtn || !discardBtn) return;

  const state = _currentDiffState;
  const hasFileDiff = !!(state && state.filePath && state.diffType && Array.isArray(state.hunks));
  const hasHunks = hasFileDiff && state.hunks.length > 0;
  hunkGroup.style.display = hasFileDiff ? 'flex' : 'none';

  if (!hasFileDiff) {
    hunkSelect.innerHTML = '';
    stageBtn.disabled = true;
    unstageBtn.disabled = true;
    discardBtn.disabled = true;
    return;
  }

  hunkSelect.innerHTML = hasHunks
    ? state.hunks.map((h, idx) => {
      const location = h.oldStart != null && h.newStart != null ? `L${h.oldStart}→${h.newStart}` : h.header;
      return `<option value="${idx}">Hunk ${idx + 1} (${escapeHtml(location)})</option>`;
    }).join('')
    : '<option value="-1">No hunks</option>';

  if (hasHunks && _selectedHunkIndex >= 0 && _selectedHunkIndex < state.hunks.length) {
    hunkSelect.value = String(_selectedHunkIndex);
  }

  const diffType = state.diffType;
  const canStage = hasHunks && (diffType === 'unstaged' || diffType === 'conflict');
  const canUnstage = hasHunks && diffType === 'staged';
  const canDiscard = hasHunks && (diffType === 'unstaged' || diffType === 'conflict');

  stageBtn.disabled = !canStage || _hunkActionInProgress;
  unstageBtn.disabled = !canUnstage || _hunkActionInProgress;
  discardBtn.disabled = !canDiscard || _hunkActionInProgress;
}

function syncDiffSearchControls() {
  const modal = document.getElementById('git-diff-modal');
  if (!modal) return;
  const searchInput = modal.querySelector('.diff-search-input');
  const hideContextCheckbox = modal.querySelector('.diff-hide-context-checkbox');
  if (searchInput && searchInput.value !== _diffSearchQuery) searchInput.value = _diffSearchQuery;
  if (hideContextCheckbox) hideContextCheckbox.checked = _diffHideContext;
}

async function applySelectedHunk(action) {
  if (_hunkActionInProgress || !_currentDiffState) return;
  const { filePath, diffType, hunks } = _currentDiffState;
  if (!filePath || !diffType || !Array.isArray(hunks) || _selectedHunkIndex < 0 || _selectedHunkIndex >= hunks.length) return;

  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) return;

  _hunkActionInProgress = true;
  syncDiffControls();
  try {
    const result = await ipcRenderer.invoke(IPC.APPLY_GIT_HUNK, {
      projectPath,
      filePath,
      diffType,
      action,
      hunkPatch: hunks[_selectedHunkIndex].patch
    });
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast(`Hunk ${action}d`, 'success');
    await loadChanges(true);
    await showDiffModal(filePath, diffType);
  } catch {
    showToast(`Failed to ${action} hunk`, 'error');
  } finally {
    _hunkActionInProgress = false;
    syncDiffControls();
  }
}

/**
 * Show diff modal for a file
 */
async function showDiffModal(filePath, diffType) {
  const state = require('./state');
  const projectPath = state.getProjectPath();
  const modal = document.getElementById('git-diff-modal');
  if (!modal) return;

  // Set filename and path
  const fileName = filePath.split('/').pop();
  modal.querySelector('.diff-modal-filename').textContent = fileName;
  modal.querySelector('.diff-modal-path').textContent = filePath;
  modal.querySelector('.diff-modal-body').innerHTML = `
    <div class="github-loading">
      <div class="github-loading-spinner"></div>
      <p>Loading diff...</p>
    </div>
  `;
  modal.querySelector('.diff-modal-stats').textContent = '';
  modal.querySelector('.diff-modal-status-badge').textContent = diffType;
  modal.querySelector('.diff-modal-status-badge').className = `diff-modal-status-badge ${diffType}`;
  clearCurrentDiffState();
  setDiffViewMode(_diffViewMode);
  syncDiffSearchControls();

  // Store filePath on edit button for later use and ensure it's visible
  const editBtn = modal.querySelector('.diff-modal-edit-btn');
  if (editBtn) {
    editBtn.dataset.filePath = filePath;
    editBtn.style.display = '';
  }

  // Show modal
  modal.classList.add('visible');

  // Load diff
  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_GIT_DIFF, { projectPath, filePath, diffType });

    if (result.error) {
      modal.querySelector('.diff-modal-body').innerHTML = `
        <div class="github-error">
          <p>${escapeHtml(result.error)}</p>
        </div>
      `;
      return;
    }

    if (result.diff === 'Binary file') {
      modal.querySelector('.diff-modal-body').innerHTML = `
        <div class="diff-binary-message">Binary file - cannot display diff</div>
      `;
      return;
    }

    const { lines, additions, deletions } = parseDiff(result.diff);
    const hunks = extractDiffHunks(result.diff);
    setCurrentDiffState({
      lines,
      additions,
      deletions,
      diffText: result.diff,
      filePath,
      diffType,
      hunks
    });
    renderDiffContent(modal.querySelector('.diff-modal-body'), lines);
    modal.querySelector('.diff-modal-stats').innerHTML = `
      <span class="diff-stat-add">+${additions}</span>
      <span class="diff-stat-del">-${deletions}</span>
    `;
  } catch (err) {
    console.error('Error loading diff:', err);
    modal.querySelector('.diff-modal-body').innerHTML = `
      <div class="github-error"><p>Failed to load diff</p></div>
    `;
  }
}

/**
 * Show diff modal for a commit
 */
async function showCommitDiffModal(commitHash) {
  const state = require('./state');
  const projectPath = state.getProjectPath();
  const modal = document.getElementById('git-diff-modal');
  if (!modal) return;

  // Set commit info in modal header
  const shortHash = commitHash.substring(0, 7);
  modal.querySelector('.diff-modal-filename').textContent = `Commit ${shortHash}`;
  modal.querySelector('.diff-modal-path').textContent = commitHash;
  modal.querySelector('.diff-modal-body').innerHTML = `
    <div class="github-loading">
      <div class="github-loading-spinner"></div>
      <p>Loading commit diff...</p>
    </div>
  `;
  modal.querySelector('.diff-modal-stats').textContent = '';
  modal.querySelector('.diff-modal-status-badge').textContent = 'commit';
  modal.querySelector('.diff-modal-status-badge').className = 'diff-modal-status-badge commit';
  clearCurrentDiffState();
  setDiffViewMode(_diffViewMode);
  syncDiffSearchControls();

  // Hide edit button for commits
  const editBtn = modal.querySelector('.diff-modal-edit-btn');
  if (editBtn) editBtn.style.display = 'none';

  // Show modal
  modal.classList.add('visible');

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_COMMIT_DIFF, { projectPath, commitHash });

    if (result.error) {
      modal.querySelector('.diff-modal-body').innerHTML = `
        <div class="github-error">
          <p>${escapeHtml(result.error)}</p>
        </div>
      `;
      return;
    }

    const { lines, additions, deletions } = parseDiff(result.diff);
    setCurrentDiffState({
      lines,
      additions,
      deletions,
      diffText: result.diff,
      filePath: null,
      diffType: 'commit',
      hunks: []
    });
    renderDiffContent(modal.querySelector('.diff-modal-body'), lines);
    modal.querySelector('.diff-modal-stats').innerHTML = `
      <span class="diff-stat-add">+${additions}</span>
      <span class="diff-stat-del">-${deletions}</span>
    `;
  } catch (err) {
    console.error('Error loading commit diff:', err);
    modal.querySelector('.diff-modal-body').innerHTML = `
      <div class="github-error"><p>Failed to load commit diff</p></div>
    `;
  }
}

/**
 * Hide diff modal
 */
function hideDiffModal() {
  const modal = document.getElementById('git-diff-modal');
  if (modal) {
    modal.classList.remove('visible');
  }
  clearCurrentDiffState();
}

/**
 * Parse unified diff into structured lines
 */
function parseDiff(diffText) {
  const rawLines = diffText.split('\n');
  const lines = [];
  let additions = 0;
  let deletions = 0;
  let oldLineNum = 0;
  let newLineNum = 0;
  let hunkIndex = -1;

  for (const line of rawLines) {
    if (line.startsWith('\\ ')) {
      lines.push({ type: 'warning', content: line, oldNum: '', newNum: '', hunkIndex });
      continue;
    }
    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      hunkIndex++;
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[2], 10);
      }
      lines.push({ type: 'header', content: line, oldNum: '', newNum: '', hunkIndex });
    } else if (line.startsWith('+')) {
      if (line.startsWith('+++')) {
        lines.push({ type: 'meta', content: line, oldNum: '', newNum: '', hunkIndex: -1 });
      } else {
        additions++;
        lines.push({ type: 'add', content: line.substring(1), oldNum: '', newNum: newLineNum, hunkIndex });
        newLineNum++;
      }
    } else if (line.startsWith('-')) {
      if (line.startsWith('---')) {
        lines.push({ type: 'meta', content: line, oldNum: '', newNum: '', hunkIndex: -1 });
      } else {
        deletions++;
        lines.push({ type: 'remove', content: line.substring(1), oldNum: oldLineNum, newNum: '', hunkIndex });
        oldLineNum++;
      }
    } else if (line.startsWith('diff ') || line.startsWith('index ')) {
      lines.push({ type: 'meta', content: line, oldNum: '', newNum: '', hunkIndex: -1 });
    } else {
      // Context line
      lines.push({ type: 'context', content: line.startsWith(' ') ? line.substring(1) : line, oldNum: oldLineNum, newNum: newLineNum, hunkIndex });
      oldLineNum++;
      newLineNum++;
    }
  }

  return { lines, additions, deletions };
}

/**
 * Render parsed diff content into the modal body
 */
function renderDiffContent(container, lines) {
  const sourceLines = Array.isArray(lines) ? lines : [];
  if (_diffViewMode === 'split') {
    renderSplitDiffContent(container, sourceLines);
    return;
  }

  const q = _diffSearchQuery.trim().toLowerCase();
  const filtered = sourceLines.filter(line => {
    if (_diffHideContext && line.type === 'context') return false;
    if (!q) return true;
    if (line.type === 'header') return true;
    return String(line.content || '').toLowerCase().includes(q);
  });

  const htmlParts = [];
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i];
    const next = filtered[i + 1];
    const isHunkHeader = line.type === 'header' && line.hunkIndex >= 0;
    const selectedClass = line.hunkIndex === _selectedHunkIndex ? ' selected-hunk' : '';
    const hunkAttr = isHunkHeader ? ` data-hunk-index="${line.hunkIndex}"` : '';
    const baseClass = `diff-line diff-${line.type}${selectedClass}`;
    const oldNum = line.oldNum !== '' ? line.oldNum : '';
    const newNum = line.newNum !== '' ? line.newNum : '';

    if (
      line.type === 'remove' &&
      next &&
      next.type === 'add' &&
      line.hunkIndex === next.hunkIndex
    ) {
      const highlighted = highlightModifiedPair(line.content, next.content);
      htmlParts.push(
        `<div class="${baseClass}"${hunkAttr}><span class="diff-line-num old">${oldNum}</span><span class="diff-line-num new"></span><span class="diff-line-content">${highlighted.oldHtml}</span></div>`
      );
      const nextSelectedClass = next.hunkIndex === _selectedHunkIndex ? ' selected-hunk' : '';
      htmlParts.push(
        `<div class="diff-line diff-add${nextSelectedClass}"><span class="diff-line-num old"></span><span class="diff-line-num new">${next.newNum !== '' ? next.newNum : ''}</span><span class="diff-line-content">${highlighted.newHtml}</span></div>`
      );
      i++;
      continue;
    }

    const content = escapeHtml(line.content);
    htmlParts.push(
      `<div class="${baseClass}"${hunkAttr}><span class="diff-line-num old">${oldNum}</span><span class="diff-line-num new">${newNum}</span><span class="diff-line-content">${content}</span></div>`
    );
  }

  container.innerHTML = `<div class="diff-content unified">${htmlParts.join('')}</div>`;
}

function buildSplitRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.type === 'meta' || line.type === 'header' || line.type === 'warning') {
      rows.push({ kind: 'meta', line, hunkIndex: line.hunkIndex ?? -1 });
      continue;
    }

    if (line.type === 'context') {
      rows.push({ kind: 'code', rowType: 'context', oldLine: line, newLine: line, hunkIndex: line.hunkIndex ?? -1 });
      continue;
    }

    if (line.type === 'remove') {
      const next = lines[i + 1];
      if (next && next.type === 'add') {
        rows.push({ kind: 'code', rowType: 'modify', oldLine: line, newLine: next, hunkIndex: line.hunkIndex ?? -1 });
        i++;
      } else {
        rows.push({ kind: 'code', rowType: 'remove', oldLine: line, newLine: null, hunkIndex: line.hunkIndex ?? -1 });
      }
      continue;
    }

    if (line.type === 'add') {
      rows.push({ kind: 'code', rowType: 'add', oldLine: null, newLine: line, hunkIndex: line.hunkIndex ?? -1 });
    }
  }
  return rows;
}

function renderSplitSide(line, side, contentHtml = null) {
  if (!line) {
    return `<div class="diff-split-cell ${side} empty"><span class="diff-split-num"></span><span class="diff-split-text"></span></div>`;
  }
  const num = side === 'old' ? line.oldNum : line.newNum;
  const text = contentHtml != null
    ? contentHtml
    : escapeHtml(`${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.content}`);
  return `<div class="diff-split-cell ${side}"><span class="diff-split-num">${num !== '' ? num : ''}</span><span class="diff-split-text">${text}</span></div>`;
}

function renderSplitDiffContent(container, lines) {
  const q = _diffSearchQuery.trim().toLowerCase();
  const rows = buildSplitRows(lines).filter(row => {
    if (row.kind === 'code' && _diffHideContext && row.rowType === 'context') return false;
    if (!q) return true;
    if (row.kind === 'meta') {
      if (row.line.type === 'header') return true;
      return String(row.line.content || '').toLowerCase().includes(q);
    }
    const oldText = row.oldLine ? String(row.oldLine.content || '').toLowerCase() : '';
    const newText = row.newLine ? String(row.newLine.content || '').toLowerCase() : '';
    return oldText.includes(q) || newText.includes(q);
  });

  const html = rows.map(row => {
    const selectedClass = row.hunkIndex === _selectedHunkIndex ? ' selected-hunk' : '';
    if (row.kind === 'meta') {
      const isHunkHeader = row.line.type === 'header' && row.hunkIndex >= 0;
      const hunkAttr = isHunkHeader ? ` data-hunk-index="${row.hunkIndex}"` : '';
      return `<div class="diff-split-row meta diff-${row.line.type}${selectedClass}"${hunkAttr}><div class="diff-split-meta">${escapeHtml(row.line.content)}</div></div>`;
    }

    let oldSide = renderSplitSide(row.oldLine, 'old');
    let newSide = renderSplitSide(row.newLine, 'new');
    if (row.rowType === 'modify' && row.oldLine && row.newLine) {
      const highlighted = highlightModifiedPair(row.oldLine.content, row.newLine.content);
      oldSide = renderSplitSide(row.oldLine, 'old', highlighted.oldHtml);
      newSide = renderSplitSide(row.newLine, 'new', highlighted.newHtml);
    }

    return `
      <div class="diff-split-row ${row.rowType}${selectedClass}">
        ${oldSide}
        ${newSide}
      </div>
    `;
  }).join('');

  container.innerHTML = `<div class="diff-content split">${html}</div>`;
}

function tokenizeForWordDiff(text) {
  const tokens = String(text || '').match(/\w+|\s+|[^\w\s]+/g);
  return tokens && tokens.length ? tokens : [''];
}

function highlightModifiedPair(oldText, newText) {
  const oldTokens = tokenizeForWordDiff(oldText);
  const newTokens = tokenizeForWordDiff(newText);

  let start = 0;
  while (
    start < oldTokens.length &&
    start < newTokens.length &&
    oldTokens[start] === newTokens[start]
  ) start++;

  let endOld = oldTokens.length - 1;
  let endNew = newTokens.length - 1;
  while (
    endOld >= start &&
    endNew >= start &&
    oldTokens[endOld] === newTokens[endNew]
  ) {
    endOld--;
    endNew--;
  }

  const oldPrefix = oldTokens.slice(0, start).join('');
  const oldMid = oldTokens.slice(start, endOld + 1).join('');
  const oldSuffix = oldTokens.slice(endOld + 1).join('');
  const newPrefix = newTokens.slice(0, start).join('');
  const newMid = newTokens.slice(start, endNew + 1).join('');
  const newSuffix = newTokens.slice(endNew + 1).join('');

  const oldHtml = `${escapeHtml(`-${oldPrefix}`)}${oldMid ? `<span class="diff-word-remove">${escapeHtml(oldMid)}</span>` : ''}${escapeHtml(oldSuffix)}`;
  const newHtml = `${escapeHtml(`+${newPrefix}`)}${newMid ? `<span class="diff-word-add">${escapeHtml(newMid)}</span>` : ''}${escapeHtml(newSuffix)}`;
  return { oldHtml, newHtml };
}

/**
 * Setup diff modal listeners
 */
function setupDiffModalListeners() {
  const modal = document.getElementById('git-diff-modal');
  if (!modal) return;
  const body = modal.querySelector('.diff-modal-body');
  const searchInput = modal.querySelector('.diff-search-input');
  const hideContextCheckbox = modal.querySelector('.diff-hide-context-checkbox');
  const hunkSelect = modal.querySelector('.diff-hunk-select');
  const stageHunkBtn = modal.querySelector('.diff-hunk-action.stage');
  const unstageHunkBtn = modal.querySelector('.diff-hunk-action.unstage');
  const discardHunkBtn = modal.querySelector('.diff-hunk-action.discard');
  const rerenderCurrentDiff = () => {
    if (!body) return;
    if (_currentDiffState && _currentDiffState.lines) {
      renderDiffContent(body, _currentDiffState.lines);
    }
  };

  // Close button
  modal.querySelector('.diff-modal-close-btn').addEventListener('click', hideDiffModal);

  // Backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideDiffModal();
    }
  });

  // Edit button
  modal.querySelector('.diff-modal-edit-btn').addEventListener('click', () => {
    const filePath = modal.querySelector('.diff-modal-edit-btn').dataset.filePath;
    if (filePath) {
      const state = require('./state');
      const projectPath = state.getProjectPath();
      if (!projectPath) return;
      const fullPath = pathApi.join(projectPath, filePath);
      const editor = require('./editor');
      editor.openFile(fullPath, 'changes');
      hideDiffModal();
    }
  });

  // Diff view toggle
  modal.querySelectorAll('.diff-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setDiffViewMode(btn.dataset.diffView);
    });
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      _diffSearchQuery = searchInput.value || '';
      rerenderCurrentDiff();
    });
  }

  if (hideContextCheckbox) {
    hideContextCheckbox.addEventListener('change', () => {
      _diffHideContext = !!hideContextCheckbox.checked;
      rerenderCurrentDiff();
    });
  }

  if (hunkSelect) {
    hunkSelect.addEventListener('change', () => {
      _selectedHunkIndex = parseInt(hunkSelect.value, 10);
      if (Number.isNaN(_selectedHunkIndex)) _selectedHunkIndex = -1;
      syncDiffControls();
      rerenderCurrentDiff();
    });
  }

  if (stageHunkBtn) {
    stageHunkBtn.addEventListener('click', () => applySelectedHunk('stage'));
  }
  if (unstageHunkBtn) {
    unstageHunkBtn.addEventListener('click', () => applySelectedHunk('unstage'));
  }
  if (discardHunkBtn) {
    discardHunkBtn.addEventListener('click', () => applySelectedHunk('discard'));
  }

  if (body) {
    body.addEventListener('click', (e) => {
      const header = e.target.closest('[data-hunk-index]');
      if (!header) return;
      const nextIndex = parseInt(header.dataset.hunkIndex, 10);
      if (Number.isNaN(nextIndex)) return;
      _selectedHunkIndex = nextIndex;
      syncDiffControls();
      rerenderCurrentDiff();
    });
  }
  setDiffViewMode(_diffViewMode);
  syncDiffSearchControls();
  syncDiffControls();

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('visible')) {
      hideDiffModal();
    }
  });
}

/**
 * Setup commit area event listeners
 */
function setupCommitArea() {
  /** @type {HTMLInputElement|null} */
  const summary = /** @type {HTMLInputElement|null} */ (document.getElementById('git-commit-summary'));
  /** @type {HTMLTextAreaElement|null} */
  const description = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('git-commit-description'));
  const descriptionToggle = document.getElementById('git-commit-description-toggle');
  const commitBtn = document.getElementById('git-commit-btn');
  const fetchBtn = document.getElementById('git-fetch-btn');
  const pullBtn = document.getElementById('git-pull-btn');
  const clearBtn = document.getElementById('git-clear-message-btn');
  const dropdownBtn = document.getElementById('git-commit-dropdown-btn');
  const dropdown = document.getElementById('git-commit-dropdown');
  const autoStageToggle = document.getElementById('git-auto-stage-toggle');

  if (summary) {
    summary.addEventListener('input', () => {
      _commitMessage = summary.value;
      _commitReplaceAllArmed = false;
      updateCommitBtnState();
    });

    summary.addEventListener('keydown', (e) => {
      const isSelectAll = (e.metaKey || e.ctrlKey)
        && !e.shiftKey
        && !e.altKey
        && String(e.key || '').toLowerCase() === 'a';
      if (isSelectAll) {
        e.preventDefault();
        _commitReplaceAllArmed = true;
        summary.select();
        return;
      }

      if (_commitReplaceAllArmed && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        clearCommitInputs();
        updateCommitBtnState();
        summary.focus();
        return;
      }

      if (!(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
        _commitReplaceAllArmed = false;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleCommit();
      }
      // Tab into description field
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        setDescriptionVisibility(true);
        description?.focus();
      }
    });

    summary.addEventListener('blur', () => {
      _commitReplaceAllArmed = false;
    });
  }

  if (description) {
    description.addEventListener('input', () => {
      _commitDescription = description.value;
      setDescriptionVisibility(_descriptionVisible || Boolean(description.value.trim()));
      _commitReplaceAllArmed = false;
    });

    description.addEventListener('keydown', (e) => {
      const isSelectAll = (e.metaKey || e.ctrlKey)
        && !e.shiftKey
        && !e.altKey
        && String(e.key || '').toLowerCase() === 'a';
      if (isSelectAll) {
        e.preventDefault();
        _commitReplaceAllArmed = true;
        description.select();
        return;
      }

      if (_commitReplaceAllArmed && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        clearCommitInputs();
        updateCommitBtnState();
        summary?.focus();
        return;
      }

      if (!(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
        _commitReplaceAllArmed = false;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleCommit();
      }
    });

    description.addEventListener('blur', () => {
      _commitReplaceAllArmed = false;
    });
  }

  if (descriptionToggle) {
    descriptionToggle.addEventListener('click', () => {
      setDescriptionVisibility(!_descriptionVisible);
      if (_descriptionVisible) {
        description?.focus();
      } else {
        summary?.focus();
      }
    });
  }

  if (commitBtn) commitBtn.addEventListener('click', handleCommit);
  if (fetchBtn) fetchBtn.addEventListener('click', () => handleFetch({ silent: false, auto: false }));
  if (pullBtn) pullBtn.addEventListener('click', handlePull);
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearCommitInputs();
      updateCommitBtnState();
      summary?.focus();
    });
  }
  if (autoStageToggle) {
    autoStageToggle.addEventListener('click', () => {
      _autoStageBeforeCommit = !_autoStageBeforeCommit;
      persistAutoStagePreference();
      syncAutoStageToggle();
      updateCommitBtnState();
    });
  }
  syncAutoStageToggle();
  setDescriptionVisibility(Boolean(_commitDescription.trim()));

  // Dropdown toggle
  if (dropdownBtn && dropdown) {
    dropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
    });

    // Close dropdown on outside click
    document.addEventListener('click', () => {
      if (dropdown) dropdown.style.display = 'none';
    });

    // Dropdown actions
    dropdown.querySelectorAll('.sc-dropdown-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.style.display = 'none';
        const action = item.dataset.action;
        if (action === 'commit') handleCommit();
        else if (action === 'commit-push') handleCommitAndPush();
        else if (action === 'amend') handleAmendCommit();
      });
    });
  }
}

function syncRemoteButtonsState() {
  const fetchBtn = document.getElementById('git-fetch-btn');
  const pullBtn = document.getElementById('git-pull-btn');
  const busy = operationInProgress || _fetchInProgress || _pullInProgress;
  const branch = typeof _syncData.branch === 'string' && _syncData.branch.trim() ? _syncData.branch.trim() : null;
  const hasUpstream = Boolean(_syncData.hasUpstream);

  if (fetchBtn) {
    fetchBtn.disabled = busy;
  }

  if (pullBtn) {
    // If we don't have an upstream, fall back to "git pull origin <branch>".
    const canPull = Boolean(hasUpstream || branch);
    pullBtn.disabled = busy || !canPull;
    pullBtn.title = canPull
      ? (hasUpstream ? 'Pull from remote' : 'Pull from origin (no upstream configured)')
      : 'No branch selected';
  }
}

function setDescriptionVisibility(visible) {
  const summary = document.getElementById('git-commit-summary');
  const description = document.getElementById('git-commit-description');
  const toggle = document.getElementById('git-commit-description-toggle');
  const toggleLabel = toggle?.querySelector('.git-commit-description-toggle-label');
  const hasDescriptionText = Boolean(description?.value.trim() || _commitDescription.trim());
  const shouldShow = Boolean(visible || hasDescriptionText);

  if (summary) summary.classList.toggle('has-description', shouldShow);
  if (description) description.classList.toggle('visible', shouldShow);
  if (toggle) {
    toggle.classList.toggle('expanded', shouldShow);
    toggle.setAttribute('aria-expanded', shouldShow ? 'true' : 'false');
  }
  if (toggleLabel) {
    toggleLabel.textContent = shouldShow ? 'Hide description' : 'Add description';
  }

  _descriptionVisible = shouldShow;
}

/**
 * Update commit button enabled/disabled state
 */
function updateCommitBtnState() {
  const commitBtn = document.getElementById('git-commit-btn');
  const clearBtn = document.getElementById('git-clear-message-btn');
  if (!commitBtn) return;
  if (operationInProgress) {
    commitBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    syncRemoteButtonsState();
    return;
  }
  const hasMessage = _commitMessage.trim().length > 0;
  const hasAnyCommitText = hasMessage || _commitDescription.trim().length > 0;
  const hasStaged = (changesData.staged?.length || 0) > 0;
  const hasChanges = (
    (changesData.unstaged?.length || 0) +
    (changesData.untracked?.length || 0) +
    (changesData.conflicts?.length || 0) +
    (changesData.staged?.length || 0)
  ) > 0;
  const canCommit = _autoStageBeforeCommit ? hasChanges : hasStaged;
  commitBtn.disabled = !(hasMessage && canCommit);
  if (clearBtn) clearBtn.disabled = !hasAnyCommitText;
  syncRemoteButtonsState();
}

/**
 * Update commit area visibility and button labels
 */
function updateCommitArea() {
  const commitArea = document.getElementById('git-commit-area');
  if (!commitArea) return;

  if (currentTab !== 'changes') {
    commitArea.style.display = 'none';
    return;
  }

  // Always show commit area in changes tab
  commitArea.style.display = '';

  // Staged count
  const { staged } = changesData;
  const stagedCount = document.getElementById('git-staged-count');
  if (stagedCount) {
    stagedCount.textContent = staged.length > 0 ? `${staged.length} staged` : '';
  }

  // Commit button label
  const commitBtn = document.getElementById('git-commit-btn');
  if (commitBtn) {
    const svgHtml = commitBtn.querySelector('svg')?.outerHTML || '';
    commitBtn.innerHTML = `${svgHtml} Commit`;
  }

  syncAutoStageToggle();
  updateCommitBtnState();
  syncRemoteButtonsState();
}

/**
 * Build full commit message from summary + description
 */
function buildCommitMessage() {
  const summary = _commitMessage.trim();
  const desc = _commitDescription.trim();
  if (!summary) return '';
  return desc ? `${summary}\n\n${desc}` : summary;
}

/**
 * Clear commit inputs
 */
function clearCommitInputs() {
  _commitMessage = '';
  _commitDescription = '';
  _commitReplaceAllArmed = false;
  const summary = document.getElementById('git-commit-summary');
  const description = document.getElementById('git-commit-description');
  if (summary) summary.value = '';
  if (description) {
    description.value = '';
  }
  setDescriptionVisibility(false);
}

/**
 * Handle creating a commit (native execFile)
 */
async function handleCommit() {
  if (operationInProgress) return;
  const message = buildCommitMessage();
  if (!message) { showToast('Enter a commit message', 'error'); return false; }

  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) { showToast('No project selected', 'error'); return false; }
  setActivityPending(true);
  let operationStarted = false;
  let commitBtn = null;

  try {
    // Avoid stale UI counts by forcing a fresh git status right before commit.
    await loadChanges(true);
    updateCommitArea();

    const workingCount = (changesData.unstaged?.length || 0) + (changesData.untracked?.length || 0) + (changesData.conflicts?.length || 0);
    if (_autoStageBeforeCommit && workingCount > 0) {
      const stageAllResult = await ipcRenderer.invoke(IPC.STAGE_ALL_GIT, projectPath);
      if (stageAllResult.error) {
        showToast(stageAllResult.error, 'error');
        return false;
      }
      await loadChanges(true);
      updateCommitArea();
      showToast('Auto-staged all changes', 'info');
    }

    if (!changesData.staged || changesData.staged.length === 0) {
      showToast(_autoStageBeforeCommit ? 'No staged changes after auto-stage' : 'No staged changes', 'error');
      return false;
    }

    operationInProgress = true;
    operationStarted = true;
    commitBtn = document.getElementById('git-commit-btn');
    if (commitBtn) { commitBtn.disabled = true; commitBtn.classList.add('spinning'); }

    const result = await ipcRenderer.invoke(IPC.GIT_COMMIT, { projectPath, message });
    if (result.error) {
      showToast(result.error, 'error');
      return false;
    }
    clearCommitInputs();
    showToast('Changes committed', 'success');
    await loadChanges(true);
    updateSyncStatus();
    return true;
  } catch (err) {
    console.error('Commit failed:', err);
    const msg = err && typeof err === 'object' && 'message' in err ? String(err.message || 'Commit failed') : String(err || 'Commit failed');
    showToast(msg || 'Commit failed', 'error');
    return false;
  } finally {
    if (operationStarted) {
      operationInProgress = false;
      if (commitBtn) commitBtn.classList.remove('spinning');
    }
    setActivityPending(false);
    updateCommitBtnState();
  }
}

/**
 * Handle commit and push
 */
async function handleCommitAndPush() {
  const committed = await handleCommit();
  if (committed) handlePush();
}

/**
 * Handle amending the last commit
 */
async function handleAmendCommit() {
  if (operationInProgress) return;
  if (!confirm('Amend the last commit?\n\nIf you enter a message, it will replace the previous commit message.')) return;

  operationInProgress = true;
  const state = require('./state');
  const projectPath = state.getProjectPath();
  const message = buildCommitMessage() || undefined;

  try {
    const result = await ipcRenderer.invoke(IPC.GIT_COMMIT_AMEND, { projectPath, message });
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    clearCommitInputs();
    showToast('Commit amended', 'success');
    await loadChanges(true);
    updateSyncStatus();
  } catch (err) {
    console.error('Amend failed:', err);
    const msg = err && typeof err === 'object' && 'message' in err ? String(err.message || 'Amend failed') : String(err || 'Amend failed');
    showToast(msg || 'Amend failed', 'error');
  } finally {
    operationInProgress = false;
    updateCommitBtnState();
  }
}

/**
 * Fetch remote refs and refresh sync indicators.
 */
async function handleFetch(options = {}) {
  if (_fetchInProgress) return;
  const { silent = false, auto = false } = options;

  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) return;

  _fetchInProgress = true;
  syncRemoteButtonsState();
  try {
    const result = await ipcRenderer.invoke(IPC.GIT_FETCH, { projectPath, prune: true });
    if (result.error) {
      if (!silent) showToast(result.error, 'error');
      return;
    }

    if (!silent) {
      showToast(auto ? 'Fetched (auto)' : 'Fetched from remote', 'success');
    }
    await loadChanges(true);
    await updateSyncStatus();
  } catch {
    if (!silent) showToast('Fetch failed', 'error');
  } finally {
    _fetchInProgress = false;
    syncRemoteButtonsState();
  }
}

/**
 * Handle pull (terminal-hybrid)
 */
function handlePull() {
  if (operationInProgress || _pullInProgress) return;
  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) return;

  const { shellQuote } = require('./shellEscape');
  const branch = typeof _syncData.branch === 'string' && _syncData.branch.trim() ? _syncData.branch.trim() : null;
  const hasUpstream = Boolean(_syncData.hasUpstream);

  const pullCmd = hasUpstream
    ? 'git pull'
    : (branch ? `git pull origin ${shellQuote(branch)}` : 'git pull');
  const command = `cd ${shellQuote(projectPath)} && ${pullCmd}`;

  _pullInProgress = true;
  syncRemoteButtonsState();
  try {
    sendToTerminal(command);
    showToast(hasUpstream ? 'Pull sent to terminal' : 'No upstream configured; pull sent to terminal', 'info');
    scheduleRefresh(7000);
  } finally {
    // Terminal command execution is async; we only throttle the button briefly.
    setTimeout(() => {
      _pullInProgress = false;
      syncRemoteButtonsState();
    }, 1500);
  }
}

/**
 * Handle push (terminal-hybrid)
 */
function handlePush() {
  if (operationInProgress) return;
  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) return;

  const { shellQuote } = require('./shellEscape');
  const branch = typeof _syncData.branch === 'string' && _syncData.branch.trim() ? _syncData.branch.trim() : null;
  const hasUpstream = Boolean(_syncData.hasUpstream);
  const pushCmd = hasUpstream
    ? 'git push'
    : (branch ? `git push -u origin ${shellQuote(branch)}` : 'git push');
  const command = `cd ${shellQuote(projectPath)} && ${pushCmd}`;
  sendToTerminal(command);
  showToast(hasUpstream ? 'Push sent to terminal' : 'No upstream configured; push sent to terminal', 'info');
  scheduleRefresh(5000);
}

/**
 * Send a command to the active terminal
 */
function sendToTerminal(command) {
  if (typeof window.terminalSendCommand === 'function') {
    window.terminalSendCommand(command);
  } else {
    showToast('No terminal available', 'error');
  }
}

/**
 * Schedule a panel refresh (supplements git watcher)
 */
let _refreshTimer = null;
function scheduleRefresh(delayMs) {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    loadChanges(true);
    updateSyncStatus();
  }, delayMs);
}

/**
 * Update sync status (ahead/behind counts)
 */
async function updateSyncStatus() {
  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) return;

  try {
    const result = await ipcRenderer.invoke(IPC.GIT_AHEAD_BEHIND, projectPath);
    _syncData = result;
    renderBranchBar();
    if (currentTab === 'changes') {
      renderActivitySlot(changesData.activity || [], changesData.activityTotal || 0, getActivityRenderOptions());
    }
    updateCommitArea();
  } catch {
    // Silent fail
  }
}

/**
 * Branch bar is intentionally hidden.
 * Branch/upstream info now lives in the activity header.
 */
function renderBranchBar() {
  if (!branchBarElement) return;
  branchBarElement.innerHTML = '';
  branchBarElement.style.display = 'none';
}

module.exports = {
  init,
  show,
  hide,
  toggle,
  loadBranches,
  loadWorktrees,
  loadChanges,
  isVisible: () => isVisible,
  isChangesTabActive: () => isVisible && currentTab === 'changes'
};
