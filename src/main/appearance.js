const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { app, BrowserWindow, nativeTheme } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const { defaults, normalize } = require('../shared/appearance');

const filename = () => path.join(app.getPath('userData'), 'appearance.json');
function load() {
  try {
    const stat = fs.lstatSync(filename());
    if (!stat.isFile() || stat.size > 32000) throw new Error('Unsupported appearance file.');
    return { settings: normalize(JSON.parse(fs.readFileSync(filename(), 'utf8'))), error: '' };
  }
  catch (err) {
    return { settings: defaults(), error: err.code === 'ENOENT' ? '' : 'Could not read appearance.json. The original file is preserved.' };
  }
}
function save(settings) {
  const prior = load();
  if (prior.error) throw new Error(prior.error);
  const value = normalize(settings);
  const file = filename();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return value;
}
function setupIPC(ipcMain) {
  ipcMain.handle(IPC.SAVE_APPEARANCE, (_event, settings) => {
    try {
      if (JSON.stringify(settings).length > 32000) throw new Error('Appearance settings are too large.');
      const value = save(settings);
      nativeTheme.themeSource = value.mode;
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.APPEARANCE_CHANGED, value);
      return { success: true, settings: value };
    } catch (err) { return { success: false, error: err.message }; }
  });
}
module.exports = { load, save, setupIPC };
