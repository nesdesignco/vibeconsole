/**
 * File Tree UI Module
 * Renders collapsible file tree in sidebar
 */

const { ipcRenderer, clipboard, pathApi } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { shellQuote } = require('./shellEscape');

let fileTreeElement = null;
let currentProjectPath = null;
let onFileClickCallback = null;
let focusedItem = null;
let activeContextMenu = null;
let contextMenuCleanupController = null;

/**
 * Initialize file tree UI
 */
function init(elementId, getProjectPath) {
  fileTreeElement = document.getElementById(elementId);

  // Store reference to get current project path
  if (typeof getProjectPath === 'function') {
    currentProjectPath = getProjectPath;
  }

  setupIPC();
}

/**
 * Set project path getter
 */
function setProjectPathGetter(getter) {
  currentProjectPath = getter;
}

/**
 * Set file click callback
 */
function setOnFileClick(callback) {
  onFileClickCallback = callback;
}

/**
 * Render file tree recursively
 */
function renderFileTree(files, parentElement, indent = 0) {
  files.forEach(file => {
    // Create wrapper for folder + children
    const wrapper = document.createElement('div');
    wrapper.className = 'file-wrapper';

    const fileItem = document.createElement('div');
    fileItem.className = 'file-item' + (file.isDirectory ? ' folder' : '');
    fileItem.style.paddingLeft = `${8 + indent * 16}px`;
    fileItem.tabIndex = 0; // Make focusable
    fileItem.dataset.path = file.path;

    // Add arrow for folders
    if (file.isDirectory) {
      const arrow = document.createElement('span');
      arrow.textContent = '▶ ';
      arrow.style.fontSize = '10px';
      arrow.style.marginRight = '4px';
      arrow.style.display = 'inline-block';
      arrow.style.transition = 'transform 0.2s';
      arrow.className = 'folder-arrow';
      fileItem.appendChild(arrow);
    }

    // File icon
    const icon = document.createElement('span');
    if (file.isDirectory) {
      icon.className = 'file-icon folder-icon';
    } else {
      const ext = file.name.split('.').pop();
      icon.className = `file-icon file-icon-${ext}`;
      if (!['js', 'json', 'md'].includes(ext)) {
        icon.className = 'file-icon file-icon-default';
      }
    }

    // File name
    const name = document.createElement('span');
    name.textContent = file.name;

    fileItem.appendChild(icon);
    fileItem.appendChild(name);

    // Drag-drop support
    fileItem.draggable = true;
    fileItem.addEventListener('dragstart', (e) => {
      const filePath = file.path;
      const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
      e.dataTransfer.setData('text/plain', quotedPath);
      e.dataTransfer.setData('application/x-vibeconsole-file', filePath);
      e.dataTransfer.effectAllowed = 'copy';
      fileItem.classList.add('dragging');
    });
    fileItem.addEventListener('dragend', () => {
      fileItem.classList.remove('dragging');
    });

    // Context menu (right-click)
    fileItem.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, file);
    });

    wrapper.appendChild(fileItem);

    // Create children container for folders
    if (file.isDirectory && file.children && file.children.length > 0) {
      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'folder-children';
      childrenContainer.style.display = 'none'; // Start collapsed

      // Recursively render children
      renderFileTree(file.children, childrenContainer, indent + 1);
      wrapper.appendChild(childrenContainer);

      // Toggle folder on click
      fileItem.addEventListener('click', (e) => {
        e.stopPropagation();
        const arrow = /** @type {HTMLElement|null} */ (fileItem.querySelector('.folder-arrow'));
        const isExpanded = childrenContainer.style.display !== 'none';

        if (isExpanded) {
          childrenContainer.style.display = 'none';
          arrow.style.transform = 'rotate(0deg)';
        } else {
          childrenContainer.style.display = 'block';
          arrow.style.transform = 'rotate(90deg)';
        }
      });
    } else if (!file.isDirectory) {
      // File click handler - open in editor
      fileItem.addEventListener('click', () => {
        if (onFileClickCallback) {
          onFileClickCallback(file.path, 'fileTree');
        }
      });
    }

    parentElement.appendChild(wrapper);
  });
}

/**
 * Clear file tree
 */
function clearFileTree() {
  if (fileTreeElement) {
    fileTreeElement.innerHTML = '';
  }
}

