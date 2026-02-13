/**
 * Saved Prompts Panel Module
 * UI for managing and pasting saved prompts to terminal
 */

const { ipcRenderer, clipboard } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const state = require('./state');
const { createPanelHeaderDropdown } = require('./panelHeaderDropdown');

let isVisible = false;
let globalPrompts = [];
let projectPrompts = [];
let currentScope = 'all'; // all, global, project
let currentCategory = 'all';
let searchQuery = '';
let editingPromptId = null;
let editingPromptScope = null;

const PASTE_DEDUP_WINDOW_MS = 250;

// DOM Elements
let panelElement = null;
let contentElement = null;
let categoriesElement = null;
let searchInput = null;
let scopeDropdownControl = null;

/**
 * Initialize saved prompts panel
 */
function init() {
  panelElement = document.getElementById('saved-prompts-panel');
  contentElement = document.getElementById('saved-prompts-content');
  categoriesElement = document.getElementById('saved-prompts-categories');
  searchInput = document.getElementById('saved-prompts-search');

  if (!panelElement) {
    console.error('Saved prompts panel element not found');
    return;
  }

  setupEventListeners();
  setupIPCListeners();
  setupModalListeners();

  // Clear project prompts and reload when project changes
  state.onProjectChange(() => {
    projectPrompts = [];
    hidePromptModal(); // Close modal to prevent stale edits
    if (isVisible) loadPrompts();
  });
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Close button
  const closeBtn = document.getElementById('saved-prompts-close');
  if (closeBtn) closeBtn.addEventListener('click', hide);

  // Collapse button
  const collapseBtn = document.getElementById('saved-prompts-collapse-btn');
  if (collapseBtn) collapseBtn.addEventListener('click', hide);

  // Add button
  const addBtn = document.getElementById('saved-prompts-add-btn');
  if (addBtn) addBtn.addEventListener('click', showAddPromptModal);

  // Header dropdown scope filter
  const scopeDropdown = document.getElementById('saved-prompts-scope-dropdown');
  if (scopeDropdown) {
    scopeDropdownControl = createPanelHeaderDropdown(scopeDropdown, {
      onChange: (scope) => setScope(scope, { syncDropdown: false })
    });
  }

  // Search input
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      render();
    });
  }
}

/**
 * Setup IPC listeners
 */
function setupIPCListeners() {
  ipcRenderer.on(IPC.SAVED_PROMPTS_DATA, (event, data) => {
    globalPrompts = data.globalPrompts || [];
    projectPrompts = data.projectPrompts || [];
    render();
  });

  ipcRenderer.on(IPC.SAVED_PROMPT_UPDATED, (event, { action, success }) => {
    if (success && action === 'add') {
      showToast('Prompt saved', 'success');
    } else if (success && action === 'delete') {
      showToast('Prompt deleted', 'info');
    }
  });

  ipcRenderer.on(IPC.TOGGLE_SAVED_PROMPTS_PANEL, () => {
    toggle();
  });
}

/**
 * Load prompts from backend
 */
function loadPrompts() {
  const projectPath = state.getProjectPath();
  ipcRenderer.send(IPC.LOAD_SAVED_PROMPTS, projectPath || null);
}

/**
 * Show panel
 */
function show() {
  if (panelElement) {
    panelElement.classList.add('visible');
    isVisible = true;
    loadPrompts();
  }
}

/**
 * Hide panel
 */
function hide() {
  if (panelElement) {
    panelElement.classList.remove('visible');
    isVisible = false;
  }
}

/**
 * Toggle panel visibility
 */
function toggle() {
  if (isVisible) {
    hide();
  } else {
    show();
  }
}

function setScope(scope, options = {}) {
  const { syncDropdown = true } = options;
  currentScope = scope;
  if (syncDropdown && scopeDropdownControl) {
    scopeDropdownControl.setValue(scope);
  }
  render();
}

/**
 * Get merged and filtered prompts
 */
function getMergedPrompts() {
  let merged = [];

  if (currentScope === 'all' || currentScope === 'global') {
    merged = merged.concat(globalPrompts.map(p => ({ ...p, scope: 'global' })));
  }
  if (currentScope === 'all' || currentScope === 'project') {
    merged = merged.concat(projectPrompts.map(p => ({ ...p, scope: 'project' })));
  }

  // Filter by category
  if (currentCategory !== 'all') {
    merged = merged.filter(p => p.category === currentCategory);
  }

  // Filter by search
  if (searchQuery) {
    merged = merged.filter(p =>
      p.title.toLowerCase().includes(searchQuery) ||
      p.content.toLowerCase().includes(searchQuery)
    );
  }

  // Sort: favorites first, then by updatedAt desc
  merged.sort((a, b) => {
    if (a.favorite && !b.favorite) return -1;
    if (!a.favorite && b.favorite) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return merged;
}

/**
 * Render the panel content
 */
function render() {
  if (!contentElement) return;

  // Render category chips
  renderCategories();

  const prompts = getMergedPrompts();

  if (prompts.length === 0) {
    contentElement.innerHTML = `
      <div class="saved-prompts-empty">
        <div class="saved-prompts-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <p>No saved prompts</p>
        <span>Click "Add" to save your first prompt</span>
      </div>
    `;
    return;
  }

  contentElement.innerHTML = prompts.map(p => renderPromptItem(p)).join('');

  // Attach event listeners
  contentElement.querySelectorAll('.saved-prompt-item').forEach(item => {
    const promptId = item.dataset.promptId;
    const scope = item.dataset.scope;

    // Copy button
    item.querySelector('.saved-prompt-copy-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(promptId, scope);
    });

    // Favorite toggle
    item.querySelector('.saved-prompt-fav-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(promptId, scope);
    });

    // Edit button
    item.querySelector('.saved-prompt-edit-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showEditPromptModal(promptId, scope);
    });

    // Delete button
    item.querySelector('.saved-prompt-delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePrompt(promptId, scope);
    });
  });
}

