/**
 * Git Diff Viewer Module
 * Handles diff modal display, parsing, rendering, and hunk operations
 *
 * Note: innerHTML usage below is safe — all user-provided data is sanitized
 * through escapeHtml() and escapeAttr() before interpolation.
 */

const { ipcRenderer, pathApi } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { escapeHtml, escapeAttr } = require('./escapeHtml');

// Module state
let _diffViewMode = 'split';
let _currentDiffState = null;
let _diffSearchQuery = '';
let _diffHideContext = false;
let _selectedHunkIndex = -1;
let _hunkActionInProgress = false;

// Callbacks (set by init)
let _showToast = () => {};
let _loadChanges = () => {};

function init({ showToast, loadChanges }) {
  _showToast = showToast;
  _loadChanges = loadChanges;
  setupDiffModalListeners();
}

function getDiffViewMode() {
  return _diffViewMode;
}

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
    hunkSelect.textContent = '';
    stageBtn.disabled = true;
    unstageBtn.disabled = true;
    discardBtn.disabled = true;
    return;
  }

  hunkSelect.textContent = '';
  if (hasHunks) {
    state.hunks.forEach((h, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      const location = h.oldStart != null && h.newStart != null ? `L${h.oldStart}\u2192${h.newStart}` : h.header;
      opt.textContent = `Hunk ${idx + 1} (${location})`;
      hunkSelect.appendChild(opt);
    });
  } else {
    const opt = document.createElement('option');
    opt.value = '-1';
    opt.textContent = 'No hunks';
    hunkSelect.appendChild(opt);
  }

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
      _showToast(result.error, 'error');
      return;
    }
    _showToast(`Hunk ${action}d`, 'success');
    await _loadChanges(true);
    await showDiffModal(filePath, diffType);
  } catch {
    _showToast(`Failed to ${action} hunk`, 'error');
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
  const bodyEl = modal.querySelector('.diff-modal-body');
  bodyEl.textContent = '';
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'github-loading';
  loadingDiv.innerHTML = '<div class="github-loading-spinner"></div>';
  const loadingP = document.createElement('p');
  loadingP.textContent = 'Loading diff...';
  loadingDiv.appendChild(loadingP);
  bodyEl.appendChild(loadingDiv);
  modal.querySelector('.diff-modal-stats').textContent = '';
  const badge = modal.querySelector('.diff-modal-status-badge');
  badge.textContent = diffType;
  badge.className = `diff-modal-status-badge ${diffType}`;
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
      bodyEl.textContent = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'github-error';
      const errP = document.createElement('p');
      errP.textContent = result.error;
      errDiv.appendChild(errP);
      bodyEl.appendChild(errDiv);
      return;
    }

    if (result.diff === 'Binary file') {
      bodyEl.textContent = '';
      const binDiv = document.createElement('div');
      binDiv.className = 'diff-binary-message';
      binDiv.textContent = 'Binary file - cannot display diff';
      bodyEl.appendChild(binDiv);
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
    renderDiffContent(bodyEl, lines);
    const statsEl = modal.querySelector('.diff-modal-stats');
    statsEl.textContent = '';
    const addSpan = document.createElement('span');
    addSpan.className = 'diff-stat-add';
    addSpan.textContent = `+${additions}`;
    const delSpan = document.createElement('span');
    delSpan.className = 'diff-stat-del';
    delSpan.textContent = `-${deletions}`;
    statsEl.appendChild(addSpan);
    statsEl.appendChild(delSpan);
  } catch (err) {
    console.error('Error loading diff:', err);
    bodyEl.textContent = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'github-error';
    const errP = document.createElement('p');
    errP.textContent = 'Failed to load diff';
    errDiv.appendChild(errP);
    bodyEl.appendChild(errDiv);
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

  const shortHash = commitHash.substring(0, 7);
  modal.querySelector('.diff-modal-filename').textContent = `Commit ${shortHash}`;
  modal.querySelector('.diff-modal-path').textContent = commitHash;
  const bodyEl = modal.querySelector('.diff-modal-body');
  bodyEl.textContent = '';
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'github-loading';
  loadingDiv.innerHTML = '<div class="github-loading-spinner"></div>';
  const loadingP = document.createElement('p');
  loadingP.textContent = 'Loading commit diff...';
  loadingDiv.appendChild(loadingP);
  bodyEl.appendChild(loadingDiv);
  modal.querySelector('.diff-modal-stats').textContent = '';
  const badge = modal.querySelector('.diff-modal-status-badge');
  badge.textContent = 'commit';
  badge.className = 'diff-modal-status-badge commit';
  clearCurrentDiffState();
  setDiffViewMode(_diffViewMode);
  syncDiffSearchControls();

  const editBtn = modal.querySelector('.diff-modal-edit-btn');
  if (editBtn) editBtn.style.display = 'none';

  modal.classList.add('visible');

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_COMMIT_DIFF, { projectPath, commitHash });

    if (result.error) {
      bodyEl.textContent = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'github-error';
      const errP = document.createElement('p');
      errP.textContent = result.error;
      errDiv.appendChild(errP);
      bodyEl.appendChild(errDiv);
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
    renderDiffContent(bodyEl, lines);
    const statsEl = modal.querySelector('.diff-modal-stats');
    statsEl.textContent = '';
    const addSpan = document.createElement('span');
    addSpan.className = 'diff-stat-add';
    addSpan.textContent = `+${additions}`;
    const delSpan = document.createElement('span');
    delSpan.className = 'diff-stat-del';
    delSpan.textContent = `-${deletions}`;
    statsEl.appendChild(addSpan);
    statsEl.appendChild(delSpan);
  } catch (err) {
    console.error('Error loading commit diff:', err);
    bodyEl.textContent = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'github-error';
    const errP = document.createElement('p');
    errP.textContent = 'Failed to load commit diff';
    errDiv.appendChild(errP);
    bodyEl.appendChild(errDiv);
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
  const bodyEl = modal.querySelector('.diff-modal-body');
  bodyEl.textContent = '';
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'github-loading';
  loadingDiv.innerHTML = '<div class="github-loading-spinner"></div>';
  const loadingP = document.createElement('p');
  loadingP.textContent = 'Loading stash diff...';
  loadingDiv.appendChild(loadingP);
  bodyEl.appendChild(loadingDiv);
  modal.querySelector('.diff-modal-stats').textContent = '';
  const badge = modal.querySelector('.diff-modal-status-badge');
  badge.textContent = 'stash';
  badge.className = 'diff-modal-status-badge stash';
  clearCurrentDiffState();
  setDiffViewMode(_diffViewMode);
  syncDiffSearchControls();

  const editBtn = modal.querySelector('.diff-modal-edit-btn');
  if (editBtn) editBtn.style.display = 'none';

  modal.classList.add('visible');

  try {
    const result = await ipcRenderer.invoke(IPC.STASH_SHOW, { projectPath, stashRef });

    if (result.error) {
      bodyEl.textContent = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'github-error';
      const errP = document.createElement('p');
      errP.textContent = result.error;
      errDiv.appendChild(errP);
      bodyEl.appendChild(errDiv);
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
    renderDiffContent(bodyEl, lines);
    const statsEl = modal.querySelector('.diff-modal-stats');
    statsEl.textContent = '';
    const addSpan = document.createElement('span');
    addSpan.className = 'diff-stat-add';
    addSpan.textContent = `+${additions}`;
    const delSpan = document.createElement('span');
    delSpan.className = 'diff-stat-del';
    delSpan.textContent = `-${deletions}`;
    statsEl.appendChild(addSpan);
    statsEl.appendChild(delSpan);
  } catch (err) {
    console.error('Error loading stash diff:', err);
    bodyEl.textContent = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'github-error';
    const errP = document.createElement('p');
    errP.textContent = 'Failed to load stash diff';
    errDiv.appendChild(errP);
    bodyEl.appendChild(errDiv);
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
      lines.push({ type: 'context', content: line.startsWith(' ') ? line.substring(1) : line, oldNum: oldLineNum, newNum: newLineNum, hunkIndex });
      oldLineNum++;
      newLineNum++;
    }
  }

  return { lines, additions, deletions };
}

