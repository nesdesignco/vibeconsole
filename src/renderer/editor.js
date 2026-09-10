/**
 * File Editor Module
 * Overlay editor for viewing and editing files
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } = require('../shared/mediaTypes');
const state = require('./state');
const codeEditor = require('./monacoEditor');
const { renderEditorIcons } = require('./lucideIcons');

let editorOverlay = null;
let editorContainer = null;
let editorTextarea = null;
let editorCode = null;
let editorFilename = null;
let editorExt = null;
let editorPath = null;
let editorStatus = null;
let editorPreview = null;
let editorImage = null;
let editorToolbar = null;
let editorCommandPalette = null;
let editorCommandInput = null;
let editorCommandList = null;
let editorViewToggles = null;
let btnViewPreview = null;
let btnViewText = null;
let btnSave = null;
let btnFullscreen = null;
let btnWrap = null;
let btnMinimap = null;

let currentEditingFile = null;
let originalContent = '';
let isModified = false;
let onFileTreeRefreshCallback = null;
let openedFromSource = null; // Track where the file was opened from ('fileTree', 'terminal', etc.)
let pendingLineNav = null; // { line, col } to navigate to after file loads
let pendingOpenRequest = null;
let activeOpenRequestId = null;
let editingProjectPath = null;
let nextRequestId = 0;
let textContentLoaded = false;
let lastSavedRequestId = 0;
const pendingSaves = new Map();
let currentMode = 'text'; // 'text' | 'image'
let isFullscreen = false;
let visibleCommands = [];
let activeCommandIndex = 0;

/**
 * Initialize editor module
 */
function init(onRefreshFileTree) {
  editorOverlay = document.getElementById('editor-overlay');
  editorContainer = document.getElementById('editor-container');
  editorTextarea = document.getElementById('editor-textarea');
  editorCode = document.getElementById('editor-code');
  editorFilename = document.getElementById('editor-filename');
  editorExt = document.getElementById('editor-ext');
  editorPath = document.getElementById('editor-path');
  editorStatus = document.getElementById('editor-status');
  editorPreview = document.getElementById('editor-preview');
  editorImage = document.getElementById('editor-image');
  editorToolbar = document.getElementById('editor-toolbar');
  editorCommandPalette = document.getElementById('editor-command-palette');
  editorCommandInput = document.getElementById('editor-command-input');
  editorCommandList = document.getElementById('editor-command-list');
  editorViewToggles = document.getElementById('editor-view-toggles');
  btnViewPreview = document.getElementById('btn-editor-view-preview');
  btnViewText = document.getElementById('btn-editor-view-text');
  btnSave = document.getElementById('btn-editor-save');
  btnFullscreen = document.getElementById('btn-editor-fullscreen');
  btnWrap = document.getElementById('btn-editor-wrap');
  btnMinimap = document.getElementById('btn-editor-minimap');
  onFileTreeRefreshCallback = onRefreshFileTree;

  renderEditorIcons(editorContainer || document);
  setupEventHandlers();
  setupIPC();

  try {
    const ready = codeEditor.init(editorCode, {
      onChange: checkModified,
      onSave: saveFile,
      onClose: closeEditor,
      onCommandPalette: showCommandPalette,
      onCursorChange: updateCursorStatus
    });
    if (ready && editorTextarea) {
      editorTextarea.setAttribute('aria-hidden', 'true');
    }
    syncEditorToolState();
  } catch (err) {
    console.error('Failed to initialize Monaco editor, falling back to textarea:', err);
    if (editorCode) editorCode.style.display = 'none';
    if (editorTextarea) editorTextarea.style.display = 'block';
  }
}

function getExtensionFromPath(filePath) {
  const base = ((filePath || '').replace(/\\/g, '/')).split('/').pop() || '';
  const idx = base.lastIndexOf('.');
  if (idx === -1) return '';
  return base.slice(idx + 1).toLowerCase();
}

function isImageExt(extension) {
  return IMAGE_EXTENSIONS.includes((extension || '').toLowerCase());
}

function setViewTogglesVisible(visible) {
  if (!editorViewToggles) return;
  editorViewToggles.style.display = visible ? 'flex' : 'none';
}

