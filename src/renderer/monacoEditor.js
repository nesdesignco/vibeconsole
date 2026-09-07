/**
 * Monaco-backed code editor adapter
 */

require('monaco-editor/esm/vs/editor/editor.all.js');
require('monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js');
require('monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js');
require('monaco-editor/esm/vs/language/json/monaco.contribution.js');
require('monaco-editor/esm/vs/language/css/monaco.contribution.js');
require('monaco-editor/esm/vs/language/html/monaco.contribution.js');
require('monaco-editor/esm/vs/language/typescript/monaco.contribution.js');
require('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js');
require('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js');
require('monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js');
require('monaco-editor/esm/vs/basic-languages/python/python.contribution.js');
require('monaco-editor/esm/vs/basic-languages/go/go.contribution.js');
require('monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js');
require('monaco-editor/esm/vs/basic-languages/java/java.contribution.js');
require('monaco-editor/esm/vs/basic-languages/php/php.contribution.js');
require('monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js');
require('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js');
require('monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js');
require('monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js');
require('monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js');

const monaco = require('monaco-editor/esm/vs/editor/editor.api.js');

const WORKER_BY_LABEL = {
  json: 'monaco-json.worker.js',
  css: 'monaco-css.worker.js',
  scss: 'monaco-css.worker.js',
  less: 'monaco-css.worker.js',
  html: 'monaco-html.worker.js',
  handlebars: 'monaco-html.worker.js',
  razor: 'monaco-html.worker.js',
  javascript: 'monaco-ts.worker.js',
  typescript: 'monaco-ts.worker.js'
};

const LANGUAGE_BY_EXTENSION = {
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  php: 'php',
  rb: 'ruby',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sql: 'sql',
  dockerfile: 'dockerfile'
};

let editor = null;
let model = null;
let container = null;
let changeDisposable = null;
let cursorDisposable = null;
let callbacks = {};
let wordWrapEnabled = false;
let minimapEnabled = false;

function distUrl(fileName) {
  return new URL(`dist/${fileName}`, window.location.href).toString();
}

function setupWorkers() {
  window.MonacoEnvironment = {
    getWorker(_workerId, label) {
      const fileName = WORKER_BY_LABEL[label] || 'monaco-editor.worker.js';
      return new Worker(distUrl(fileName), { name: `monaco-${label || 'editor'}` });
    }
  };
}

function registerTheme() {
  const { defaults, variables, alpha } = require('../shared/appearance');
  const { mode, values: c } = window.vibeAppearance || variables(defaults());
  monaco.editor.defineTheme('vibe', {
    base: mode === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: c['text-primary'].slice(1), background: c['bg-primary'].slice(1) },
      { token: 'comment', foreground: c['text-tertiary'].slice(1), fontStyle: 'italic' },
      { token: 'keyword', foreground: c['accent-primary'].slice(1) },
      { token: 'string', foreground: c['ansi-green'].slice(1) },
      { token: 'number', foreground: c['ansi-yellow'].slice(1) },
      { token: 'type', foreground: c['ansi-blue'].slice(1) }
    ],
    colors: {
      'editor.background': c['bg-primary'],
      'editor.foreground': c['text-primary'],
      'editorLineNumber.foreground': c['text-muted'],
      'editorLineNumber.activeForeground': c['text-secondary'],
      'editorCursor.foreground': c['accent-primary'],
      'editor.selectionBackground': alpha(c['accent-primary'], 0.25),
      'editor.inactiveSelectionBackground': c['accent-subtle'],
      'editor.lineHighlightBackground': alpha(c['text-primary'], 0.03),
      'editorIndentGuide.background1': c['border-subtle'],
      'editorIndentGuide.activeBackground1': c['border-default'],
      'editorWidget.background': c['bg-tertiary'],
      'editorWidget.border': c['border-default'],
      'editorSuggestWidget.background': c['bg-tertiary'],
      'editorSuggestWidget.border': c['border-default'],
      'editorSuggestWidget.selectedBackground': c['bg-hover'],
      'input.background': c['bg-primary'],
      'input.border': c['border-default'],
      'focusBorder': c['accent-primary']
    }
  });
}
window.addEventListener('vibe:appearance-changed', () => {
  if (editor) { registerTheme(); monaco.editor.setTheme('vibe'); }
});

function languageForPath(filePath, extension) {
  const base = ((filePath || '').replace(/\\/g, '/')).split('/').pop() || '';
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  return LANGUAGE_BY_EXTENSION[(extension || '').toLowerCase()] || 'plaintext';
}

function uriForPath(filePath) {
  const normalized = String(filePath || 'untitled').replace(/\\/g, '/');
  const safePath = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return monaco.Uri.file(safePath);
}

