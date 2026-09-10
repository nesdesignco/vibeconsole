const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, createElements } = require('./helpers/loadModule');
const { IPC } = require('../src/shared/ipcChannels');

function fixture(monaco = false) {
  const element = createElements(), handlers = new Map(), sent = [], timers = [], invoked = [], alerts = [];
  let confirmations = 0, allowDiscard = false, activeProject = '/project-a', text = '', onChange;
  const codeEditor = monaco ? {
    isReady: () => true, init: (_el, callbacks) => { onChange = callbacks.onChange; return true; },
    setDocument: ({ content }) => { text = content; }, getValue: () => text, focus() {}, layout() {},
    setLanguage() {}, getCursorPosition: () => ({ lineNumber: 1, column: 1 })
  } : { isReady: () => false, init: () => false };
  const editor = loadModule('src/renderer/editor.js', {
    './electronBridge': { ipcRenderer: { on: (c, fn) => handlers.set(c, fn), send: (c, data) => sent.push({ c, data }),
      invoke: async (c, data) => { invoked.push({ c, data }); return { success: true }; } } },
    './state': { getProjectPath: () => activeProject }, './monacoEditor': codeEditor,
    './lucideIcons': { renderEditorIcons() {} }
  }, { document: { getElementById: element, addEventListener() {} }, window: {},
    alert: message => alerts.push(message),
    confirm: () => { confirmations++; return allowDiscard; }, setTimeout: fn => { timers.push(fn); return timers.length; } });
  editor.init();
  function reply(request, content = 'original', success = true) {
    const image = request.c === IPC.READ_FILE_DATA_URL;
    handlers.get(image ? IPC.FILE_DATA_URL : IPC.FILE_CONTENT)(null, {
      success, requestId: request.data.requestId, filePath: request.data.filePath,
      fileName: 'file', extension: image ? 'svg' : 'txt', content, dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', error: 'fixture error'
    });
  }
  return { editor, element, sent, reply, timers, invoked, alerts,
    open: (name = '/project-a/a.txt') => { editor.openFile(name); const r = sent.at(-1); reply(r); return r; },
    edit: value => { if (monaco) { text = value; onChange(); } else { element('editor-textarea').value = value; element('editor-textarea').listeners.get('input')(); } },
    save: () => { editor.saveFile(); return sent.at(-1); },
    ack: (r, success = true) => handlers.get(IPC.FILE_SAVED)(null, { ...r.data, success, error: 'fixture error' }),
    close: () => element('btn-editor-close').listeners.get('click')(),
    confirmations: () => confirmations,
    allowDiscard: value => { allowDiscard = value; },
    project: value => { activeProject = value; }
  };
}

for (const monaco of [false, true]) {
  test(`save acknowledgement preserves subsequent edits (${monaco ? 'Monaco' : 'textarea'})`, () => {
    const f = fixture(monaco); f.open(); f.edit('saved snapshot'); const save = f.save();
    f.edit('new unsaved text'); f.ack(save); f.close();
    assert.equal(save.data.content, 'saved snapshot');
    assert.equal(f.confirmations(), 1);
    assert.equal(f.editor.isEditorOpen(), true);
    assert.equal(f.element('editor-status').textContent, 'Modified');
  });
}

test('successive save acknowledgements cannot move the saved baseline backwards', () => {
  const f = fixture(); f.open(); f.edit('first'); const first = f.save();
  f.edit('second'); const second = f.save(); f.ack(second); f.ack(first);
  f.close(); assert.equal(f.confirmations(), 0); assert.equal(f.editor.isEditorOpen(), false);
});