function setActiveToggle(mode) {
  if (!btnViewPreview || !btnViewText) return;
  const activeBg = 'var(--bg-secondary)';
  const inactiveBg = 'transparent';
  if (mode === 'image') {
    btnViewPreview.style.background = activeBg;
    btnViewText.style.background = inactiveBg;
  } else {
    btnViewPreview.style.background = inactiveBg;
    btnViewText.style.background = activeBg;
  }
}

function setMode(mode) {
  currentMode = mode;
  const showText = mode === 'text';
  const useMonaco = codeEditor.isReady();
  if (!showText) hideCommandPalette(false);
  if (editorCode) editorCode.style.display = (showText && useMonaco) ? 'block' : 'none';
  if (editorTextarea) editorTextarea.style.display = (showText && !useMonaco) ? 'block' : 'none';
  if (editorToolbar) editorToolbar.style.display = (showText && useMonaco) ? 'flex' : 'none';
  if (editorPreview) editorPreview.style.display = (mode === 'image') ? 'flex' : 'none';
  if (btnSave) {
    const enableSave = (mode === 'text');
    btnSave.disabled = !enableSave;
    btnSave.style.display = enableSave ? '' : 'none';
  }
  setActiveToggle(mode);
  if (showText && useMonaco) {
    setTimeout(() => codeEditor.layout(), 0);
  }
  syncEditorToolState();
}

function getEditorContent() {
  if (codeEditor.isReady()) return codeEditor.getValue();
  return editorTextarea ? editorTextarea.value : '';
}

function setEditorContent(content, filePath, extension) {
  if (codeEditor.isReady()) {
    codeEditor.setDocument({
      content,
      filePath,
      extension,
      line: pendingLineNav && pendingLineNav.line,
      col: pendingLineNav && pendingLineNav.col
    });
  }
  if (editorTextarea) editorTextarea.value = content || '';
}

function focusTextEditor() {
  if (codeEditor.isReady()) {
    codeEditor.focus();
  } else if (editorTextarea) {
    editorTextarea.focus();
  }
}

function syncEditorToolState() {
  if (btnWrap || btnMinimap) {
    const viewState = codeEditor.getViewState ? codeEditor.getViewState() : { wordWrap: false, minimap: false };
    if (btnWrap) btnWrap.setAttribute('aria-pressed', viewState.wordWrap ? 'true' : 'false');
    if (btnMinimap) btnMinimap.setAttribute('aria-pressed', viewState.minimap ? 'true' : 'false');
  }

  if (btnFullscreen) {
    const maxIcon = btnFullscreen.querySelector('[data-fullscreen-icon="max"]');
    const minIcon = btnFullscreen.querySelector('[data-fullscreen-icon="min"]');
    btnFullscreen.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
    btnFullscreen.title = isFullscreen ? 'Return to modal size' : 'Use full app space';
    btnFullscreen.setAttribute('aria-label', btnFullscreen.title);
    if (maxIcon) maxIcon.hidden = isFullscreen;
    if (minIcon) minIcon.hidden = !isFullscreen;
  }
}

function setFullscreen(enabled) {
  isFullscreen = Boolean(enabled);
  if (editorOverlay) {
    editorOverlay.classList.toggle('editor-overlay-fullscreen', isFullscreen);
  }
  if (editorContainer) {
    editorContainer.classList.toggle('fullscreen', isFullscreen);
  }
  syncEditorToolState();
  setTimeout(() => codeEditor.layout(), 0);
}

function runEditorAction(actionId, fallbackStatus) {
  if (!codeEditor.isReady()) return;
  codeEditor.runAction(actionId).then((ran) => {
    if (!ran && fallbackStatus) {
      updateStatus(fallbackStatus, '');
    }
  }).catch((err) => {
    console.error(`Editor action failed: ${actionId}`, err);
    updateStatus(fallbackStatus || 'Editor action failed', fallbackStatus ? '' : 'modified');
  });
}