/**
 * Render parsed diff content into the modal body.
 * All interpolated values are escaped via escapeHtml/escapeAttr — safe for innerHTML.
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
    const baseClass = `diff-line diff-${escapeAttr(line.type)}${selectedClass}`;
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

  // Safe: all values escaped above
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
    return `<div class="diff-split-cell ${escapeAttr(side)} empty"><span class="diff-split-num"></span><span class="diff-split-text"></span></div>`;
  }
  const num = side === 'old' ? line.oldNum : line.newNum;
  const text = contentHtml != null
    ? contentHtml
    : escapeHtml(`${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.content}`);
  return `<div class="diff-split-cell ${escapeAttr(side)}"><span class="diff-split-num">${num !== '' ? num : ''}</span><span class="diff-split-text">${text}</span></div>`;
}

/**
 * Render split diff view. All interpolated values are escaped — safe for innerHTML.
 */
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
      return `<div class="diff-split-row meta diff-${escapeAttr(row.line.type)}${selectedClass}"${hunkAttr}><div class="diff-split-meta">${escapeHtml(row.line.content)}</div></div>`;
    }

    let oldSide = renderSplitSide(row.oldLine, 'old');
    let newSide = renderSplitSide(row.newLine, 'new');
    if (row.rowType === 'modify' && row.oldLine && row.newLine) {
      const highlighted = highlightModifiedPair(row.oldLine.content, row.newLine.content);
      oldSide = renderSplitSide(row.oldLine, 'old', highlighted.oldHtml);
      newSide = renderSplitSide(row.newLine, 'new', highlighted.newHtml);
    }

    return `
      <div class="diff-split-row ${escapeAttr(row.rowType)}${selectedClass}">
        ${oldSide}
        ${newSide}
      </div>
    `;
  }).join('');

  // Safe: all values escaped above
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
 * Setup diff modal event listeners
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

module.exports = {
  init,
  showDiffModal,
  showCommitDiffModal,
  showStashDiffModal,
  hideDiffModal,
  parseDiff,
  getDiffViewMode,
  setDiffViewMode
};
