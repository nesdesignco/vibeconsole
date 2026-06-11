/**
 * Updater Modal
 * Enterprise-style update flow: shows version diff, release notes,
 * download progress, ready-to-install confirmation, and error recovery.
 *
 * Drives off the main process autoUpdater module via IPC. The modal is the
 * only place where DOWNLOAD_UPDATE / INSTALL_UPDATE / UPDATE_CANCEL are sent.
 *
 * innerHTML usage runs over output produced by renderMinimalMarkdown —
 * every interpolated value is passed through escapeHtml first, so the
 * resulting string only contains explicitly whitelisted tags.
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { escapeHtml } = require('./escapeHtml');

const DISMISS_STORAGE_KEY = 'vibe.updater.dismissedVersion';
const RELEASE_URL_TEMPLATE = 'https://github.com/nesdesignco/vibeconsole/releases/tag/v{version}';

let modal = null;
let titleEl = null;
let subtitleEl = null;
let iconEl = null;
let currentVersionEl = null;
let newVersionEl = null;
let releaseDateEl = null;
let versionRowEl = null;
let notesSectionEl = null;
let notesEl = null;
let progressSectionEl = null;
let progressLabelEl = null;
let progressPercentEl = null;
let progressFillEl = null;
let progressMetaEl = null;
let statusSectionEl = null;
let statusIconEl = null;
let statusTextEl = null;
let primaryBtn = null;
let secondaryBtn = null;
let closeBtn = null;
let releaseLinkEl = null;

let isOpen = false;
let autoOpenedVersion = null;
let currentState = {
  status: 'idle',
  updateInfo: null,
  progress: null,
  error: null,
  currentVersion: ''
};

const ICONS = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  spinner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="updater-spinning"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  uptodate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
};

function init() {
  modal = document.getElementById('updater-modal');
  if (!modal) return;

  titleEl = modal.querySelector('#updater-modal-title');
  subtitleEl = modal.querySelector('#updater-modal-subtitle');
  iconEl = modal.querySelector('#updater-modal-icon');
  currentVersionEl = modal.querySelector('#updater-current-version');
  newVersionEl = modal.querySelector('#updater-new-version');
  releaseDateEl = modal.querySelector('#updater-release-date');
  versionRowEl = modal.querySelector('#updater-version-row');
  notesSectionEl = modal.querySelector('#updater-notes-section');
  notesEl = modal.querySelector('#updater-release-notes');
  progressSectionEl = modal.querySelector('#updater-progress-section');
  progressLabelEl = modal.querySelector('#updater-progress-label');
  progressPercentEl = modal.querySelector('#updater-progress-percent');
  progressFillEl = modal.querySelector('#updater-progress-fill');
  progressMetaEl = modal.querySelector('#updater-progress-meta');
  statusSectionEl = modal.querySelector('#updater-status-section');
  statusIconEl = modal.querySelector('#updater-status-icon');
  statusTextEl = modal.querySelector('#updater-status-text');
  primaryBtn = modal.querySelector('#updater-btn-primary');
  secondaryBtn = modal.querySelector('#updater-btn-secondary');
  closeBtn = modal.querySelector('#updater-modal-close');
  releaseLinkEl = modal.querySelector('#updater-release-link');

  setupListeners();
  setupIpcSubscriptions();
  refreshStateFromMain();
}

function setupListeners() {
  closeBtn.addEventListener('click', () => {
    if (canDismiss()) closeModal();
  });
  secondaryBtn.addEventListener('click', () => handleSecondary());
  primaryBtn.addEventListener('click', () => handlePrimary());

  modal.addEventListener('click', (e) => {
    if (e.target !== modal) return;
    if (canDismiss()) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'Escape' && canDismiss()) {
      closeModal();
    }
  });

  releaseLinkEl.addEventListener('click', (e) => {
    e.preventDefault();
    const href = releaseLinkEl.getAttribute('data-href') || releaseLinkEl.href;
    if (href && href !== '#') {
      ipcRenderer.send(IPC.OPEN_EXTERNAL_URL, href);
    }
  });
}

function setupIpcSubscriptions() {
  ipcRenderer.on(IPC.UPDATE_CHECKING, () => {
    currentState.status = 'checking';
    currentState.error = null;
    render();
  });

  ipcRenderer.on(IPC.UPDATE_AVAILABLE, (event, info) => {
    currentState.status = 'available';
    currentState.updateInfo = info;
    currentState.progress = null;
    currentState.error = null;
    render();
    maybeAutoOpen(info);
  });

  ipcRenderer.on(IPC.UPDATE_NOT_AVAILABLE, (event, data) => {
    if (currentState.status === 'downloading' || currentState.status === 'downloaded') return;
    currentState.status = 'not-available';
    if (data && data.currentVersion) currentState.currentVersion = data.currentVersion;
    render();
  });

  ipcRenderer.on(IPC.UPDATE_DOWNLOAD_PROGRESS, (event, progress) => {
    currentState.status = 'downloading';
    currentState.progress = progress;
    // Progress ticks are frequent; skip DOM work while the modal is hidden
    // (openModal() renders from currentState anyway).
    if (isOpen) render();
  });

  ipcRenderer.on(IPC.UPDATE_DOWNLOADED, (event, info) => {
    currentState.status = 'downloaded';
    if (info) currentState.updateInfo = info;
    render();
  });

  ipcRenderer.on(IPC.UPDATE_CANCELLED, () => {
    if (currentState.updateInfo) {
      currentState.status = 'available';
    } else {
      currentState.status = 'idle';
    }
    currentState.progress = null;
    render();
  });

  ipcRenderer.on(IPC.UPDATE_ERROR, (event, data) => {
    currentState.status = 'error';
    currentState.error = data || { message: 'Unknown update error' };
    render();
  });

  ipcRenderer.on(IPC.OPEN_UPDATER_MODAL, () => {
    openModal();
  });
}

async function refreshStateFromMain() {
  try {
    const remote = await ipcRenderer.invoke(IPC.GET_UPDATE_STATE);
    if (!remote) return;
    currentState.currentVersion = remote.currentVersion || currentState.currentVersion;
    if (remote.status && remote.status !== 'idle') {
      currentState.status = remote.status;
      currentState.updateInfo = remote.updateInfo || currentState.updateInfo;
      currentState.progress = remote.progress || currentState.progress;
      currentState.error = remote.error || currentState.error;
    }
    render();
  } catch {
    render();
  }
}

function maybeAutoOpen(info) {
  if (!info || !info.version) return;
  // Hourly checks re-emit update-available; auto-open at most once per
  // version per session so a closed modal doesn't keep popping back up.
  if (autoOpenedVersion === info.version) return;
  try {
    const dismissed = localStorage.getItem(DISMISS_STORAGE_KEY);
    if (dismissed === info.version) return;
  } catch { /* localStorage may be unavailable; fall through and open. */ }
  autoOpenedVersion = info.version;
  openModal();
}

