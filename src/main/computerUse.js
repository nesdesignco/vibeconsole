/** Local desktop automation through the installed Peekaboo CLI. */
const os = require('os');
const { shell } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const { findExecutable } = require('../shared/pathUtils');
const { execFileCmd } = require('./gitExecUtils');

const permissionPanes = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
};
let installing = false;
function supported() { return process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 24; }
function errorText(error) { return String(error?.stderr || error?.error || error?.message || error).slice(0, 1500); }

async function getStatus() {
  const status = { supported: supported(), installed: false, installing, executable: '', brew: !!findExecutable('brew'), permissions: [], error: '' };
  if (!status.supported) return status;
  status.executable = findExecutable('peekaboo') || '';
  status.installed = !!status.executable;
  if (!status.installed) return status;
  try {
    const { stdout } = await execFileCmd(status.executable, ['permissions', 'status', '--json'], os.homedir(), 256 * 1024, 15000);
    const result = JSON.parse(stdout);
    if (result.success === false || !Array.isArray(result.data?.permissions) || !result.data.permissions.length) {
      throw new Error('Permission status unavailable. Open the setup guide or refresh after updating Peekaboo.');
    }
    status.permissions = result.data.permissions.map(item => {
      if (typeof item.name !== 'string' || typeof item.isGranted !== 'boolean' || typeof item.isRequired !== 'boolean') {
        throw new Error('Unexpected permission status. Update Peekaboo and refresh.');
      }
      return { name: item.name, granted: item.isGranted, required: item.isRequired, instructions: String(item.grantInstructions || '') };
    });
  } catch (error) { status.error = errorText(error); }
  return status;
}

async function install() {
  if (!supported()) return { success: false, error: 'Computer Use requires macOS 15 or later.' };
  if (installing) return { success: false, error: 'Installation is already in progress.' };
  if (findExecutable('peekaboo')) return { success: true };
  const brew = findExecutable('brew');
  if (!brew) return { success: false, error: 'Install Homebrew using the setup guide, then refresh.' };
  installing = true;
  try {
    await execFileCmd(brew, ['install', 'openclaw/tap/peekaboo'], os.homedir(), 2 * 1024 * 1024, 600000);
    if (!findExecutable('peekaboo')) throw new Error('Installation finished but Peekaboo is not on PATH. Open the setup guide, then refresh.');
    return { success: true };
  } catch (error) { return { success: false, error: errorText(error) }; }
  finally { installing = false; }
}

function setupIPC(ipcMain) {
  ipcMain.handle(IPC.GET_COMPUTER_STATUS, () => getStatus());
  ipcMain.handle(IPC.INSTALL_COMPUTER_USE, () => install());
  ipcMain.handle(IPC.OPEN_COMPUTER_PERMISSION, async (_event, permission) => {
    if (!supported() || !Object.hasOwn(permissionPanes, permission)) return { success: false, error: 'Invalid permission request.' };
    try { await shell.openExternal(permissionPanes[permission]); return { success: true }; }
    catch (error) { return { success: false, error: errorText(error) }; }
  });
}

module.exports = { setupIPC, getStatus, install };