function getCommandDefinitions() {
  const viewState = codeEditor.getViewState ? codeEditor.getViewState() : { wordWrap: false, minimap: false };
  return [
    { id: 'save', icon: 'save', title: 'Save File', detail: 'Write current file to disk', shortcut: 'Cmd+S', run: saveFile },
    { id: 'find', icon: 'search', title: 'Find', detail: 'Search in current file', shortcut: 'Cmd+F', run: () => runEditorAction('actions.find', 'Find is not available') },
    { id: 'replace', icon: 'replace', title: 'Replace', detail: 'Find and replace in current file', shortcut: 'Cmd+Alt+F', run: () => runEditorAction('editor.action.startFindReplaceAction', 'Replace is not available') },
    { id: 'line', icon: 'list', title: 'Go to Line', detail: 'Jump to line or line:column', shortcut: 'Line', run: showGoToLinePrompt },
    { id: 'format', icon: 'wand-sparkles', title: 'Format Document', detail: 'Run available formatter', shortcut: 'Fmt', run: () => runEditorAction('editor.action.formatDocument', 'No formatter available for this file') },
    { id: 'undo', icon: 'undo-2', title: 'Undo', detail: 'Undo last edit', shortcut: 'Cmd+Z', run: () => codeEditor.undo() },
    { id: 'redo', icon: 'redo-2', title: 'Redo', detail: 'Redo last edit', shortcut: 'Shift+Cmd+Z', run: () => codeEditor.redo() },
    { id: 'wrap', icon: 'wrap-text', title: 'Toggle Word Wrap', detail: viewState.wordWrap ? 'Currently on' : 'Currently off', shortcut: 'Wrap', run: toggleWordWrap },
    { id: 'minimap', icon: 'map', title: 'Toggle Minimap', detail: viewState.minimap ? 'Currently on' : 'Currently off', shortcut: 'Map', run: toggleMinimap },
    { id: 'fullscreen', icon: isFullscreen ? 'minimize-2' : 'maximize-2', title: isFullscreen ? 'Exit Fullscreen Editor' : 'Fullscreen Editor', detail: 'Use the full app window for editing', shortcut: 'Max', run: () => setFullscreen(!isFullscreen) }
  ];
}

function commandMatches(command, query) {
  if (!query) return true;
  const haystack = `${command.title} ${command.detail}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function renderCommandPaletteList() {
  if (!editorCommandList || !editorCommandInput) return;

  const query = editorCommandInput.value.trim();
  visibleCommands = getCommandDefinitions().filter((command) => commandMatches(command, query));
  if (activeCommandIndex >= visibleCommands.length) activeCommandIndex = Math.max(0, visibleCommands.length - 1);

  editorCommandList.innerHTML = '';

  if (visibleCommands.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'editor-command-empty';
    empty.textContent = 'No commands';
    editorCommandList.appendChild(empty);
    return;
  }

  visibleCommands.forEach((command, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `editor-command-item${index === activeCommandIndex ? ' active' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', index === activeCommandIndex ? 'true' : 'false');
    item.dataset.commandId = command.id;

    const icon = document.createElement('span');
    icon.className = 'editor-command-icon';
    icon.setAttribute('aria-hidden', 'true');
    const iconMarker = document.createElement('i');
    iconMarker.setAttribute('data-lucide', command.icon);
    icon.appendChild(iconMarker);

    const copy = document.createElement('span');
    copy.className = 'editor-command-copy';

    const title = document.createElement('span');
    title.className = 'editor-command-title';
    title.textContent = command.title;

    const detail = document.createElement('span');
    detail.className = 'editor-command-detail';
    detail.textContent = command.detail;

    copy.append(title, detail);

    const shortcut = document.createElement('span');
    shortcut.className = 'editor-command-shortcut';
    shortcut.textContent = command.shortcut;

    item.append(icon, copy, shortcut);
    editorCommandList.appendChild(item);
  });

  renderEditorIcons(editorCommandList);
}

function runCommand(command) {
  if (!command) return;
  hideCommandPalette(false);
  command.run();
  syncEditorToolState();
}

function runCommandById(commandId) {
  const command = getCommandDefinitions().find((item) => item.id === commandId);
  runCommand(command);
}