test('video clicks use the player without reading binary text or disturbing unsaved edits', async () => {
  const f = fixture(); f.open(); f.edit('keep this edit');
  const before = f.sent.length;
  await f.editor.openFile('/project-a/clip.MP4');
  assert.equal(f.invoked[0].c, IPC.OPEN_VIDEO);
  assert.equal(f.invoked[0].data.filePath, '/project-a/clip.MP4');
  assert.equal(f.invoked[0].data.projectPath, '/project-a');
  assert.equal(f.sent.length, before);
  assert.equal(f.confirmations(), 0);
  assert.equal(f.editor.getCurrentFile(), '/project-a/a.txt');
  assert.equal(f.element('editor-textarea').value, 'keep this edit');
  assert.equal(f.alerts.length, 0);
});

test('save error retains dirty content and original project follows the document', () => {
  const f = fixture(); f.open(); f.project('/project-b'); f.edit('new'); const save = f.save();
  assert.equal(save.data.projectPath, '/project-a');
  f.ack(save, false); f.close(); assert.equal(f.confirmations(), 1);
  assert.match(f.element('editor-status').textContent, /Save failed/);
});

test('an old save reply and status timer cannot affect a newly opened document', () => {
  const f = fixture(); f.open(); f.edit('snapshot'); const saved = f.save(); f.ack(saved);
  f.open('/project-a/b.txt'); f.edit('new B'); f.ack(saved);
  for (const timer of f.timers) timer();
  f.close(); assert.equal(f.confirmations(), 1);
  assert.equal(f.element('editor-status').textContent, 'Modified');
});

test('late reads cannot reopen a closed editor or replace a reopened same-path document', () => {
  const f = fixture(); f.open(); f.editor.openFile('/project-a/a.txt'); const stale = f.sent.at(-1);
  f.close(); f.reply(stale, 'stale'); assert.equal(f.editor.isEditorOpen(), false);
  f.open(); f.reply(stale, 'stale'); assert.equal(f.element('editor-textarea').value, 'original');
});

test('responses from another document and duplicate reads do not overwrite current text', () => {
  const f = fixture(); f.editor.openFile('/project-a/a.txt'); const stale = f.sent.at(-1);
  const current = f.open('/project-a/b.txt'); f.edit('new B'); f.reply(stale); f.reply(current);
  assert.equal(f.element('editor-textarea').value, 'new B');
});

for (const imageFirst of [true, false]) {
  test(`SVG text and image responses share one document (${imageFirst ? 'image' : 'text'} first)`, () => {
    const f = fixture(); f.editor.openFile('/project-a/icon.svg');
    const reads = f.sent.slice(-2); assert.equal(reads[0].data.requestId, reads[1].data.requestId);
    for (const r of imageFirst ? [...reads].reverse() : reads) f.reply(r, '<svg/>');
    assert.equal(f.editor.isEditorOpen(), true);
    assert.equal(f.element('editor-textarea').value, '<svg/>');
    assert.match(f.element('editor-image').src, /^data:image/);
    f.close(); for (const r of reads) f.reply(r); assert.equal(f.editor.isEditorOpen(), false);
  });
}

for (const monaco of [false, true]) {
  test(`undoing to original cannot close over an outstanding save (${monaco ? 'Monaco' : 'textarea'})`, () => {
    const f = fixture(monaco); f.open(); f.edit('pending save'); const save = f.save();
    f.edit('original'); f.close();
    assert.equal(f.editor.isEditorOpen(), true, 'must wait for the pending write');
    f.ack(save); f.close();
    assert.equal(f.editor.isEditorOpen(), true, 'undo differs from the content now on disk');
    assert.equal(f.confirmations(), 1);
  });
}

test('failed file open preserves the visible document, its project, and its ability to save', () => {
  const f = fixture(); f.open(); f.project('/project-b');
  f.editor.openFile('/project-b/unreadable.txt'); const failed = f.sent.at(-1);
  f.reply(failed, '', false);
  assert.equal(f.editor.getCurrentFile(), '/project-a/a.txt');
  assert.equal(f.element('editor-textarea').value, 'original');
  assert.equal(f.element('editor-path').textContent, '/project-a/a.txt');
  f.edit('updated A'); const save = f.save();
  assert.equal(save.c, IPC.WRITE_FILE);
  assert.equal(save.data.filePath, '/project-a/a.txt');
  assert.equal(save.data.projectPath, '/project-a');
  assert.equal(save.data.content, 'updated A');
});