function openModal() {
  if (!modal) return;
  isOpen = true;
  modal.classList.add('visible');
  refreshStateFromMain();
  render();
}

function closeModal() {
  if (!modal) return;
  isOpen = false;
  modal.classList.remove('visible');
}

function canDismiss() {
  return currentState.status !== 'downloading';
}

function handlePrimary() {
  switch (currentState.status) {
    case 'available':
      ipcRenderer.send(IPC.DOWNLOAD_UPDATE);
      currentState.status = 'downloading';
      currentState.progress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 };
      render();
      break;
    case 'downloaded':
      ipcRenderer.send(IPC.INSTALL_UPDATE);
      break;
    case 'error':
      currentState.status = 'checking';
      currentState.error = null;
      render();
      ipcRenderer.invoke(IPC.CHECK_FOR_UPDATES).catch(() => { /* surfaced via UPDATE_ERROR */ });
      break;
    case 'not-available':
      closeModal();
      break;
    default:
      break;
  }
}

function handleSecondary() {
  switch (currentState.status) {
    case 'available':
      if (currentState.updateInfo && currentState.updateInfo.version) {
        try { localStorage.setItem(DISMISS_STORAGE_KEY, currentState.updateInfo.version); }
        catch { /* ignore */ }
      }
      closeModal();
      break;
    case 'downloading':
      ipcRenderer.send(IPC.UPDATE_CANCEL);
      break;
    case 'downloaded':
      closeModal();
      break;
    case 'error':
      closeModal();
      break;
    default:
      closeModal();
      break;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

function formatReleaseDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function normalizeReleaseNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes.map(n => {
      if (!n) return '';
      const ver = n.version ? `## ${n.version}\n` : '';
      return ver + (n.note || '');
    }).filter(Boolean).join('\n\n');
  }
  return '';
}

