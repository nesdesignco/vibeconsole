/**
 * Terminal Manager Module
 * Manages multiple terminal instances in the renderer
 */

const { ipcRenderer, clipboard, getPathForFile } = require('./electronBridge');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { ScrollbackClearAddon } = require('./scrollbackClearAddon');
const { IPC } = require('../shared/ipcChannels');
const { matchAiToolCommand } = require('../shared/aiToolDetection');
const { writeClipboardText } = require('./clipboardWrite');
const { shellQuote } = require('./shellEscape');
const { registerFilePathLinks } = require('./filePathLinker');
const { attachClickLinkFallback, registerBareUrlLinks } = require('./urlLinker');
const { normalizeTerminalUrl } = require('../shared/urlUtils');

const { terminalTheme, defaults, variables } = require('../shared/appearance');

// Session storage key
const SESSION_STORAGE_KEY = 'vibeconsole-terminal-sessions';
const GLOBAL_PROJECT_KEY = '__global__';
// Process detection may lag a freshly typed/queued start command by one poll
// cycle; a null detection within this window must not clear the tag.
const AI_TOOL_DETECTION_GRACE_MS = 5000;

function createTerminalLinkHandler(ipc = ipcRenderer) {
  let lastSent = { url: null, at: 0 };
  return {
    activate: (_event, uri) => {
      // Normalize before sending: strips prose punctuation and adds the
      // missing protocol for bare-domain links (form-drive.vercel.app).
      const url = normalizeTerminalUrl(uri);
      if (!url) return;
      // The click fallback and xterm's native activation can both fire for
      // one click; open once.
      const now = Date.now();
      if (url === lastSent.url && now - lastSent.at < 500) return;
      lastSent = { url, at: now };
      ipc.send(IPC.OPEN_EXTERNAL_URL, url);
    },
    // Lets the click fallback detect whether native activation already
    // handled the current click.
    get lastSentAt() {
      return lastSent.at;
    }
  };
}

class TerminalManager {
  constructor() {
    this.terminals = new Map(); // Map<id, {terminal, fitAddon, element, state}>
    this._inputLineBuffers = new Map(); // Map<terminalId, currentInputLine>
    this._aiToolHeuristicSetAt = new Map(); // Map<terminalId, timestamp of last heuristic tag>
    this.activeTerminalId = null;
    this.viewMode = 'tabs'; // 'tabs' or 'grid'
    this.gridLayout = '2x2';
    this.maxTerminals = 10;
    this.terminalCounter = 0;
    this.onStateChange = null;
    this.onFilePathActivate = null; // callback(filePath, line, col) for file path links
    this.currentProjectPath = null; // Current active project (null = global)
    this._setupIPC();
  }

  _countTerminalsForProject(projectPath) {
    return Array.from(this.terminals.values())
      .filter((t) => t.state.projectPath === projectPath)
      .length;
  }

  _getProjectTerminalEntries(projectPath) {
    return Array.from(this.terminals.entries())
      .filter(([, instance]) => instance.state.projectPath === projectPath)
      .sort(([, a], [, b]) => this._compareTerminalState(a.state, b.state));
  }

  _compareTerminalState(a, b) {
    const aOrder = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;

    const aCreated = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bCreated = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;

    return String(a.id).localeCompare(String(b.id));
  }

  _getNextOrderForProject(projectPath) {
    const entries = this._getProjectTerminalEntries(projectPath);
    if (entries.length === 0) return 0;
    const lastOrder = entries[entries.length - 1][1].state.order;
    if (!Number.isFinite(lastOrder)) return entries.length;
    return lastOrder + 1;
  }

  _normalizeProjectOrder(projectPath) {
    const entries = this._getProjectTerminalEntries(projectPath);
    entries.forEach(([, instance], index) => {
      instance.state.order = index;
    });
  }

  _applyProjectOrder(projectPath, orderedIds = []) {
    const entries = this._getProjectTerminalEntries(projectPath);
    const byId = new Map(entries.map(([id, instance]) => [id, instance]));
    const ordered = [];

    orderedIds.forEach((id) => {
      if (byId.has(id)) {
        ordered.push([id, byId.get(id)]);
        byId.delete(id);
      }
    });

    const remaining = Array.from(byId.entries())
      .sort(([, a], [, b]) => this._compareTerminalState(a.state, b.state));
    const finalOrder = [...ordered, ...remaining];
    finalOrder.forEach(([, instance], index) => {
      instance.state.order = index;
    });
  }