function showCommandPalette() {
  if (!editorCommandPalette || !editorCommandInput || currentMode !== 'text') return;
  activeCommandIndex = 0;
  editorCommandInput.value = '';
  editorCommandPalette.hidden = false;
  renderCommandPaletteList();
  requestAnimationFrame(() => {
    editorCommandInput.focus();
    editorCommandInput.select();
  });
}

function hideCommandPalette(restoreFocus = true) {
  if (editorCommandPalette) editorCommandPalette.hidden = true;
  if (restoreFocus) focusTextEditor();
}

function showGoToLinePrompt() {
  if (!codeEditor.isReady()) return;

  const position = codeEditor.getPosition ? codeEditor.getPosition() : null;
  const currentLine = position && position.lineNumber ? position.lineNumber : 1;
  const currentColumn = position && position.column ? position.column : 1;
  const input = prompt('Go to line[:column]', `${currentLine}:${currentColumn}`);

  if (input === null) return;

  const match = String(input).trim().match(/^(\d+)(?::(\d+))?$/);
  if (!match) {
    updateStatus('Use line or line:column', 'modified');
    return;
  }

  const line = Number(match[1]);
  const col = match[2] ? Number(match[2]) : 1;
  codeEditor.reveal(line, col);
  codeEditor.focus();
  updateStatus(`Line ${line}, Col ${col}`, '');
}

function toggleWordWrap() {
  if (!codeEditor.isReady()) return;
  const enabled = codeEditor.toggleWordWrap();
  updateStatus(`Word Wrap ${enabled ? 'On' : 'Off'}`, '');
}

function toggleMinimap() {
  if (!codeEditor.isReady()) return;
  const enabled = codeEditor.toggleMinimap();
  updateStatus(`Minimap ${enabled ? 'On' : 'Off'}`, '');
}

function bindEditorTool(id, handler) {
  const button = document.getElementById(id);
  if (!button) return;
  button.addEventListener('click', () => {
    handler();
    syncEditorToolState();
  });
}

/**
 * Open file in editor
 * @param {string} filePath - Path to the file
 * @param {string} source - Where the file was opened from ('fileTree', 'terminal', etc.)
 * @param {Object} [options] - Optional settings
 * @param {number} [options.line] - Line number to navigate to (1-based)
 * @param {number} [options.col] - Column number to navigate to (1-based)
 */
function openFile(filePath, source = 'terminal', options) {
  const extension = getExtensionFromPath(filePath);
  const projectPath = state.getProjectPath();
  if (VIDEO_EXTENSIONS.includes(extension)) {
    return ipcRenderer.invoke(IPC.OPEN_VIDEO, { filePath, projectPath }).then(result => {
      if (!result.success) alert('Unable to open video: ' + result.error);
    }).catch(err => alert('Unable to open video: ' + err.message));
  }
  if (pendingSaves.size > 0) {
    updateStatus('Saving… Wait for the save to finish before opening another file.', '');
    return;
  }
  const discardConfirmed = isModified;
  if (discardConfirmed && !confirm('You have unsaved changes. Open another file anyway?')) return;

  const requestId = ++nextRequestId;
  const channels = extension === 'svg'
    ? [IPC.READ_FILE, IPC.READ_FILE_DATA_URL]
    : [isImageExt(extension) ? IPC.READ_FILE_DATA_URL : IPC.READ_FILE];
  // Keep the active document fully usable until the new document is ready.
  // SVG text and preview must succeed together before committing the switch.
  pendingOpenRequest = {
    requestId, filePath, projectPath, source, extension, discardConfirmed,
    previousContent: getEditorContent(),
    lineNav: (options && options.line) ? { line: options.line, col: options.col } : null,
    remaining: new Set(channels.map(channel => channel === IPC.READ_FILE ? IPC.FILE_CONTENT : IPC.FILE_DATA_URL)),
    results: new Map()
  };
  for (const channel of channels) {
    ipcRenderer.send(channel, { filePath, projectPath, requestId });
  }
}

/**
 * Close editor
 */