/**
 * Refresh file tree
 */
function refreshFileTree(projectPath) {
  const path = projectPath || (currentProjectPath && currentProjectPath());
  if (path) {
    ipcRenderer.send(IPC.LOAD_FILE_TREE, path);
  }
}

/**
 * Load file tree for path
 */
function loadFileTree(projectPath) {
  ipcRenderer.send(IPC.LOAD_FILE_TREE, projectPath);
}

/**
 * Validate a file/folder name
 * @returns {string|null} Error message or null if valid
 */
function validateFileName(name) {
  if (!name || !name.trim()) return 'Name cannot be empty';
  if (/[/\\:*?"<>|]/.test(name)) return 'Name contains invalid characters';
  return null;
}

/**
 * Get the directory path for creating new items relative to a file
 */
function getTargetDir(file) {
  return file.isDirectory ? file.path : pathApi.dirname(file.path);
}

/**
 * Create an inline input for rename or new file/folder
 */
function createInlineInput(fileItem, initialValue, onSubmit, onCancel) {
  const nameSpan = fileItem.querySelector('span:last-child');
  if (!nameSpan) return;

  nameSpan.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-item-rename-input';
  input.value = initialValue;
  nameSpan.parentElement.appendChild(input);

  // Select name without extension for files
  const dotIndex = initialValue.lastIndexOf('.');
  if (dotIndex > 0) {
    input.setSelectionRange(0, dotIndex);
  } else {
    input.select();
  }

  input.focus();

  let submitted = false;

  const cleanup = () => {
    if (input.parentElement) {
      input.remove();
    }
    nameSpan.style.display = '';
  };

  const submit = () => {
    if (submitted) return;
    submitted = true;
    const newName = input.value.trim();
    const error = validateFileName(newName);
    if (error) {
      alert(error);
      cleanup();
      if (onCancel) onCancel();
      return;
    }
    cleanup();
    onSubmit(newName);
  };

  const cancel = () => {
    if (submitted) return;
    submitted = true;
    cleanup();
    if (onCancel) onCancel();
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  input.addEventListener('blur', () => {
    // Small delay to allow click events to fire first
    setTimeout(() => {
      if (!submitted) submit();
    }, 100);
  });

  return input;
}

/**
 * Show inline input for creating a new file or folder inside a directory
 */
function showNewItemInput(file, isFolder) {
  const targetDir = getTargetDir(file);

  // Find the correct parent container to insert into
  // If file is a directory, expand it and insert inside its children container
  // Otherwise insert next to the file's wrapper
  let container;
  let fileItemEl;

  if (file.isDirectory) {
    // Find the file item element for this directory
    fileItemEl = fileTreeElement.querySelector(`.file-item[data-path="${CSS.escape(file.path)}"]`);
    if (fileItemEl) {
      const wrapper = fileItemEl.parentElement;
      let childrenContainer = wrapper.querySelector('.folder-children');
      if (!childrenContainer) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'folder-children';
        childrenContainer.style.display = 'block';
        wrapper.appendChild(childrenContainer);
      }
      // Expand the folder
      childrenContainer.style.display = 'block';
      const arrow = /** @type {HTMLElement|null} */ (fileItemEl.querySelector('.folder-arrow'));
      if (arrow) arrow.style.transform = 'rotate(90deg)';
      container = childrenContainer;
    }
  }

  if (!container) {
    // For files, insert into the parent container
    fileItemEl = fileTreeElement.querySelector(`.file-item[data-path="${CSS.escape(file.path)}"]`);
    if (fileItemEl) {
      container = fileItemEl.parentElement.parentElement;
    }
  }

  if (!container) return;

  // Calculate indent from the target directory
  const indent = file.isDirectory
    ? parseInt(fileItemEl.style.paddingLeft) + 16
    : parseInt(fileItemEl.style.paddingLeft);

  // Create a temporary file-item row
  const tempWrapper = document.createElement('div');
  tempWrapper.className = 'file-wrapper';

  const tempItem = document.createElement('div');
  tempItem.className = 'file-item' + (isFolder ? ' folder' : '');
  tempItem.style.paddingLeft = `${indent}px`;

  // Icon
  const icon = document.createElement('span');
  icon.className = isFolder ? 'file-icon folder-icon' : 'file-icon file-icon-default';
  tempItem.appendChild(icon);

  // Placeholder name span (will be hidden by createInlineInput)
  const nameSpan = document.createElement('span');
  nameSpan.textContent = '';
  tempItem.appendChild(nameSpan);

  tempWrapper.appendChild(tempItem);

  // Insert at top of container
  if (container.firstChild) {
    container.insertBefore(tempWrapper, container.firstChild);
  } else {
    container.appendChild(tempWrapper);
  }

  const projectPath = currentProjectPath ? currentProjectPath() : null;

  createInlineInput(tempItem, '', (newName) => {
    tempWrapper.remove();
    const newPath = pathApi.join(targetDir, newName);
    if (isFolder) {
      ipcRenderer.send(IPC.CREATE_FOLDER, { folderPath: newPath, projectPath });
    } else {
      ipcRenderer.send(IPC.CREATE_FILE, { filePath: newPath, projectPath });
    }
  }, () => {
    tempWrapper.remove();
  });
}

/**
 * Start inline rename for a file item
 */
function startRename(file) {
  const fileItemEl = fileTreeElement.querySelector(`.file-item[data-path="${CSS.escape(file.path)}"]`);
  if (!fileItemEl) return;

  const projectPath = currentProjectPath ? currentProjectPath() : null;

  createInlineInput(fileItemEl, file.name, (newName) => {
    if (newName === file.name) return; // No change
    const newPath = pathApi.join(pathApi.dirname(file.path), newName);
    ipcRenderer.send(IPC.RENAME_FILE, { oldPath: file.path, newPath, projectPath });
  });
}

/**
 * Add a menu item helper
 */
function addMenuItem(menu, label, onClick, options = {}) {
  const item = document.createElement('div');
  item.className = 'file-tree-context-menu-item' + (options.danger ? ' danger' : '');
  item.textContent = label;
  item.addEventListener('click', () => {
    closeContextMenu();
    onClick();
  });
  menu.appendChild(item);
}

/**
 * Add a separator to the menu
 */
function addSeparator(menu) {
  const sep = document.createElement('div');
  sep.className = 'file-tree-context-menu-separator';
  menu.appendChild(sep);
}

/**
 * Show context menu for a file item
 */
function showContextMenu(x, y, file) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'file-tree-context-menu';
  menu.setAttribute('role', 'menu');

  const projectPath = currentProjectPath ? currentProjectPath() : null;

  // -- New File / New Folder --
  addMenuItem(menu, 'New File', () => showNewItemInput(file, false));
  addMenuItem(menu, 'New Folder', () => showNewItemInput(file, true));

  addSeparator(menu);

  // -- cd to Directory --
  const cdTarget = file.isDirectory ? file.path : pathApi.dirname(file.path);
  addMenuItem(menu, 'cd to Directory', () => {
    if (typeof window.terminalSendCommand === 'function') {
      window.terminalSendCommand(`cd ${shellQuote(cdTarget)}`);
    }
  });

  // -- Open in New Tab (files only) --
  if (!file.isDirectory) {
    addMenuItem(menu, 'Open in New Tab', () => {
      if (onFileClickCallback) {
        onFileClickCallback(file.path, 'fileTree');
      }
    });
  }

  // -- Reveal in Finder --
  addMenuItem(menu, 'Reveal in Finder', () => {
    ipcRenderer.send(IPC.REVEAL_IN_FINDER, { filePath: file.path, projectPath });
  });

  addSeparator(menu);

  // -- Rename --
  addMenuItem(menu, 'Rename', () => startRename(file));

  // -- Delete --
  addMenuItem(menu, 'Delete', () => {
    const itemType = file.isDirectory ? 'folder' : 'file';
    if (window.confirm(`Move "${file.name}" (${itemType}) to trash?`)) {
      ipcRenderer.send(IPC.DELETE_FILE, { filePath: file.path, projectPath });
    }
  }, { danger: true });

  addSeparator(menu);

  // -- Copy Path --
  addMenuItem(menu, 'Copy Path', () => {
    clipboard.writeText(file.path);
  });

  // -- Copy Relative Path --
  addMenuItem(menu, 'Copy Relative Path', () => {
    const relativePath = projectPath ? pathApi.relative(projectPath, file.path) : file.path;
    clipboard.writeText(relativePath);
  });

  // Position menu
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust if menu goes off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  }

  activeContextMenu = menu;
  contextMenuCleanupController = new AbortController();
  const { signal } = contextMenuCleanupController;

  document.addEventListener('pointerdown', (e) => {
    const target = e.target instanceof Node ? e.target : null;
    if (!target || !menu.contains(target)) {
      closeContextMenu();
    }
  }, { capture: true, signal });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeContextMenu();
    }
  }, { signal });

  window.addEventListener('blur', closeContextMenu, { signal });
}