  async _invokeWithTimeout(promise, timeoutMs, timeoutMessage) {
    let timeoutId = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  _pasteInChunks(terminal, rawText) {
    const text = (rawText || '').replace(/\r\n/g, '\n');
    if (!text) return false;

    // Small payloads can go directly without noticeable jank.
    const DIRECT_PASTE_LIMIT = 8192;
    if (text.length <= DIRECT_PASTE_LIMIT) {
      terminal.paste(text);
      return true;
    }

    const CHUNK_SIZE = 1024;
    let index = 0;

    const pump = () => {
      if (index >= text.length) return;
      terminal.paste(text.slice(index, index + CHUNK_SIZE));
      index += CHUNK_SIZE;
      setTimeout(pump, 0);
    };

    pump();
    return true;
  }

  /**
   * Resolve a drop payload to shell-quoted paths (or fallback text) and paste.
   * Handles: internal file-tree drags, OS files with real paths, in-memory
   * files without paths (saved to temp), file:///data:/http(s) URI lists,
   * and plain text.
   */
  async _handleTerminalDrop(terminal, { vibeconsoleFile, files, uriList, html, text }) {
    // 1. Internal drag from file tree (custom MIME)
    if (vibeconsoleFile) {
      this._pasteInChunks(terminal, shellQuote(vibeconsoleFile) + ' ');
      return;
    }

    // 2. File objects: real path when available, otherwise materialize the
    // in-memory contents (screenshots, images dragged from other apps) to temp.
    if (files.length > 0) {
      const paths = [];
      for (const file of files) {
        const realPath = getPathForFile(file);
        const resolved = realPath || await this._saveDroppedFileToTemp(file);
        if (resolved) paths.push(shellQuote(resolved));
      }
      if (paths.length > 0) {
        this._pasteInChunks(terminal, paths.join(' ') + ' ');
        return;
      }
    }

    // 3. URI list: local file URLs become paths; data:/remote image URLs are
    // materialized to temp files (e.g. images dragged out of a browser).
    if (uriList) {
      const uris = uriList.split(/\r?\n/).map(u => u.trim()).filter(u => u && !u.startsWith('#'));
      const looksLikeImageDrag = /<img[\s>]/i.test(html || '') || uris.some(u => /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|heic|avif)(\?|#|$)/i.test(u));
      const paths = [];
      for (const uri of uris) {
        const resolved = await this._resolveDroppedUri(uri, looksLikeImageDrag);
        if (resolved) paths.push(shellQuote(resolved));
      }
      if (paths.length > 0) {
        this._pasteInChunks(terminal, paths.join(' ') + ' ');
        return;
      }
    }

    // 4. Fallback: plain text (also covers non-image URL drags)
    if (text) {
      this._pasteInChunks(terminal, text + ' ');
    }
  }

  async _saveDroppedFileToTemp(file) {
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await ipcRenderer.invoke(IPC.SAVE_DROPPED_FILE, {
        name: file.name || 'dropped-file',
        data
      });
      return result?.success ? result.path : null;
    } catch {
      return null;
    }
  }

  async _resolveDroppedUri(uri, downloadRemote) {
    if (uri.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(uri).pathname);
      } catch {
        return null;
      }
    }
    if (uri.startsWith('data:')) {
      const file = this._dataUrlToFile(uri);
      return file ? this._saveDroppedFileToTemp(file) : null;
    }
    if (downloadRemote && /^https?:\/\//i.test(uri)) {
      try {
        const result = await ipcRenderer.invoke(IPC.DOWNLOAD_URL_TO_TEMP, uri);
        return result?.success ? result.path : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  _dataUrlToFile(dataUrl) {
    try {
      const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
      if (!match) return null;
      const [, mime, isBase64, payload] = match;
      const raw = isBase64 ? atob(payload) : decodeURIComponent(payload);
      const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      const ext = (mime.split('/')[1] || 'bin').split('+')[0];
      return new File([bytes], `dropped-image.${ext}`, { type: mime || 'application/octet-stream' });
    } catch {
      return null;
    }
  }

  _isAtOrNearBottom(terminal, thresholdLines = 1) {
    if (!terminal) return true;
    const buf = terminal.buffer?.active;
    if (!buf) return true;
    // xterm: at bottom when viewportY === baseY. Using a small threshold avoids
    // getting "stuck" 1-2 lines above bottom after resizes/reflows.
    return (buf.baseY - buf.viewportY) <= thresholdLines;
  }

  _syncScrollDownButton(instance) {
    if (!instance || !instance.scrollBtn || !instance.terminal) return;
    const isAtBottom = this._isAtOrNearBottom(instance.terminal, 1);
    instance.scrollBtn.classList.toggle('visible', !isAtBottom);
  }

  _writeKeepingBottom(instance, data) {
    // xterm follows output until the user scrolls away, including while writes
    // are queued. A pre-write snapshot is stale by the time parsing finishes
    // and would override a wheel/scrollbar movement made in the meantime.
    instance.terminal.write(data, () => {
      if (typeof instance.scheduleSyncScrollBtn === 'function') {
        instance.scheduleSyncScrollBtn();
      } else {
        this._syncScrollDownButton(instance);
      }
    });
  }

  /**
   * Set current project context
   * @param {string|null} projectPath - Project path or null for global
   */
  setCurrentProject(projectPath) {
    // Save current project session before switching
    if (this.currentProjectPath !== projectPath) {
      this.saveProjectSession(this.currentProjectPath);
    }

    this.currentProjectPath = projectPath;

    // Restore session for new project
    this.restoreProjectSession(projectPath);

    this._notifyStateChange();
  }

  /**
   * Get current project path
   */
  getCurrentProject() {
    return this.currentProjectPath;
  }

  /**
   * Get terminals for a specific project
   * @param {string|null} projectPath - Project path or null for global
   */
  getTerminalsByProject(projectPath) {
    return this._getProjectTerminalEntries(projectPath)
      .map(([, instance]) => ({ ...instance.state }));
  }

  /**
   * Save project session to localStorage
   * @param {string|null} projectPath - Project path or null for global
   */
  saveProjectSession(projectPath) {
    const sessionKey = projectPath || GLOBAL_PROJECT_KEY;
    const projectTerminals = this.getTerminalsByProject(projectPath);

    if (projectTerminals.length === 0) {
      return; // Nothing to save
    }

    const sessionData = {
      activeTerminalId: this.activeTerminalId,
      viewMode: this.viewMode,
      gridLayout: this.gridLayout,
      terminalNames: {}, // Map of terminalId -> customName
      terminalOrder: projectTerminals.map((t) => t.id)
    };

    // Save custom names
    projectTerminals.forEach(t => {
      if (t.customName) {
        sessionData.terminalNames[t.id] = t.customName;
      }
    });

    try {
      const allSessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
      allSessions[sessionKey] = sessionData;
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(allSessions));
    } catch (err) {
      console.error('Failed to save terminal session:', err);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  /**
   * Restore project session from localStorage
   * @param {string|null} projectPath - Project path or null for global
   */
  restoreProjectSession(projectPath) {
    const sessionKey = projectPath || GLOBAL_PROJECT_KEY;

    try {
      const allSessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
      const sessionData = allSessions[sessionKey];

      if (sessionData) {
        // Restore view settings
        if (sessionData.viewMode) {
          this.viewMode = sessionData.viewMode;
        }
        if (sessionData.gridLayout) {
          this.gridLayout = sessionData.gridLayout;
        }

        // Restore custom names for existing terminals
        const projectTerminals = this.getTerminalsByProject(projectPath);
        if (Array.isArray(sessionData.terminalOrder)) {
          this._applyProjectOrder(projectPath, sessionData.terminalOrder);
        }
        projectTerminals.forEach(t => {
          if (sessionData.terminalNames && sessionData.terminalNames[t.id]) {
            const instance = this.terminals.get(t.id);
            if (instance) {
              instance.state.customName = sessionData.terminalNames[t.id];
              instance.state.name = sessionData.terminalNames[t.id];
            }
          }
        });

        // Restore active terminal if it belongs to current project
        if (sessionData.activeTerminalId) {
          const terminal = this.terminals.get(sessionData.activeTerminalId);
          if (terminal && terminal.state.projectPath === projectPath) {
            this.setActiveTerminal(sessionData.activeTerminalId);
            return;
          }
        }
      }

      // If no valid active terminal found, select first terminal of current project
      const projectTerminals = this.getTerminalsByProject(projectPath);
      if (projectTerminals.length > 0) {
        this.setActiveTerminal(projectTerminals[0].id);
      } else {
        this.activeTerminalId = null;
      }
    } catch (err) {
      console.error('Failed to restore terminal session:', err);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  /**
   * Create a new terminal
   * @param {Object} [options] - Options for terminal creation
   * @param {string|null} [options.cwd] - Working directory
   * @param {string|null} [options.projectPath] - Associated project path (undefined = use current)
   * @param {string} [options.name] - Custom terminal name
   * @param {string|null} [options.shell] - Shell path to use
   * @param {string|null} [options.aiTool] - AI tool id associated with this terminal
   */
  async createTerminal(options = {}) {
    // Use provided projectPath or current project
    const projectPath = options.projectPath !== undefined
      ? options.projectPath
      : this.currentProjectPath;

    if (this._countTerminalsForProject(projectPath) >= this.maxTerminals) {
      throw new Error(`Maximum terminal limit (${this.maxTerminals}) reached for this project`);
    }

    // Working directory: use provided cwd, or project path, or home directory
    const workingDir = options.cwd || projectPath || null;

    const response = await this._invokeWithTimeout(
      ipcRenderer.invoke(IPC.TERMINAL_CREATE, {
        cwd: workingDir,
        projectPath,
        shell: options.shell || null
      }),
      12000,
      'Terminal creation timed out'
    );

    if (response.success) {
      this._initializeTerminal(response.terminalId, {
        ...options,
        projectPath,
        cwd: workingDir
      });
      return response.terminalId;
    } else {
      throw new Error(response.error);
    }
  }

  /**
   * Get available shells from main process
   * @returns {Promise<Array<{id: string, name: string, path: string}>>}
   */
  async getAvailableShells() {
    const response = await ipcRenderer.invoke(IPC.GET_AVAILABLE_SHELLS);
    if (response.success) {
      return response.shells;
    } else {
      throw new Error(response.error || 'Failed to get available shells');
    }
  }

  /**
   * Initialize xterm.js instance for a terminal
   */
  _initializeTerminal(terminalId, options) {
    const linkHandler = createTerminalLinkHandler();
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Geist Mono", "SF Mono", Consolas, monospace',
      theme: terminalTheme(window.vibeAppearance?.values || variables(defaults()).values),
      allowTransparency: false,
      scrollback: 10000,
      // OSC 8 hyperlinks otherwise use xterm's built-in warning dialog.
      linkHandler
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new ScrollbackClearAddon());

    const webLinksAddon = new WebLinksAddon(linkHandler.activate);
    terminal.loadAddon(webLinksAddon);

    // File path link provider (e.g. src/renderer/editor.js:42 → open in editor)
    registerFilePathLinks(terminal, (filePath, line, col) => {
      if (this.onFilePathActivate) {
        this.onFilePathActivate(filePath, line, col);
      }
    });

    // Protocol-less web URLs (form-drive.vercel.app, www.*, localhost:3000);
    // WebLinksAddon only covers http(s):// text.
    registerBareUrlLinks(terminal, linkHandler.activate);

    // Create container element
    const element = document.createElement('div');
    element.id = `terminal-${terminalId}`;
    element.className = 'terminal-instance';
    element.style.height = '100%';
    element.style.width = '100%';

    // Scroll-to-bottom button
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'terminal-scroll-down';
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    element.appendChild(scrollBtn);

    const syncScrollBtn = () => {
      const isAtBottom = this._isAtOrNearBottom(terminal, 1);
      scrollBtn.classList.toggle('visible', !isAtBottom);
    };

    let syncRafId = null;
    const scheduleSyncScrollBtn = () => {
      if (syncRafId) return;
      syncRafId = requestAnimationFrame(() => {
        syncRafId = null;
        syncScrollBtn();
      });
    };

    scrollBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      terminal.scrollToBottom();
      terminal.focus();
      scheduleSyncScrollBtn();
    });

    // Track scroll position to show/hide scroll button
    terminal.onScroll(scheduleSyncScrollBtn);
    terminal.onRender(scheduleSyncScrollBtn);
    element.addEventListener('wheel', scheduleSyncScrollBtn, { passive: true });
    // Some programmatic scroll changes (fit/restore) may not emit onScroll reliably.
    scheduleSyncScrollBtn();

    // Focus terminal on click anywhere in the container
    element.addEventListener('click', () => {
      terminal.focus();
    });

    // Keep link clicks reliable while TUIs capture the mouse or output is
    // streaming: xterm's native activation silently drops those clicks.
    attachClickLinkFallback(terminal, element, linkHandler);

    // Drag & drop: paste file paths into terminal
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.add('drag-over');
    });

    element.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');

      // dataTransfer is only readable during the event; capture everything
      // synchronously, then resolve paths asynchronously.
      const payload = {
        vibeconsoleFile: e.dataTransfer.getData('application/x-vibeconsole-file'),
        files: Array.from(e.dataTransfer.files || []),
        uriList: e.dataTransfer.getData('text/uri-list'),
        html: e.dataTransfer.getData('text/html'),
        text: e.dataTransfer.getData('text/plain')
      };
      this._handleTerminalDrop(terminal, payload);
    });

    const isCodeMatch = (event, code) => event.code === code || event.key.toLowerCase() === code.slice(-1).toLowerCase();
    const pasteClipboardText = (text) => {
      return this._pasteInChunks(terminal, text);
    };
    const pasteFromSystemClipboard = () => pasteClipboardText(clipboard?.readText() ?? '');

    const state = {
      id: terminalId,
      name: options.name || `Terminal ${++this.terminalCounter}`,
      customName: null,
      isActive: false,
      createdAt: Date.now(),
      order: this._getNextOrderForProject(options.projectPath !== undefined ? options.projectPath : this.currentProjectPath),
      projectPath: options.projectPath !== undefined ? options.projectPath : this.currentProjectPath,
      aiTool: options.aiTool || null,
      aiToolProcessDetected: false
    };

    this.terminals.set(terminalId, {
      terminal,
      fitAddon,
      element,
      scrollBtn,
      syncScrollBtn,
      scheduleSyncScrollBtn,
      state,
      lastSentCols: null,
      lastSentRows: null
    });

    if (state.aiTool) {
      // Creation-time tag (Start button): protect it until the start command runs
      this._aiToolHeuristicSetAt.set(terminalId, Date.now());
    }

    // Allow app-level shortcuts to pass through when terminal has focus
    terminal.attachCustomKeyEventHandler((event) => {
      const modKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (event.type === 'keydown') {
        const isCopyMeta = event.metaKey && isCodeMatch(event, 'KeyC');
        const isCopyCtrlShift = event.ctrlKey && event.shiftKey && isCodeMatch(event, 'KeyC');
        const isCopyCtrl = event.ctrlKey && !event.shiftKey && !event.altKey && isCodeMatch(event, 'KeyC');
        const isCopyShortcut = isCopyMeta || isCopyCtrlShift || isCopyCtrl;

        if (isCopyShortcut && terminal.hasSelection()) {
          writeClipboardText(terminal.getSelection());
          terminal.clearSelection();
          return false;
        }
        // Let Ctrl+C continue to terminal when nothing is selected (SIGINT, etc.).
        if (isCopyCtrl) {
          return true;
        }
        // Swallow copy shortcuts with no selection to avoid accidental control chars.
        if (isCopyMeta || isCopyCtrlShift) {
          return false;
        }

        // Paste: Ctrl/Cmd+V, Ctrl+Shift+V, Shift+Insert
        const isPasteMeta = event.metaKey && isCodeMatch(event, 'KeyV');
        const isPasteCtrl = event.ctrlKey && !event.altKey && isCodeMatch(event, 'KeyV');
        const isPasteShiftInsert = !modKey && event.shiftKey && (event.code === 'Insert' || event.key === 'Insert');
        if (isPasteMeta || isPasteCtrl) {
          // Let the paste event flow run for Cmd/Ctrl+V to avoid duplicate inserts.
          return true;
        }
        if (isPasteShiftInsert) {
          // Shift+Insert may not trigger native paste reliably across platforms.
          if (pasteFromSystemClipboard()) {
            event.preventDefault();
            return false;
          }
          return true;
        }
      }

      // Ctrl/Cmd + Shift combinations → pass to app
      if (modKey && event.shiftKey) {
        return false;
      }
      // Ctrl/Cmd + 1-9/0 → pass to app (0 maps to terminal 10)
      if (modKey && ((event.key >= '1' && event.key <= '9') || event.key === '0')) {
        return false;
      }
      // Ctrl/Cmd + K (Start Claude) → pass to app
      if (modKey && key === 'k') {
        return false;
      }
      // Ctrl/Cmd + I (/init) → pass to app
      if (modKey && key === 'i') {
        return false;
      }
      // Ctrl/Cmd + H (history) → pass to app
      if (modKey && key === 'h') {
        return false;
      }
      // Ctrl/Cmd + B (sidebar toggle) → pass to app
      if (modKey && key === 'b') {
        return false;
      }
      // Ctrl/Cmd + E (project/file focus) → pass to app
      if (modKey && key === 'e') {
        return false;
      }
      // Ctrl/Cmd + T (tasks panel) → pass to app (without shift)
      if (modKey && !event.shiftKey && key === 't') {
        return false;
      }
      // Ctrl/Cmd + [ or ] (project navigation) → pass to app
      if (modKey && (event.key === '[' || event.key === ']')) {
        return false;
      }
      // Ctrl/Cmd + Tab → pass to app
      if (modKey && event.key === 'Tab') {
        return false;
      }
      // Let terminal handle everything else
      return true;
    });

    // Intercept native paste (Cmd/Ctrl+V) so very large payloads are chunked.
    element.addEventListener('paste', (e) => {
      const text = e?.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      pasteClipboardText(text);
    });

    // Right-click paste
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      pasteFromSystemClipboard();
    });

    // Handle input
    terminal.onData((data) => {
      this._trackInputForAiTool(terminalId, data);
      ipcRenderer.send(IPC.TERMINAL_INPUT_ID, { terminalId, data });
    });

    // If first terminal or no active terminal, make it active
    if (this.terminals.size === 1 || !this.activeTerminalId) {
      this.setActiveTerminal(terminalId);
    }

    this._renumberTerminals(state.projectPath);
    this._notifyStateChange();
    return terminalId;
  }

  /**
   * Mount terminal in a container
   */
  mountTerminal(terminalId, container) {
    const instance = this.terminals.get(terminalId);
    if (instance && container) {
      if (instance.element.parentElement === container) return;
      const mountVersion = (instance.mountVersion || 0) + 1;
      instance.mountVersion = mountVersion;

      // Clear container first
      container.innerHTML = '';

      // Ensure element has proper sizing
      instance.element.style.height = '100%';
      instance.element.style.width = '100%';

      container.appendChild(instance.element);

      // Open terminal if not already opened
      if (!instance.opened) {
        instance.terminal.open(instance.element);
        instance.opened = true;
      }
      instance.needsViewportSync = true;
      this._syncRemountedViewport(instance);

      // Fit the completed layout. Never restore a pre-mount scroll snapshot:
      // output, reflow, or user input may already have changed the viewport.
      requestAnimationFrame(() => {
        if (this.terminals.get(terminalId) !== instance ||
            instance.mountVersion !== mountVersion ||
            instance.element.parentElement !== container || !this._isInDOM(instance)) return;
        this._fitInstance(terminalId, instance);
        if (this.activeTerminalId === terminalId) {
          instance.terminal.focus();
        }
      });
    }
  }

  /**
   * Set active terminal
   */
  setActiveTerminal(terminalId) {
    if (this.activeTerminalId === terminalId) {
      // Already active, just ensure focus. isActive is re-asserted rather than
      // assumed: the id can already point at this terminal before its state was
      // marked active (e.g. when succeeding a closed terminal).
      const current = this.terminals.get(terminalId);
      if (current) {
        current.state.isActive = true;
        current.terminal.focus();
      }
      return;
    }

    // Update previous active
    if (this.activeTerminalId) {
      const prev = this.terminals.get(this.activeTerminalId);
      if (prev) prev.state.isActive = false;
    }

    // Set new active
    this.activeTerminalId = terminalId;
    const current = this.terminals.get(terminalId);
    if (current) {
      current.state.isActive = true;
      current.terminal.focus();
    }

    this._notifyStateChange();
  }

  /**
   * Rename terminal
   */
  renameTerminal(terminalId, newName) {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      instance.state.customName = newName;
      instance.state.name = newName;
      this._notifyStateChange();
    }
  }

  /**
   * Associate an AI tool with a terminal.
   * @param {string} terminalId - Terminal ID
   * @param {'claude'|'codex'|null} aiTool - Tool identifier
   */
  setTerminalAiTool(terminalId, aiTool) {
    const instance = this.terminals.get(terminalId);
    if (!instance) return;

    if (instance.state.aiTool === aiTool && instance.state.aiToolProcessDetected === false) return;

    instance.state.aiTool = aiTool;
    instance.state.aiToolProcessDetected = false;
    this._notifyStateChange();
  }

  /**
   * Close terminal
   */
  closeTerminal(terminalId) {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      this._inputLineBuffers.delete(terminalId);
      this._aiToolHeuristicSetAt.delete(terminalId);
      instance.terminal.dispose();
      instance.element.remove();
      this.terminals.delete(terminalId);
      ipcRenderer.send(IPC.TERMINAL_DESTROY, terminalId);

      if (this.activeTerminalId === terminalId) {
        // Select from same project's terminals, not all terminals
        const projectTerminals = this.getTerminalsByProject(instance.state.projectPath);
        if (projectTerminals.length > 0) {
          // Leave activeTerminalId pointing at the closed id so setActiveTerminal
          // takes its full path and marks the successor active.
          this.setActiveTerminal(projectTerminals[projectTerminals.length - 1].id);
        } else {
          this.activeTerminalId = null;
        }
      }

      this._renumberTerminals(instance.state.projectPath);
      this._notifyStateChange();
    }
  }

  /**
   * Set view mode
   */
  setViewMode(mode) {
    this.viewMode = mode;
    this._notifyStateChange();
  }

  /**
   * Set grid layout
   */
  setGridLayout(layout) {
    this.gridLayout = layout;
    this._notifyStateChange();
  }

  moveTerminal(terminalId, targetIndex) {
    const instance = this.terminals.get(terminalId);
    if (!instance) return;

    const projectPath = instance.state.projectPath;
    const entries = this._getProjectTerminalEntries(projectPath);
    if (entries.length <= 1) return;

    const fromIndex = entries.findIndex(([id]) => id === terminalId);
    if (fromIndex === -1) return;

    const boundedTarget = Math.max(0, Math.min(targetIndex, entries.length - 1));
    if (fromIndex === boundedTarget) return;

    const [moved] = entries.splice(fromIndex, 1);
    entries.splice(boundedTarget, 0, moved);
    entries.forEach(([, item], index) => {
      item.state.order = index;
    });

    this._renumberTerminals(projectPath);
    this._notifyStateChange();
  }

  moveTerminalToStart(terminalId) {
    this.moveTerminal(terminalId, 0);
  }

  moveTerminalToEnd(terminalId) {
    const instance = this.terminals.get(terminalId);
    if (!instance) return;
    const entries = this._getProjectTerminalEntries(instance.state.projectPath);
    if (entries.length === 0) return;
    this.moveTerminal(terminalId, entries.length - 1);
  }

  /**
   * Get all terminal states (filtered by current project)
   * @param {boolean} allProjects - If true, return all terminals regardless of project
   */
  getTerminalStates(allProjects = false) {
    let terminals = Array.from(this.terminals.values());

    if (!allProjects) {
      // Filter by current project
      terminals = terminals.filter(t => t.state.projectPath === this.currentProjectPath);
    }

    return terminals
      .map(t => ({ ...t.state }))
      .sort((a, b) => this._compareTerminalState(a, b));
  }

  /**
   * Get terminal instance
   */
  getTerminal(terminalId) {
    return this.terminals.get(terminalId);
  }

  /**
   * Get active terminal state.
   * @returns {Object|null}
   */
  getActiveTerminalState() {
    if (!this.activeTerminalId) return null;
    const instance = this.terminals.get(this.activeTerminalId);
    if (!instance) return null;
    return { ...instance.state };
  }

  _syncRemountedViewport(instance) {
    if (!instance.needsViewportSync || !instance.element.clientWidth || !instance.element.clientHeight) return;
    // xterm 5.5 caches scrollTop across DOM detach; native sync must see the reset DOM value.
    const viewport = instance.terminal._core.viewport;
    viewport._lastScrollTop = instance.terminal.element.querySelector('.xterm-viewport').scrollTop;
    viewport.syncScrollArea(true);
    instance.needsViewportSync = false;
  }

  _fitInstance(terminalId, instance) {
    // Connected is not the same as measurable: a hidden ancestor makes the
    // fit addon infer a tiny terminal from percentage styles. That reflows and
    // trims history, and sends a bogus SIGWINCH to the CLI before it is shown.
    if (!instance.element.clientWidth || !instance.element.clientHeight) {
      instance.needsViewportSync = true;
      return;
    }
    const wasAtBottom = this._isAtOrNearBottom(instance.terminal, 0);
    const colsBefore = instance.terminal.cols;
    const rowsBefore = instance.terminal.rows;
    const buffer = instance.terminal.buffer.active;
    // A marker follows the visible line through wrapping and scrollback trims.
    // A raw viewportY would point at different text after a column resize.
    const anchor = !wasAtBottom && buffer.type === 'normal'
      ? instance.terminal.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY)
      : null;
    try {
      instance.fitAddon.fit();
      if (anchor && !anchor.isDisposed) {
        instance.terminal.scrollToLine(anchor.line);
      }
    } finally {
      anchor?.dispose();
    }
    const sizeChanged = colsBefore !== instance.terminal.cols || rowsBefore !== instance.terminal.rows;
    if (sizeChanged) {
      this._sendResize(terminalId);
    }
    if (sizeChanged && wasAtBottom) {
      instance.terminal.scrollToBottom();
    }
    this._syncRemountedViewport(instance);
    this._syncScrollDownButton(instance);
  }

  /**
   * Fit all mounted terminals and push resize events only when geometry changed.
   */
  fitAll() {
    for (const [id, instance] of this.terminals) {
      if (instance.opened && this._isInDOM(instance)) {
        try {
          this._fitInstance(id, instance);
        } catch (err) {
          console.error(`Failed to fit terminal ${id}:`, err);
        }
      }
    }
  }

  /**
   * Fit specific mounted terminal and send resize only if needed.
   */
  fitTerminal(terminalId) {
    const instance = this.terminals.get(terminalId);
    if (instance && instance.opened && this._isInDOM(instance)) {
      this._fitInstance(terminalId, instance);
    }
  }

  /**
   * Write to active terminal
   */
  writeToActive(data) {
    if (this.activeTerminalId) {
      const instance = this.terminals.get(this.activeTerminalId);
      if (instance) {
        this._writeKeepingBottom(instance, data);
      }
    }
  }

  /**
   * Send command to active terminal or specific terminal
   * @param {string} command - Command to send
   * @param {string} [terminalId] - Optional specific terminal ID
   */
  sendCommand(command, terminalId = null) {
    const targetId = terminalId || this.activeTerminalId;
    
    if (targetId) {
      this._detectAiToolFromCommand(targetId, command);
      ipcRenderer.send(IPC.TERMINAL_INPUT_ID, {
        terminalId: targetId,
        data: command + '\r'
      });
    }
  }

  /**
   * Paste text into a terminal without submitting it.
   * @param {string} text - Text to paste
   * @param {string} [terminalId] - Optional target terminal ID
   * @returns {boolean} Whether the text was accepted for paste
   */
  pasteText(text, terminalId = null) {
    const targetId = terminalId || this.activeTerminalId;
    if (!targetId) return false;

    const instance = this.terminals.get(targetId);
    if (!instance) return false;
    return this._pasteInChunks(instance.terminal, text);
  }

  // Private methods
  _isInDOM(instance) {
    return instance.element && instance.element.isConnected;
  }

  _sendResize(terminalId) {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      const cols = instance.terminal.cols;
      const rows = instance.terminal.rows;
      if (cols <= 0 || rows <= 0) return;
      if (instance.lastSentCols === cols && instance.lastSentRows === rows) return;

      instance.lastSentCols = cols;
      instance.lastSentRows = rows;

      ipcRenderer.send(IPC.TERMINAL_RESIZE_ID, {
        terminalId,
        cols,
        rows
      });
    }
  }

  _trackInputForAiTool(terminalId, data) {
    if (!data) return;

    const sanitized = this._stripTerminalControlSequences(data);
    let buffer = this._inputLineBuffers.get(terminalId) || '';

    for (const char of sanitized) {
      if (char === '\r') {
        this._detectAiToolFromCommand(terminalId, buffer);
        buffer = '';
        continue;
      }

      if (char === '\n') continue;
      if (char === '\u0003' || char === '\u0015') { // Ctrl+C/Ctrl+U clears the typed line intent.
        buffer = '';
        continue;
      }
      if (char === '\u0008' || char === '\u007f') {
        buffer = buffer.slice(0, -1);
        continue;
      }

      if (this._isTrackableInputChar(char)) {
        buffer += char;
        if (buffer.length > 4096) {
          buffer = buffer.slice(-4096);
        }
      }
    }

    this._inputLineBuffers.set(terminalId, buffer);
  }

  _detectAiToolFromCommand(terminalId, line) {
    const aiTool = matchAiToolCommand(line);
    if (aiTool) {
      this._aiToolHeuristicSetAt.set(terminalId, Date.now());
      this.setTerminalAiTool(terminalId, aiTool);
    }
  }

  /**
   * Apply an authoritative process-based detection from the main process.
   * @param {string} terminalId - Terminal ID
   * @param {'claude'|'codex'|null} aiTool - Detected tool (null = none running)
   */
  _applyDetectedAiTool(terminalId, aiTool) {
    const instance = this.terminals.get(terminalId);
    if (!instance) return;

    if (aiTool === null) {
      // The CLI may not have appeared in the last process snapshot yet -
      // don't clear a tag the heuristic (or Start button) just set.
      const setAt = this._aiToolHeuristicSetAt.get(terminalId);
      if (setAt && (Date.now() - setAt) < AI_TOOL_DETECTION_GRACE_MS) return;
    } else {
      this._aiToolHeuristicSetAt.delete(terminalId);
    }

    const processDetected = aiTool !== null;
    if (instance.state.aiTool === aiTool && instance.state.aiToolProcessDetected === processDetected) return;

    instance.state.aiTool = aiTool;
    instance.state.aiToolProcessDetected = processDetected;
    this._notifyStateChange();
  }

  _isTrackableInputChar(char) {
    const code = char.codePointAt(0);
    if (code === undefined) return false;
    return code >= 0x20 && code !== 0x7f;
  }

  _stripTerminalControlSequences(data) {
    let result = '';
    let index = 0;

    while (index < data.length) {
      const char = data[index];

      if (char !== '\u001b') {
        result += char;
        index++;
        continue;
      }

      const next = data[index + 1];
      if (!next) {
        index++;
        continue;
      }

      // CSI: ESC [ ... final-byte(0x40-0x7E)
      if (next === '[') {
        index += 2;
        while (index < data.length) {
          const code = data.charCodeAt(index);
          index++;
          if (code >= 0x40 && code <= 0x7e) break;
        }
        continue;
      }

      // OSC: ESC ] ... BEL or ESC \
      if (next === ']') {
        index += 2;
        while (index < data.length) {
          const current = data[index];
          if (current === '\u0007') {
            index++;
            break;
          }
          if (current === '\u001b' && data[index + 1] === '\\') {
            index += 2;
            break;
          }
          index++;
        }
        continue;
      }

      // SS3: ESC O <char>
      if (next === 'O') {
        index += 3;
        continue;
      }

      // Generic ESC sequence: consume ESC + next char
      index += 2;
    }

    return result;
  }

  _notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange({
        terminals: this.getTerminalStates(),
        activeTerminalId: this.activeTerminalId,
        viewMode: this.viewMode,
        gridLayout: this.gridLayout,
        currentProjectPath: this.currentProjectPath
      });
    }
  }

  /**
   * Check if there are terminals for the current project
   */
  hasTerminalsForCurrentProject() {
    return this.getTerminalStates().length > 0;
  }

  /**
   * Clear session storage for a project (used when app restarts)
   * @param {string|null} projectPath - Project path or null for global
   */
  clearProjectSession(projectPath) {
    const sessionKey = projectPath || GLOBAL_PROJECT_KEY;
    try {
      const allSessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
      delete allSessions[sessionKey];
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(allSessions));
    } catch (err) {
      console.error('Failed to clear terminal session:', err);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  _setupIPC() {
    // Receive output from specific terminal
    ipcRenderer.on(IPC.TERMINAL_OUTPUT_ID, (event, { terminalId, data }) => {
      const instance = this.terminals.get(terminalId);
      if (instance) {
        this._writeKeepingBottom(instance, data);
      }
    });

    // Handle terminal destroyed from main process
    ipcRenderer.on(IPC.TERMINAL_DESTROYED, (event, { terminalId }) => {
      if (this.terminals.has(terminalId)) {
        this.closeTerminal(terminalId);
      }
    });

    // Authoritative per-terminal AI tool detections (full snapshot each tick)
    ipcRenderer.on(IPC.TERMINAL_AI_TOOL_DETECTED, (event, { detections }) => {
      if (!detections) return;
      for (const [terminalId, aiTool] of Object.entries(detections)) {
        this._applyDetectedAiTool(terminalId, aiTool);
      }
    });
  }

  /**
   * Renumber terminals for a project to ensure sequential naming (Terminal 1, Terminal 2, ...)
   * Only affects terminals without custom names. Only notifies if names actually changed.
   */
  _renumberTerminals(projectPath) {
    this._normalizeProjectOrder(projectPath);
    const terminals = this.getTerminalsByProject(projectPath);
    let changed = false;

    terminals.forEach((tState, index) => {
      const instance = this.terminals.get(tState.id);
      if (instance && !instance.state.customName) {
        const newName = `Terminal ${index + 1}`;
        if (instance.state.name !== newName) {
          instance.state.name = newName;
          changed = true;
        }
      }
    });

    // Only notify if names actually changed
    if (changed) {
      this._notifyStateChange();
    }
  }
}

module.exports = { TerminalManager, createTerminalLinkHandler };