test('a failed image open keeps the previous text editor active', () => {
  const f = fixture(); f.open(); f.editor.openFile('/project-a/unreadable.png');
  f.reply(f.sent.at(-1), '', false); f.edit('still editable');
  assert.equal(f.save().c, IPC.WRITE_FILE);
  assert.equal(f.element('btn-editor-save').disabled, false);
});

test('pending save blocks navigation too, and a failed write releases the close guard', () => {
  const f = fixture(); f.open(); f.edit('pending save'); const save = f.save(); f.edit('original');
  const sent = f.sent.length; f.editor.openFile('/project-a/b.txt');
  assert.equal(f.sent.length, sent);
  assert.equal(f.editor.getCurrentFile(), '/project-a/a.txt');
  f.ack(save, false); f.close(); assert.equal(f.editor.isEditorOpen(), false);
});

for (const failedFirst of [true, false]) {
  test(`failed SVG read preserves previous dirty document (${failedFirst ? 'failure' : 'success'} first)`, () => {
    const f = fixture(); f.open(); f.edit('keep this edit'); f.allowDiscard(true);
    f.editor.openFile('/project-a/unreadable.svg'); const [text, image] = f.sent.slice(-2);
    if (failedFirst) { f.reply(text, '', false); f.reply(image); }
    else { f.reply(image); f.reply(text, '', false); }
    assert.equal(f.editor.getCurrentFile(), '/project-a/a.txt');
    assert.equal(f.element('editor-textarea').value, 'keep this edit');
    assert.equal(f.element('btn-editor-save').disabled, false);
    const save = f.save(); assert.equal(save.c, IPC.WRITE_FILE); assert.equal(save.data.content, 'keep this edit');
  });
}

test('edits made during a successful read need a fresh discard decision', () => {
  const f = fixture(); f.open(); f.editor.openFile('/project-a/b.txt'); const read = f.sent.at(-1);
  f.edit('edit made during read'); f.reply(read, 'B');
  assert.equal(f.confirmations(), 1);
  assert.equal(f.editor.getCurrentFile(), '/project-a/a.txt');
  assert.equal(f.element('editor-textarea').value, 'edit made during read');
});

test('saving the visible file supersedes a pending navigation and keeps the save acknowledgement', () => {
  const f = fixture(); f.open(); f.editor.openFile('/project-a/b.txt'); const read = f.sent.at(-1);
  f.edit('A updated'); const save = f.save(); f.reply(read, 'B');
  assert.equal(save.data.filePath, '/project-a/a.txt');
  assert.equal(f.editor.getCurrentFile(), '/project-a/a.txt');
  f.ack(save); f.close(); assert.equal(f.confirmations(), 0); assert.equal(f.editor.isEditorOpen(), false);
});

test('undo during a real filesystem save stays open until the desired content is persisted', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const mainEditor = require('../src/main/fileEditor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-editor-close-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.txt'); fs.writeFileSync(file, 'original');
  const f = fixture(); f.open(file); f.edit('pending save'); const first = f.save();
  const pending = mainEditor.writeFile(file, first.data.content);
  f.edit('original'); f.close(); assert.equal(f.editor.isEditorOpen(), true);
  const firstResult = await pending; assert.equal(firstResult.success, true); f.ack(first);
  assert.equal(fs.readFileSync(file, 'utf8'), 'pending save');
  const second = f.save(); assert.equal((await mainEditor.writeFile(file, second.data.content)).success, true);
  f.ack(second); f.close();
  assert.equal(f.editor.isEditorOpen(), false); assert.equal(fs.readFileSync(file, 'utf8'), 'original');
});