function renderMinimalMarkdown(raw) {
  if (!raw) return '<div class="updater-notes-empty">No release notes provided.</div>';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const renderInline = (text) => {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
    s = s.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, (_m, p, c) => `${p}<em>${c}</em>`);
    return s;
  };

  for (const line of lines) {
    const ulMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    const olMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
    const headingMatch = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (ulMatch) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${renderInline(ulMatch[1])}</li>`);
    } else if (olMatch) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${renderInline(olMatch[1])}</li>`);
    } else if (headingMatch) {
      closeList();
      out.push(`<div class="updater-notes-heading-inline"><strong>${renderInline(headingMatch[1])}</strong></div>`);
    } else if (line.trim() === '') {
      closeList();
      out.push('<br>');
    } else {
      closeList();
      out.push(`<div>${renderInline(line)}</div>`);
    }
  }
  closeList();
  return out.join('');
}

function setIcon(target, html, modifier) {
  target.className = modifier ? `updater-modal-icon ${modifier}` : 'updater-modal-icon';
  target.innerHTML = html;
}

function setStatusIcon(html) {
  statusIconEl.innerHTML = html;
}

function showVersionRow(show) {
  versionRowEl.style.display = show ? 'flex' : 'none';
}
function showNotesSection(show) {
  notesSectionEl.style.display = show ? 'flex' : 'none';
}
function showProgressSection(show) {
  progressSectionEl.style.display = show ? 'flex' : 'none';
}
function showStatusSection(show, modifier) {
  if (!show) {
    statusSectionEl.style.display = 'none';
    statusSectionEl.className = 'updater-status-section';
    return;
  }
  statusSectionEl.style.display = 'flex';
  statusSectionEl.className = modifier ? `updater-status-section ${modifier}` : 'updater-status-section';
}

function renderReleaseNotes(info) {
  const text = normalizeReleaseNotes(info && info.releaseNotes);
  notesEl.innerHTML = renderMinimalMarkdown(text);
}