function closeEditor() {
  if (pendingSaves.size > 0) {
    updateStatus('Saving… Wait for the save to finish before closing.', '');
    return;
  }
  if (isModified) {
    if (!confirm('You have unsaved changes. Close anyway?')) {
      return;
    }
  }

  editorOverlay.classList.remove('visible');

  // Restore focus to where the file was opened from
  if (openedFromSource === 'fileTree' && typeof window.fileTreeFocus === 'function') {
    window.fileTreeFocus();
  } else if (typeof window.terminalFocus === 'function') {
    window.terminalFocus();
  }

  currentEditingFile = null;
  originalContent = '';
  isModified = false;
  openedFromSource = null;
  pendingOpenRequest = null;
  activeOpenRequestId = null;
  editingProjectPath = null;
  textContentLoaded = false;
  pendingSaves.clear();
  pendingLineNav = null;
  hideCommandPalette(false);
  setViewTogglesVisible(false);
  setMode('text');
  if (editorImage) editorImage.src = '';
}

/**
 * Save file
 */
function saveFile() {
  if (!currentEditingFile) return;
  if (currentMode !== 'text' || !textContentLoaded) return;

  const content = getEditorContent();
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  if (content.length > MAX_FILE_SIZE) {
    updateStatus('File too large to save (max 10MB)', 'modified');
    return;
  }
  // Saving the visible document supersedes an unfinished navigation request.
  pendingOpenRequest = null;
  const requestId = ++nextRequestId;
  pendingSaves.set(requestId, { content, filePath: currentEditingFile, documentId: activeOpenRequestId });
  ipcRenderer.send(IPC.WRITE_FILE, {
    requestId,
    filePath: currentEditingFile,
    content: content,
    projectPath: editingProjectPath
  });
}

/**
 * Update editor status
 */
function updateStatus(status, className = '') {
  if (editorStatus) {
    editorStatus.textContent = status;
    editorStatus.className = className;
  }
}

/**
 * Check if content is modified
 */
function checkModified() {
  const content = getEditorContent();
  isModified = content !== originalContent;

  if (isModified) {
    updateStatus('Modified', 'modified');
  } else {
    updateStatus('Ready', '');
  }
}

function updateCursorStatus(line, col) {
  if (!isModified && currentMode === 'text') {
    updateStatus(`Line ${line}, Col ${col}`, '');
  }
}

/**
 * Navigate textarea to a specific line and column
 * @param {number} line - 1-based line number
 * @param {number} [col] - 1-based column number
 */