/**
 * Close context menu if open
 */
function closeContextMenu() {
  if (contextMenuCleanupController) {
    contextMenuCleanupController.abort();
    contextMenuCleanupController = null;
  }
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

/**
 * Setup IPC listeners
 */
function setupIPC() {
  ipcRenderer.on(IPC.FILE_TREE_DATA, (event, files) => {
    clearFileTree();
    renderFileTree(files, fileTreeElement);
  });

  ipcRenderer.on(IPC.FILE_DELETED, (event, result) => {
    if (!result.success) {
      alert(`Failed to delete: ${result.error}`);
    }
  });
}

/**
 * Focus file tree for keyboard navigation
 */
function focus() {
  if (!fileTreeElement) return;

  const items = getVisibleItems();
  if (items.length === 0) return;

  // If we have a previously focused item that's still in the DOM, use it
  const targetItem = (focusedItem && fileTreeElement.contains(focusedItem))
    ? focusedItem
    : items[0];

  targetItem.focus();
  targetItem.classList.add('focused');
  focusedItem = targetItem;

  // Setup keyboard navigation (one-time)
  if (!fileTreeElement.dataset.keyboardSetup) {
    fileTreeElement.dataset.keyboardSetup = 'true';
    fileTreeElement.addEventListener('keydown', handleKeydown);
  }
}

/**
 * Get all visible file items (for navigation)
 */
function getVisibleItems() {
  if (!fileTreeElement) return [];
  const allItems = fileTreeElement.querySelectorAll('.file-item');
  return Array.from(allItems).filter(item => {
    // Check if parent folder is expanded
    let parent = item.parentElement;
    while (parent && parent !== fileTreeElement) {
      if (parent.classList.contains('folder-children') && parent.style.display === 'none') {
        return false;
      }
      parent = parent.parentElement;
    }
    return true;
  });
}

/**
 * Handle keyboard navigation in file tree
 */
function handleKeydown(e) {
  const items = getVisibleItems();
  const currentIndex = items.indexOf(focusedItem);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    focusedItem?.classList.remove('focused');

    let newIndex;
    if (e.key === 'ArrowDown') {
      newIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
    } else {
      newIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
    }

    focusedItem = items[newIndex];
    focusedItem?.focus();
    focusedItem?.classList.add('focused');
  }

  if (e.key === 'ArrowRight' && focusedItem?.classList.contains('folder')) {
    // Expand folder
    e.preventDefault();
    const wrapper = focusedItem.parentElement;
    const children = wrapper.querySelector('.folder-children');
    const arrow = focusedItem.querySelector('.folder-arrow');
    if (children && children.style.display === 'none') {
      children.style.display = 'block';
      if (arrow) arrow.style.transform = 'rotate(90deg)';
    }
  }

  if (e.key === 'ArrowLeft' && focusedItem?.classList.contains('folder')) {
    // Collapse folder
    e.preventDefault();
    const wrapper = focusedItem.parentElement;
    const children = wrapper.querySelector('.folder-children');
    const arrow = focusedItem.querySelector('.folder-arrow');
    if (children && children.style.display !== 'none') {
      children.style.display = 'none';
      if (arrow) arrow.style.transform = 'rotate(0deg)';
    }
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    focusedItem?.click();
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    focusedItem?.classList.remove('focused');
    // Return focus to terminal
    if (typeof window.terminalFocus === 'function') {
      window.terminalFocus();
    }
  }
}

/**
 * Blur/unfocus file tree
 */
function blur() {
  focusedItem?.classList.remove('focused');
  focusedItem = null;
}

// Expose focus function globally for editor to restore focus
window.fileTreeFocus = focus;

module.exports = {
  init,
  setProjectPathGetter,
  setOnFileClick,
  renderFileTree,
  clearFileTree,
  refreshFileTree,
  loadFileTree,
  focus,
  blur
};