function init(target, options = {}) {
  if (!target) return false;
  if (editor) return true;

  setupWorkers();
  registerTheme();

  container = target;
  callbacks = options;
  editor = monaco.editor.create(container, {
    automaticLayout: true,
    bracketPairColorization: { enabled: true },
    contextmenu: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    detectIndentation: true,
    fontFamily: "'Geist Mono', 'SF Mono', Consolas, monospace",
    fontLigatures: true,
    fontSize: 13,
    formatOnPaste: false,
    formatOnType: false,
    glyphMargin: true,
    guides: { bracketPairs: true, indentation: true },
    lineDecorationsWidth: 10,
    lineHeight: 22,
    lineNumbers: 'on',
    minimap: { enabled: false, scale: 1, showSlider: 'mouseover' },
    mouseWheelZoom: true,
    overviewRulerBorder: false,
    padding: { top: 14, bottom: 14 },
    renderLineHighlight: 'line',
    renderWhitespace: 'selection',
    roundedSelection: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    stickyScroll: { enabled: false },
    tabSize: 2,
    theme: 'vibe',
    wordWrap: 'off'
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (callbacks.onSave) callbacks.onSave();
  });
  editor.addCommand(monaco.KeyCode.Escape, () => {
    if (callbacks.onClose) callbacks.onClose();
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => {
    if (callbacks.onCommandPalette) callbacks.onCommandPalette();
  });

  changeDisposable = editor.onDidChangeModelContent(() => {
    if (callbacks.onChange) callbacks.onChange();
  });

  cursorDisposable = editor.onDidChangeCursorPosition((event) => {
    if (callbacks.onCursorChange) {
      callbacks.onCursorChange(event.position.lineNumber, event.position.column);
    }
  });

  return true;
}

function setDocument({ content, filePath, extension, line, col }) {
  if (!editor) return;

  const language = languageForPath(filePath, extension);
  const uri = uriForPath(filePath);
  const existingModel = monaco.editor.getModel(uri);
  const nextModel = existingModel || monaco.editor.createModel(content || '', language, uri);

  if (existingModel && existingModel.getValue() !== (content || '')) {
    existingModel.setValue(content || '');
    monaco.editor.setModelLanguage(existingModel, language);
  }

  if (model && model !== nextModel && !model.isDisposed()) {
    model.dispose();
  }

  model = nextModel;
  editor.setModel(model);
  reveal(line, col);
  layout();
}

function reveal(line, col) {
  if (!editor || !model || !line) return;
  const lineNumber = Math.max(1, Math.min(Number(line) || 1, model.getLineCount()));
  const column = Math.max(1, Math.min(Number(col) || 1, model.getLineMaxColumn(lineNumber)));
  editor.setPosition({ lineNumber, column });
  editor.revealPositionInCenter({ lineNumber, column }, monaco.editor.ScrollType.Smooth);
}

function getPosition() {
  if (!editor) return null;
  return editor.getPosition();
}

function getValue() {
  if (!editor || !model) return '';
  return model.getValue();
}

async function runAction(actionId) {
  if (!editor) return false;
  const action = editor.getAction(actionId);
  if (!action) return false;
  if (typeof action.isSupported === 'function' && !action.isSupported()) return false;
  await Promise.resolve(action.run());
  editor.focus();
  return true;
}

function undo() {
  if (!model) return false;
  model.undo();
  if (editor) editor.focus();
  return true;
}

function redo() {
  if (!model) return false;
  model.redo();
  if (editor) editor.focus();
  return true;
}

function toggleWordWrap() {
  if (!editor) return wordWrapEnabled;
  wordWrapEnabled = !wordWrapEnabled;
  editor.updateOptions({ wordWrap: wordWrapEnabled ? 'on' : 'off' });
  editor.focus();
  return wordWrapEnabled;
}

function toggleMinimap() {
  if (!editor) return minimapEnabled;
  minimapEnabled = !minimapEnabled;
  editor.updateOptions({ minimap: { enabled: minimapEnabled, scale: 1, showSlider: 'mouseover' } });
  editor.focus();
  return minimapEnabled;
}

function getViewState() {
  return {
    wordWrap: wordWrapEnabled,
    minimap: minimapEnabled
  };
}

function focus() {
  if (editor) editor.focus();
}

function layout() {
  if (editor) editor.layout();
}

function isReady() {
  return Boolean(editor);
}

function dispose() {
  if (changeDisposable) changeDisposable.dispose();
  if (cursorDisposable) cursorDisposable.dispose();
  if (editor) editor.dispose();
  if (model && !model.isDisposed()) model.dispose();
  changeDisposable = null;
  cursorDisposable = null;
  editor = null;
  model = null;
  container = null;
  callbacks = {};
}

module.exports = {
  init,
  setDocument,
  reveal,
  getValue,
  getPosition,
  runAction,
  undo,
  redo,
  toggleWordWrap,
  toggleMinimap,
  getViewState,
  focus,
  layout,
  isReady,
  dispose
};