function scrollToLine(line, col) {
  if (codeEditor.isReady()) {
    codeEditor.reveal(line, col);
    return;
  }

  if (!editorTextarea || !editorTextarea.value) return;

  const text = editorTextarea.value;
  const lines = text.split('\n');
  const targetLine = Math.max(1, Math.min(line, lines.length));
  const targetCol = Math.max(1, col || 1);

  // Calculate character offset to the target line
  let offset = 0;
  for (let i = 0; i < targetLine - 1; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  // Add column offset (clamped to line length)
  const lineLength = lines[targetLine - 1] ? lines[targetLine - 1].length : 0;
  offset += Math.min(targetCol - 1, lineLength);

  // Set cursor position
  editorTextarea.setSelectionRange(offset, offset);

  // Scroll the line into view — estimate line height from textarea
  const style = window.getComputedStyle(editorTextarea);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 20;
  const visibleLines = Math.floor(editorTextarea.clientHeight / lineHeight);
  // Center the target line in the visible area
  const scrollLine = Math.max(0, targetLine - Math.floor(visibleLines / 2));
  editorTextarea.scrollTop = scrollLine * lineHeight;

  // Update status bar
  updateStatus(`Line ${targetLine}, Col ${targetCol}`, '');
}

/**
 * Setup event handlers
 */
function setupEventHandlers() {
  // Close button
  const closeBtn = document.getElementById('btn-editor-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeEditor);
  }

  // Save button
  if (btnSave) {
    btnSave.addEventListener('click', saveFile);
  }

  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      setFullscreen(!isFullscreen);
    });
  }

  bindEditorTool('btn-editor-undo', () => {
    if (codeEditor.isReady()) codeEditor.undo();
  });
  bindEditorTool('btn-editor-redo', () => {
    if (codeEditor.isReady()) codeEditor.redo();
  });
  bindEditorTool('btn-editor-find', () => {
    runEditorAction('actions.find', 'Find is not available');
  });
  bindEditorTool('btn-editor-replace', () => {
    runEditorAction('editor.action.startFindReplaceAction', 'Replace is not available');
  });
  bindEditorTool('btn-editor-goto', () => {
    showGoToLinePrompt();
  });
  bindEditorTool('btn-editor-command-palette', () => {
    showCommandPalette();
  });
  bindEditorTool('btn-editor-format', () => {
    runEditorAction('editor.action.formatDocument', 'No formatter available for this file');
  });
  bindEditorTool('btn-editor-wrap', () => {
    toggleWordWrap();
  });
  bindEditorTool('btn-editor-minimap', () => {
    toggleMinimap();
  });

  if (editorCommandInput) {
    editorCommandInput.addEventListener('input', () => {
      activeCommandIndex = 0;
      renderCommandPaletteList();
    });
    editorCommandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideCommandPalette();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeCommandIndex = Math.min(activeCommandIndex + 1, Math.max(0, visibleCommands.length - 1));
        renderCommandPaletteList();
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeCommandIndex = Math.max(activeCommandIndex - 1, 0);
        renderCommandPaletteList();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        runCommand(visibleCommands[activeCommandIndex]);
      }
    });
  }

  if (editorCommandList) {
    editorCommandList.addEventListener('click', (e) => {
      const item = e.target instanceof HTMLElement ? e.target.closest('[data-command-id]') : null;
      if (!item) return;
      runCommandById(item.dataset.commandId);
    });
    editorCommandList.addEventListener('mousemove', (e) => {
      const item = e.target instanceof HTMLElement ? e.target.closest('[data-command-id]') : null;
      if (!item || !editorCommandList) return;
      const items = Array.from(editorCommandList.querySelectorAll('[data-command-id]'));
      const index = items.indexOf(item);
      if (index !== -1 && index !== activeCommandIndex) {
        activeCommandIndex = index;
        renderCommandPaletteList();
      }
    });
  }

  if (editorCommandPalette) {
    editorCommandPalette.addEventListener('mousedown', (e) => {
      if (e.target === editorCommandPalette) {
        hideCommandPalette();
      }
    });
  }

  // View toggles (SVG)
  if (btnViewPreview) {
    btnViewPreview.addEventListener('click', () => {
      setMode('image');
    });
  }
  if (btnViewText) {
    btnViewText.addEventListener('click', () => {
      setMode('text');
      focusTextEditor();
    });
  }

  // Track modifications
  if (editorTextarea) {
    editorTextarea.addEventListener('input', checkModified);

    // Keyboard shortcuts
    editorTextarea.addEventListener('keydown', (e) => {
      const modKey = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Ctrl+S or Cmd+S to save
      if (modKey && key === 's') {
        e.preventDefault();
        saveFile();
      }

      // Ctrl+A or Cmd+A should always select editor content
      if (modKey && key === 'a') {
        e.preventDefault();
        e.stopPropagation();
        editorTextarea.select();
      }

      // Escape to close
      if (e.key === 'Escape') {
        closeEditor();
      }

      // Tab for indentation
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editorTextarea.selectionStart;
        const end = editorTextarea.selectionEnd;
        editorTextarea.value = editorTextarea.value.substring(0, start) + '  ' + editorTextarea.value.substring(end);
        editorTextarea.selectionStart = editorTextarea.selectionEnd = start + 2;
        checkModified();
      }
    });
  }

  // Keep Cmd/Ctrl+A scoped to editor while overlay is visible
  document.addEventListener('keydown', (e) => {
    const modKey = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (modKey && e.shiftKey && key === 'p' && isEditorOpen() && currentMode === 'text') {
      e.preventDefault();
      e.stopPropagation();
      showCommandPalette();
      return;
    }

    if (!modKey || key !== 'a' || !isEditorOpen() || !editorTextarea) return;
    if (codeEditor.isReady()) return;

    const target = e.target;
    const isInput =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);

    // Don't hijack selection inside other editable controls.
    if (isInput && target !== editorTextarea) return;

    e.preventDefault();
    e.stopPropagation();
    editorTextarea.focus();
    editorTextarea.select();
  }, true);

  // Close on overlay click (outside editor)
  if (editorOverlay) {
    editorOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'editor-overlay') {
        closeEditor();
      }
    });
  }
}

