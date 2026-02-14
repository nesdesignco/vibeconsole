/**
 * File Editor Module
 * Overlay editor for viewing and editing files
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const state = require('./state');

let editorOverlay = null;
let editorTextarea = null;
let editorFilename = null;
let editorExt = null;
let editorPath = null;
let editorStatus = null;

let currentEditingFile = null;
let originalContent = '';
let isModified = false;
let onFileTreeRefreshCallback = null;
let openedFromSource = null; // Track where the file was opened from ('fileTree', 'terminal', etc.)
let pendingLineNav = null; // { line, col } to navigate to after file loads

/**
 * Initialize editor module
 */
function init(onRefreshFileTree) {
  editorOverlay = document.getElementById('editor-overlay');
  editorTextarea = document.getElementById('editor-textarea');
  editorFilename = document.getElementById('editor-filename');
  editorExt = document.getElementById('editor-ext');
  editorPath = document.getElementById('editor-path');
  editorStatus = document.getElementById('editor-status');
  onFileTreeRefreshCallback = onRefreshFileTree;

  setupEventHandlers();
  setupIPC();
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
  openedFromSource = source;
  pendingLineNav = (options && options.line) ? { line: options.line, col: options.col } : null;
  ipcRenderer.send(IPC.READ_FILE, { filePath, projectPath: state.getProjectPath() });
}

/**
 * Close editor
 */
function closeEditor() {
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
}

/**
 * Save file
 */
function saveFile() {
  if (!currentEditingFile) return;

  const content = editorTextarea.value;
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  if (content.length > MAX_FILE_SIZE) {
    updateStatus('File too large to save (max 10MB)', 'modified');
    return;
  }
  ipcRenderer.send(IPC.WRITE_FILE, {
    filePath: currentEditingFile,
    content: content,
    projectPath: state.getProjectPath()
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
  const content = editorTextarea.value;
  isModified = content !== originalContent;

  if (isModified) {
    updateStatus('Modified', 'modified');
  } else {
    updateStatus('Ready', '');
  }
}

/**
 * Navigate textarea to a specific line and column
 * @param {number} line - 1-based line number
 * @param {number} [col] - 1-based column number
 */
function scrollToLine(line, col) {
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
  const saveBtn = document.getElementById('btn-editor-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveFile);
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
    if (!modKey || key !== 'a' || !isEditorOpen() || !editorTextarea) return;

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
 * Setup IPC listeners
 */
function setupIPC() {
  // Receive file content
  ipcRenderer.on(IPC.FILE_CONTENT, (event, result) => {
    if (result.success) {
      currentEditingFile = result.filePath;
      originalContent = result.content;
      isModified = false;

      // Update UI
      if (editorFilename) editorFilename.textContent = result.fileName;
      if (editorExt) editorExt.textContent = result.extension.toUpperCase() || 'FILE';
      if (editorTextarea) editorTextarea.value = result.content;
      if (editorPath) editorPath.textContent = result.filePath;
      updateStatus('Ready', '');

      // Show overlay
      editorOverlay.classList.add('visible');

      // Focus textarea and navigate to pending line
      if (editorTextarea) {
        editorTextarea.focus();
        if (pendingLineNav) {
          scrollToLine(pendingLineNav.line, pendingLineNav.col);
          pendingLineNav = null;
        }
      }
    } else {
      console.error('Error opening file:', result.error);
    }
  });

  // Receive save confirmation
  ipcRenderer.on(IPC.FILE_SAVED, (event, result) => {
    if (result.success) {
      originalContent = editorTextarea.value;
      isModified = false;
      updateStatus('Saved!', 'saved');

      // Reset status after 2 seconds
      setTimeout(() => {
        if (!isModified) {
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