function render() {
  if (!modal) return;

  currentVersionEl.textContent = currentState.currentVersion || '—';
  const newVersion = currentState.updateInfo && currentState.updateInfo.version;
  newVersionEl.textContent = newVersion || '—';
  releaseDateEl.textContent = formatReleaseDate(currentState.updateInfo && currentState.updateInfo.releaseDate);

  showVersionRow(false);
  showNotesSection(false);
  showProgressSection(false);
  showStatusSection(false);
  releaseLinkEl.style.display = 'none';
  primaryBtn.disabled = false;
  secondaryBtn.disabled = false;
  closeBtn.disabled = false;
  primaryBtn.style.display = '';
  secondaryBtn.style.display = '';

  switch (currentState.status) {
    case 'checking':
      setIcon(iconEl, ICONS.spinner, 'checking');
      titleEl.textContent = 'Checking for updates…';
      subtitleEl.textContent = `Current version ${currentState.currentVersion || ''}`.trim();
      primaryBtn.style.display = 'none';
      secondaryBtn.textContent = 'Close';
      break;

    case 'available':
      setIcon(iconEl, ICONS.download, '');
      titleEl.textContent = 'Update available';
      subtitleEl.textContent = newVersion
        ? `Vibe Console ${newVersion} is ready to install`
        : 'A new version is ready';
      showVersionRow(true);
      showNotesSection(true);
      renderReleaseNotes(currentState.updateInfo);
      primaryBtn.textContent = 'Download';
      secondaryBtn.textContent = 'Later';
      if (newVersion) {
        const href = RELEASE_URL_TEMPLATE.replace('{version}', encodeURIComponent(newVersion));
        releaseLinkEl.setAttribute('data-href', href);
        releaseLinkEl.style.display = '';
        releaseLinkEl.textContent = 'View release';
      }
      break;

    case 'downloading': {
      setIcon(iconEl, ICONS.spinner, 'checking');
      titleEl.textContent = 'Downloading update…';
      subtitleEl.textContent = newVersion ? `Version ${newVersion}` : '';
      showVersionRow(true);
      showProgressSection(true);
      const p = currentState.progress || { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 };
      progressLabelEl.textContent = 'Downloading…';
      progressPercentEl.textContent = `${p.percent || 0}%`;
      progressFillEl.style.width = `${Math.min(100, Math.max(0, p.percent || 0))}%`;
      progressFillEl.classList.toggle('indeterminate', !p.total);
      const speed = p.bytesPerSecond ? `${formatBytes(p.bytesPerSecond)}/s` : '';
      const sizes = p.total ? `${formatBytes(p.transferred)} / ${formatBytes(p.total)}` : '';
      const eta = p.bytesPerSecond && p.total
        ? formatDuration((p.total - p.transferred) / p.bytesPerSecond)
        : '';
      const metaParts = [sizes, speed, eta ? `${eta} remaining` : ''].filter(Boolean);
      progressMetaEl.textContent = metaParts.join(' · ');
      primaryBtn.style.display = 'none';
      secondaryBtn.textContent = 'Cancel';
      closeBtn.disabled = true;
      break;
    }

    case 'downloaded':
      setIcon(iconEl, ICONS.check, 'success');
      titleEl.textContent = 'Update downloaded';
      subtitleEl.textContent = 'Restart to install the new version';
      showVersionRow(true);
      showStatusSection(true, 'success');
      setStatusIcon(ICONS.check);
      statusTextEl.textContent = newVersion
        ? `Vibe Console ${newVersion} is ready. It will install automatically next time you quit, or restart now to apply immediately.`
        : 'The update is ready to install.';
      primaryBtn.textContent = 'Restart now';
      secondaryBtn.textContent = 'Later';
      break;

    case 'error':
      setIcon(iconEl, ICONS.error, 'error');
      titleEl.textContent = 'Update failed';
      subtitleEl.textContent = 'Something went wrong while updating';
      if (currentState.updateInfo) showVersionRow(true);
      showStatusSection(true, 'error');
      setStatusIcon(ICONS.error);
      statusTextEl.textContent = (currentState.error && currentState.error.message)
        || 'An unknown error occurred. Please try again.';
      primaryBtn.textContent = 'Retry';
      secondaryBtn.textContent = 'Close';
      if (newVersion) {
        const href = RELEASE_URL_TEMPLATE.replace('{version}', encodeURIComponent(newVersion));
        releaseLinkEl.setAttribute('data-href', href);
        releaseLinkEl.style.display = '';
        releaseLinkEl.textContent = 'Download manually';
      }
      break;

    case 'not-available':
      setIcon(iconEl, ICONS.uptodate, 'success');
      titleEl.textContent = 'You are up to date';
      subtitleEl.textContent = currentState.currentVersion
        ? `Running Vibe Console ${currentState.currentVersion}`
        : 'You have the latest version';
      primaryBtn.style.display = 'none';
      secondaryBtn.textContent = 'Close';
      break;

    case 'idle':
    default:
      setIcon(iconEl, ICONS.uptodate, '');
      titleEl.textContent = 'Vibe Console';
      subtitleEl.textContent = currentState.currentVersion
        ? `Version ${currentState.currentVersion}`
        : '';
      primaryBtn.style.display = 'none';
      secondaryBtn.textContent = 'Close';
      break;
  }
}

function getStatus() {
  return currentState.status;
}

module.exports = {
  init,
  openModal,
  closeModal,
  getStatus
};
