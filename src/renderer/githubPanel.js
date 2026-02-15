/**
 * GitHub Panel Module
 * UI for displaying GitHub issues, branches, and worktrees
 */

const { ipcRenderer, pathApi } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { createPanelHeaderDropdown } = require('./panelHeaderDropdown');
const gitDiffViewer = require('./gitDiffViewer');
const gitActivityHeatmap = require('./gitActivityHeatmap');
const gitConflictResolver = require('./gitConflictResolver');
const gitBranchesTab = require('./gitBranchesTab');
const gitWorktreesTab = require('./gitWorktreesTab');

let isVisible = false;
let gitAutoRefreshInterval = null;
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
let _fetchInProgress = false;
let _pullInProgress = false;
let _lastAutoFetchAt = 0;
let _activityPending = false;

const AUTO_FETCH_INTERVAL_MS = 30000;

// Load deduplication: generation counters discard stale IPC responses,
// _hasData flags prevent showing the loading spinner on subsequent refreshes.
let _changesGeneration = 0;
let _hasChangesData = false;

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
  loadAutoStagePreference();
  setupCommitArea();
  setupGitWatcher();

  // Initialize submodules
  const submoduleCallbacks = { showToast, loadChanges };
  gitDiffViewer.init(submoduleCallbacks);
  gitConflictResolver.init(submoduleCallbacks);
  gitBranchesTab.init({
    showToast,
    renderLoading,
    getContentElement: () => contentElement
  });
  gitWorktreesTab.init({
    showToast,
    renderLoading,
    getContentElement: () => contentElement
  });

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
    _lastChangesHash = null;
    gitBranchesTab.resetData();
    gitWorktreesTab.resetData();
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
      gitBranchesTab.loadBranches();
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
      await gitBranchesTab.loadBranches();
      showToast('Branches refreshed', 'success');
    } else if (currentTab === 'worktrees') {
      await gitWorktreesTab.loadWorktrees();
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
    gitBranchesTab.loadBranches();
  } else if (tab === 'worktrees') {
    gitWorktreesTab.loadWorktrees();
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

  const activityHtml = gitActivityHeatmap.renderActivityHeatmapSection(activity, totalHint, options);
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
            <button class="git-section-action-btn discard" data-action="discard-all" title="Discard all unstaged changes"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>
            <button class="git-section-action-btn stash" data-action="stash-all" title="Stash all changes"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg></button>
            <button class="git-section-action-btn stage" data-action="stage-all" title="Stage all">+</button>
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
            <button class="git-section-action-btn unstage" data-action="unstage-all" title="Unstage all">−</button>
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
        gitConflictResolver.showConflictModal(filePath);
      } else {
        gitDiffViewer.showDiffModal(filePath, diffType);
      }
    });
  });

  // Click on commit -> open commit diff modal
  contentElement.querySelectorAll('.git-commit-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.git-commit-action-btn')) return;
      const hash = item.dataset.hash;
      gitDiffViewer.showCommitDiffModal(hash);
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
      gitDiffViewer.showStashDiffModal(ref);
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
  if (committed) await handlePush();
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
 * Handle pull (IPC background)
 */
async function handlePull() {
  if (operationInProgress || _pullInProgress) return;
  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) return;

  const branch = typeof _syncData.branch === 'string' && _syncData.branch.trim() ? _syncData.branch.trim() : null;
  const hasUpstream = Boolean(_syncData.hasUpstream);

  _pullInProgress = true;
  operationInProgress = true;
  syncRemoteButtonsState();
  updateCommitBtnState();

  try {
    const result = await ipcRenderer.invoke(IPC.GIT_PULL, {
      projectPath,
      branch,
      noUpstream: !hasUpstream
    });
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast('Pulled from remote', 'success');
    await loadChanges(true);
    updateSyncStatus();
  } catch (err) {
    console.error('Pull failed:', err);
    showToast('Pull failed', 'error');
  } finally {
    _pullInProgress = false;
    operationInProgress = false;
    syncRemoteButtonsState();
    updateCommitBtnState();
  }
}

/**
 * Handle push (IPC background)
 */
async function handlePush() {
  if (operationInProgress) return;
  const state = require('./state');
  const projectPath = state.getProjectPath();
  if (!projectPath) return;

  const branch = typeof _syncData.branch === 'string' && _syncData.branch.trim() ? _syncData.branch.trim() : null;
  const hasUpstream = Boolean(_syncData.hasUpstream);

  operationInProgress = true;
  syncRemoteButtonsState();
  updateCommitBtnState();

  try {
    const result = await ipcRenderer.invoke(IPC.GIT_PUSH, {
      projectPath,
      branch,
      setUpstream: !hasUpstream
    });
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast('Pushed to remote', 'success');
    await loadChanges(true);
    updateSyncStatus();
  } catch (err) {
    console.error('Push failed:', err);
    showToast('Push failed', 'error');
  } finally {
    operationInProgress = false;
    syncRemoteButtonsState();
    updateCommitBtnState();
  }
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
  loadChanges,
  isVisible: () => isVisible,
  isChangesTabActive: () => isVisible && currentTab === 'changes'
};