/**
 * Render category chips
 */
function renderCategories() {
  if (categoriesElement) categoriesElement.innerHTML = '';
}

/**
 * Render a single prompt item
 */
function renderPromptItem(prompt) {
  const scopeBadge = prompt.scope === 'global'
    ? '<span class="saved-prompt-scope scope-global" title="Global">G</span>'
    : '<span class="saved-prompt-scope scope-project" title="Project">P</span>';

  const favClass = prompt.favorite ? 'active' : '';
  const contentPreview = escapeHtml(prompt.content.length > 120 ? prompt.content.substring(0, 120) + '...' : prompt.content);

  return `
    <div class="saved-prompt-item" data-prompt-id="${escapeAttr(prompt.id)}" data-scope="${escapeAttr(prompt.scope)}">
      <div class="saved-prompt-header">
        ${scopeBadge}
        <span class="saved-prompt-title">${escapeHtml(prompt.title)}</span>
        ${prompt.category ? `<span class="saved-prompt-category">${escapeHtml(prompt.category)}</span>` : ''}
      </div>
      <div class="saved-prompt-content">
        <code>${contentPreview}</code>
      </div>
      <div class="saved-prompt-actions">
        <button class="saved-prompt-copy-btn" title="Copy to clipboard">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
        <button class="saved-prompt-fav-btn ${favClass}" title="Toggle favorite">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="${prompt.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
        <button class="saved-prompt-edit-btn" title="Edit">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="saved-prompt-delete-btn" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

/**
 * Copy prompt content to clipboard
 */
let _copyLock = false;
async function copyToClipboard(promptId, scope) {
  if (_copyLock) return;
  _copyLock = true;

  const prompts = scope === 'global' ? globalPrompts : projectPrompts;
  const prompt = prompts.find(p => p.id === promptId);
  if (!prompt || !prompt.content) {
    _copyLock = false;
    return;
  }

  try {
    const copied = await writeClipboardText(prompt.content);
    if (copied) {
      showToast('Copied to clipboard', 'success');
    } else {
      showToast('Failed to copy', 'error');
    }
  } finally {
    setTimeout(() => {
      _copyLock = false;
    }, 300);
  }
}

async function writeClipboardText(text) {
  const value = String(text ?? '');

  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await Promise.resolve(clipboard.writeText(value));
      return true;
    } catch (err) {
      console.warn('Saved prompts copy failed via Electron clipboard API:', err?.message || err);
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (err) {
      console.warn('Saved prompts copy failed via Navigator clipboard API:', err?.message || err);
    }
  }

  // Last-resort fallback for restricted environments.
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  try {
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    if (success) return true;
    console.warn('Saved prompts copy failed via execCommand fallback.');
  } catch (err) {
    console.warn('Saved prompts copy threw via execCommand fallback:', err?.message || err);
  } finally {
    if (textarea.parentNode) {
      textarea.parentNode.removeChild(textarea);
    }
  }

  return false;
}

/**
 * Toggle favorite status
 */
function toggleFavorite(promptId, scope) {
  const prompts = scope === 'global' ? globalPrompts : projectPrompts;
  const prompt = prompts.find(p => p.id === promptId);
  if (!prompt) return;

  const projectPath = state.getProjectPath();
  ipcRenderer.send(IPC.UPDATE_SAVED_PROMPT, {
    scope,
    projectPath: projectPath || null,
    promptId,
    updates: { favorite: !prompt.favorite }
  });
}

/**
 * Delete a prompt
 */
function deletePrompt(promptId, scope) {
  if (!confirm('Delete this saved prompt?')) return;

  const projectPath = state.getProjectPath();
  ipcRenderer.send(IPC.DELETE_SAVED_PROMPT, {
    scope,
    projectPath: projectPath || null,
    promptId
  });
}

/**
 * Show add prompt modal
 */
function showAddPromptModal() {
  const modal = document.getElementById('saved-prompt-modal');
  const form = document.getElementById('saved-prompt-form');
  const title = document.getElementById('saved-prompt-modal-title');
  const scopeSelect = document.getElementById('saved-prompt-scope-input');

  if (!modal || !form) return;

  title.textContent = 'Add Saved Prompt';
  form.reset();
  editingPromptId = null;
  editingPromptScope = null;

  // Enable scope select for new prompts
  if (scopeSelect) {
    scopeSelect.disabled = false;
    // Disable project option if no project selected
    const projectOption = scopeSelect.querySelector('option[value="project"]');
    if (projectOption) {
      projectOption.disabled = !state.getProjectPath();
    }
  }

  modal.classList.add('visible');
  document.getElementById('saved-prompt-title-input')?.focus();
}

/**
 * Show edit prompt modal
 */
function showEditPromptModal(promptId, scope) {
  const prompts = scope === 'global' ? globalPrompts : projectPrompts;
  const prompt = prompts.find(p => p.id === promptId);
  if (!prompt) return;

  const modal = document.getElementById('saved-prompt-modal');
  const form = document.getElementById('saved-prompt-form');
  const title = document.getElementById('saved-prompt-modal-title');
  const scopeSelect = document.getElementById('saved-prompt-scope-input');

  if (!modal || !form) return;

  title.textContent = 'Edit Saved Prompt';
  editingPromptId = promptId;
  editingPromptScope = scope;

  // Fill form
  document.getElementById('saved-prompt-title-input').value = prompt.title || '';
  document.getElementById('saved-prompt-content-input').value = prompt.content || '';
  document.getElementById('saved-prompt-category-input').value = prompt.category || '';
  if (scopeSelect) {
    scopeSelect.value = scope;
    scopeSelect.disabled = true; // Can't change scope during edit
  }

  modal.classList.add('visible');
}

/**
 * Hide prompt modal
 */
function hidePromptModal() {
  const modal = document.getElementById('saved-prompt-modal');
  if (modal) modal.classList.remove('visible');
  editingPromptId = null;
  editingPromptScope = null;
}

/**
 * Handle form submit
 */
function handlePromptFormSubmit(e) {
  e.preventDefault();

  const titleVal = document.getElementById('saved-prompt-title-input').value.trim();
  const contentVal = document.getElementById('saved-prompt-content-input').value.trim();
  const categoryVal = document.getElementById('saved-prompt-category-input').value.trim();
  const scopeVal = document.getElementById('saved-prompt-scope-input').value;

  if (!titleVal || !contentVal) {
    showToast('Title and content are required', 'error');
    return;
  }

  const projectPath = state.getProjectPath();

  if (editingPromptId) {
    // Update
    ipcRenderer.send(IPC.UPDATE_SAVED_PROMPT, {
      scope: editingPromptScope,
      projectPath: projectPath || null,
      promptId: editingPromptId,
      updates: { title: titleVal, content: contentVal, category: categoryVal || 'general' }
    });
    showToast('Prompt updated', 'success');
  } else {
    // Add
    ipcRenderer.send(IPC.ADD_SAVED_PROMPT, {
      scope: scopeVal,
      projectPath: projectPath || null,
      prompt: { title: titleVal, content: contentVal, category: categoryVal || 'general' }
    });
  }

  hidePromptModal();
}

/**
 * Setup modal listeners
 */
function setupModalListeners() {
  const modal = document.getElementById('saved-prompt-modal');
  const form = document.getElementById('saved-prompt-form');
  const cancelBtn = document.getElementById('saved-prompt-cancel-btn');
  const closeBtn = document.getElementById('saved-prompt-modal-close');

  if (form) form.addEventListener('submit', handlePromptFormSubmit);
  if (cancelBtn) cancelBtn.addEventListener('click', hidePromptModal);
  if (closeBtn) closeBtn.addEventListener('click', hidePromptModal);

  // Some environments can dispatch paste twice (keyboard + menu), causing doubled content.
  // Deduplicate per-field based on the clipboard text and a short time window.
  const installPasteDedup = (el) => {
    if (!el || el.dataset.vibePasteDedup === '1') return;
    el.dataset.vibePasteDedup = '1';

    let lastText = '';
    let lastAt = 0;

    el.addEventListener('paste', (e) => {
      const text = e?.clipboardData?.getData('text/plain') || '';
      if (!text) return;
      const now = Date.now();
      const isDuplicate = text === lastText && (now - lastAt) <= PASTE_DEDUP_WINDOW_MS;
      if (isDuplicate) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        return;
      }
      lastText = text;
      lastAt = now;
    }, true);
  };

  installPasteDedup(document.getElementById('saved-prompt-title-input'));
  installPasteDedup(document.getElementById('saved-prompt-content-input'));
  installPasteDedup(document.getElementById('saved-prompt-category-input'));

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hidePromptModal();
    });
  }
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
  const existingToast = panelElement?.querySelector('.saved-prompts-toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = `saved-prompts-toast saved-prompts-toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${getToastIcon(type)}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;

  if (panelElement) panelElement.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

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

module.exports = {
  init,
  show,
  hide,
  toggle,
  isVisible: () => isVisible
};