/**
 * Commit a document switch only after every required read succeeds.
 */
function receiveOpenResult(result, channel) {
  const request = pendingOpenRequest;
  if (!request || !result || result.requestId !== request.requestId ||
      result.filePath !== request.filePath || !request.remaining.has(channel)) return;
  request.remaining.delete(channel);
  if (!result.success) {
    pendingOpenRequest = null;
    updateStatus('Open failed: ' + result.error, 'modified');
    return;
  }
  request.results.set(channel, result);
  if (request.remaining.size > 0) return;
  pendingOpenRequest = null;

  // Changes typed while the read was in flight were not covered by the
  // original discard confirmation. Give those changes the same protection.
  if (isModified && (!request.discardConfirmed || getEditorContent() !== request.previousContent) &&
      !confirm('You have unsaved changes. Open another file anyway?')) return;

  const textResult = request.results.get(IPC.FILE_CONTENT);
  const imageResult = request.results.get(IPC.FILE_DATA_URL);
  activeOpenRequestId = request.requestId;
  currentEditingFile = request.filePath;
  editingProjectPath = request.projectPath;
  openedFromSource = request.source;
  pendingLineNav = request.lineNav;
  textContentLoaded = Boolean(textResult);
  originalContent = textResult ? textResult.content : '';
  isModified = false;
  setViewTogglesVisible(request.extension === 'svg');
  setMode(imageResult ? 'image' : 'text');
  if (editorFilename) editorFilename.textContent = result.fileName;
  if (editorExt) editorExt.textContent = request.extension.toUpperCase() || 'FILE';
  if (editorPath) editorPath.textContent = request.filePath;
  setEditorContent(originalContent, request.filePath, request.extension);
  if (editorImage) editorImage.src = imageResult ? imageResult.dataUrl : '';
  updateStatus(imageResult ? `Preview (${imageResult.mime || 'image'}, ${imageResult.sizeBytes || 0} bytes)` : 'Ready', '');
  editorOverlay.classList.add('visible');
  if (currentMode === 'text') {
    focusTextEditor();
    if (pendingLineNav) {
      scrollToLine(pendingLineNav.line, pendingLineNav.col);
      pendingLineNav = null;
    }
  }
}

/**
 * Setup IPC listeners
 */
function setupIPC() {
  ipcRenderer.on(IPC.FILE_CONTENT, (event, result) => receiveOpenResult(result, IPC.FILE_CONTENT));
  ipcRenderer.on(IPC.FILE_DATA_URL, (event, result) => receiveOpenResult(result, IPC.FILE_DATA_URL));

  // Receive save confirmation
  ipcRenderer.on(IPC.FILE_SAVED, (event, result) => {
    const saved = result && pendingSaves.get(result.requestId);
    if (!saved) return;
    pendingSaves.delete(result.requestId);
    if (saved.documentId !== activeOpenRequestId || saved.filePath !== currentEditingFile ||
        result.filePath !== saved.filePath || result.requestId < lastSavedRequestId) return;
    if (result.success) {
      lastSavedRequestId = result.requestId;
      originalContent = saved.content;
      checkModified();
      if (!isModified) updateStatus('Saved!', 'saved');

      // Reset status after 2 seconds
      setTimeout(() => {
        if (!isModified && activeOpenRequestId === saved.documentId && lastSavedRequestId === result.requestId) {
          updateStatus('Ready', '');
        }
      }, 2000);

      // Refresh file tree
      if (onFileTreeRefreshCallback) {
        onFileTreeRefreshCallback();
      }
    } else {
      updateStatus('Save failed: ' + result.error, 'modified');
    }
  });
}

/**
 * Check if editor is open
 */
function isEditorOpen() {
  return editorOverlay && editorOverlay.classList.contains('visible');
}

/**
 * Get currently editing file path
 */
function getCurrentFile() {
  return currentEditingFile;
}

module.exports = {
  init,
  openFile,
  saveFile,
  isEditorOpen,
  getCurrentFile
};
