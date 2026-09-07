/** Native user-scoped installations survive app upgrades; reads never mutate them. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IPC } = require('../shared/ipcChannels');
const { SKILLS, getSkill } = require('../shared/skillsCatalog');
const { buildAugmentedPath } = require('../shared/pathUtils');
const { execFileCmd } = require('./gitExecUtils');
const pending = new Set();

function validate(provider, id) {
  if (!['claude', 'codex'].includes(provider) || !getSkill(id)) throw new Error('Invalid skill or provider');
}

function configDir(provider) {
  return provider === 'claude'
    ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    : process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
}

function executable(command) {
  return !!findExecutable(command);
}

function findExecutable(command) {
  // Do not cache missing binaries: a user can install one while the app is open.
  return buildAugmentedPath().split(path.delimiter).map(directory => path.join(directory, command))
    .find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    });
}

async function getSkills(provider) {
  validate(provider, 'ponytail');
  let plugins = [];
  let pluginError = '';
  try {
    if (provider === 'claude') {
      const installed = readJson(path.join(configDir(provider), 'plugins', 'installed_plugins.json')).plugins || {};
      const enabled = readJson(path.join(configDir(provider), 'settings.json')).enabledPlugins || {};
      plugins = Object.keys(installed)
        .filter(pluginId => Array.isArray(installed[pluginId]) && installed[pluginId].some(entry => !entry.scope || entry.scope === 'user'))
        .map(pluginId => ({ pluginId, enabled: enabled[pluginId] === true }));
    } else if (executable('codex')) {
      const { stdout } = await run('codex', ['plugin', 'list', '--json']);
      const data = JSON.parse(stdout);
      if (!Array.isArray(data.installed)) throw new Error('Update Codex to read plugin status.');
      plugins = data.installed;
    } else {
      pluginError = 'Install Codex CLI first, then refresh.';
    }
  } catch (err) { pluginError = errorMessage(err); }
  return SKILLS.map(skill => {
    if (skill.kind === 'cli') return { ...skill, provider, installed: executable(skill.id), enabled: null, statusError: '' };
    const directories = [path.join(configDir(provider), 'skills', skill.id)];
    if (provider === 'codex') directories.push(path.join(os.homedir(), '.agents', 'skills', skill.id));
    const local = directories.some(dir => fs.existsSync(path.join(dir, 'SKILL.md')));
    const pluginIds = skill.id === 'frontend-design'
      ? ['frontend-design@claude-plugins-official', 'frontend-design@claude-code-plugins']
      : [`${skill.id}@${skill.id}`];
    const plugin = plugins.find(item => pluginIds.includes(item.pluginId));
    const standalone = local || skill.installation === 'skill' || (provider === 'codex' && ['caveman', 'impeccable'].includes(skill.id));
    return { ...skill, provider, installed: local || !!plugin,
      enabled: local || !plugin ? null : plugin.enabled === true,
      toggleable: !local && !!plugin && provider === 'claude' && !skill.installation,
      statusError: standalone ? '' : pluginError };
  });
}

function run(command, args, cwd = os.homedir(), timeout = 30000) {
  // Resolve again after installations instead of retaining a cached missing command.
  const absolute = findExecutable(command);
  return execFileCmd(absolute || command, args, cwd, 2 * 1024 * 1024, timeout);
}

function errorMessage(err) { return String(err.stderr || err.error || err.message || 'Skill operation failed').slice(0, 1200); }

function isExpectedRemote(remote, repo) {
  const normalized = String(remote || '').trim().replace(/\.git$/i, '').toLowerCase();
  return [repo, `https://github.com/${repo}`, `git@github.com:${repo}`, `ssh://git@github.com/${repo}`]
    .some(expected => normalized === expected.toLowerCase());
}

async function installPlugin(provider, skill) {
  const { stdout } = await run(provider, ['plugin', 'marketplace', 'list', '--json']);
  const data = JSON.parse(stdout);
  const marketplaces = provider === 'codex' ? data.marketplaces : data;
  if (!Array.isArray(marketplaces)) throw new Error('Update your CLI and retry: unexpected marketplace list format.');
  const existing = marketplaces.find(item => item.name === skill.id);
  if (existing) {
    let remote = existing.source?.repo || existing.source?.url;
    if (!remote && (existing.root || existing.installLocation)) {
      remote = (await run('git', ['config', '--get', 'remote.origin.url'], existing.root || existing.installLocation)).stdout;
    }
    if (!isExpectedRemote(remote, skill.repo)) throw new Error(`The ${skill.id} marketplace has a different source. Remove it in your CLI and retry.`);
  } else {
    await run(provider, ['plugin', 'marketplace', 'add', skill.repo], os.homedir(), 120000);
  }
  await run(provider, ['plugin', provider === 'codex' ? 'add' : 'install', `${skill.id}@${skill.id}`,
    ...(provider === 'claude' ? ['--scope', 'user'] : [])], os.homedir(), 120000);
}

async function installSkill(provider, id) {
  let key;
  try {
    validate(provider, id);
    const skill = getSkill(id);
    key = skill.kind === 'cli' ? id : `${provider}:${id}`;
    if (pending.has(key)) throw new Error('Installation is already in progress.');
    pending.add(key);
  } catch (err) { return { success: false, error: errorMessage(err) }; }
  try {
    const status = (await getSkills(provider)).find(skill => skill.id === id);
    if (status.installed) return { success: true, alreadyInstalled: true };
    if (status.statusError) throw new Error(status.statusError);
    const skill = getSkill(id);
    if (id === 'rtk') {
      if (!executable('brew')) throw new Error('Install Homebrew first, then retry RTK.');
      await run('brew', ['install', 'rtk'], os.homedir(), 600000);
    } else if (id === 'headroom') {
      if (!executable('uv')) throw new Error('Install uv first, then retry Headroom.');
      await run('uv', ['tool', 'install', '--python', '3.13', 'headroom-ai[all]'], os.homedir(), 600000);
    } else if (id === 'impeccable' && provider === 'codex') {
      await run('npx', ['--yes', 'impeccable', 'install', '--providers=codex', '--scope=global', '--no-hooks'], os.homedir(), 180000);
    } else if (skill.installation === 'skill' || (id === 'caveman' && provider === 'codex')) {
      await run('npx', ['--yes', 'skills', 'add', skill.repo, '--skill', id, '--agent', provider === 'claude' ? 'claude-code' : 'codex', '--global', '--yes'], os.homedir(), 180000);
    } else {
      await installPlugin(provider, skill);
    }
    const installed = (await getSkills(provider)).find(item => item.id === id);
    if (!installed.installed) throw new Error('The installer finished, but installation could not be verified. Refresh to check again.');
    return { success: true };
  } catch (err) { return { success: false, error: errorMessage(err) }; }
  finally { pending.delete(key); }
}

/** Actions with interactive CLI flows run in a fresh terminal, never an existing agent session. */
function getSkillCommand(provider, id, action) {
  validate(provider, id);
  const target = provider === 'codex' ? ' --codex' : '';
  if (id === 'rtk' && action === 'setup') return `rtk init -g${target}`;
  if (id === 'rtk' && action === 'disable') return `rtk init -g${target} --uninstall`;
  if (id === 'headroom' && action === 'start') return `headroom wrap ${provider}`;
  if (id === 'headroom' && action === 'disable') return `headroom unwrap ${provider}`;
  throw new Error('Unsupported skill action');
}

async function toggleSkill(provider, id, enabled) {
  try {
    validate(provider, id);
    if (provider !== 'claude' || !['caveman', 'ponytail', 'impeccable'].includes(id) || typeof enabled !== 'boolean') throw new Error('Unsupported skill toggle');
    await run('claude', ['plugin', enabled ? 'enable' : 'disable', `${id}@${id}`, '--scope', 'user']);
    return { success: true };
  } catch (err) { return { success: false, error: errorMessage(err) }; }
}

function setupIPC(ipcMain) {
  ipcMain.handle(IPC.LOAD_SKILLS, (event, provider) => getSkills(provider));
  ipcMain.handle(IPC.INSTALL_SKILL, (event, provider, id) => installSkill(provider, id));
  ipcMain.handle(IPC.TOGGLE_SKILL, (event, provider, id, enabled) => toggleSkill(provider, id, enabled));
  ipcMain.handle(IPC.GET_SKILL_COMMAND, (event, provider, id, action) => getSkillCommand(provider, id, action));
}

module.exports = { setupIPC, getSkills, installSkill, toggleSkill, getSkillCommand, isExpectedRemote };
