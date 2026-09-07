/** Native user-scoped installations survive app upgrades; reads never mutate them. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const { SKILLS } = require('../shared/skillsCatalog');
const { buildAugmentedPath } = require('../shared/pathUtils');
const { execFileCmd } = require('./gitExecUtils');
const pending = new Set();
let updater;
function updates() {
  if (!updater) updater = require('./skillUpdates').createSkillUpdater({ getSkills, configDir, normalizeRepository, findExecutable, run, verifyMarketplace });
  return updater;
}

function normalizeRepository(value) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('Enter a GitHub repository URL.');
  const repo = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repo) || repo.includes('..')) {
    throw new Error('Use https://github.com/owner/repository or owner/repository.');
  }
  return repo;
}

function repositoryFile() { return path.join(app.getPath('userData'), 'skill-repositories.json'); }

function customRepositories() {
  const filename = repositoryFile();
  if (!fs.existsSync(filename)) return [];
  const repos = readJson(filename);
  if (!Array.isArray(repos) || repos.some(repo => typeof repo !== 'string')) throw new Error('Could not read saved skill repositories. The original file has been preserved.');
  return repos.map(normalizeRepository);
}

/** @returns {import('../shared/skillsCatalog').Skill[]} */
function catalog() {
  return [...SKILLS, ...customRepositories().map(/** @returns {import('../shared/skillsCatalog').Skill} */ repo => ({ id: `repo:${repo.toLowerCase()}`, repo,
    name: repo.split('/')[1], title: repo, category: 'custom', kind: 'repository', custom: true,
    description: 'Install skills from this repository for the selected agent. Your saved repository and installed files survive app updates.' }))];
}

function getSkill(id) { return catalog().find(skill => skill.id === id); }

function saveRepositories(repos) {
  const filename = repositoryFile();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(`${filename}.tmp`, JSON.stringify(repos, null, 2), { mode: 0o600 });
  fs.renameSync(`${filename}.tmp`, filename);
}

function addRepository(value) {
  try {
    const repo = normalizeRepository(value);
    const existing = catalog().find(skill => skill.repo.toLowerCase() === repo.toLowerCase());
    if (existing) return { success: true, id: existing.id, category: existing.category, alreadyAdded: true };
    saveRepositories([...customRepositories(), repo]);
    return { success: true, id: `repo:${repo.toLowerCase()}`, category: 'custom' };
  } catch (err) { return { success: false, error: errorMessage(err) }; }
}

function removeRepository(id) {
  try {
    const skill = getSkill(id);
    if (!skill?.custom) throw new Error('Only your added repositories can be removed from this list.');
    saveRepositories(customRepositories().filter(repo => repo.toLowerCase() !== skill.repo.toLowerCase()));
    return { success: true };
  } catch (err) { return { success: false, error: errorMessage(err) }; }
}

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
        .map(pluginId => ({ pluginId, enabled: enabled[pluginId] === true, version: installed[pluginId].find(entry => !entry.scope || entry.scope === 'user')?.version }));
    } else if (executable('codex')) {
      const { stdout } = await run('codex', ['plugin', 'list', '--json']);
      const data = JSON.parse(stdout);
      if (!Array.isArray(data.installed)) throw new Error('Update Codex to read plugin status.');
      plugins = data.installed;
    } else {
      pluginError = 'Install Codex CLI first, then refresh.';
    }
  } catch (err) { pluginError = errorMessage(err); }
  const roots = [path.join(configDir(provider), 'skills')];
  if (provider === 'codex') roots.push(path.join(os.homedir(), '.agents', 'skills'));
  return catalog().map(skill => {
    if (skill.kind === 'service') return { ...skill, provider, installed: null, enabled: null, statusError: '' };
    if (skill.kind === 'repository') {
      try {
        const tracked = readJson(path.join(os.homedir(), '.agents', '.skill-lock.json')).skills || {};
        const installedSkills = Object.entries(tracked).filter(([id, entry]) =>
          /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) && !id.includes('..') &&
          isExpectedRemote(entry?.source || entry?.sourceUrl, skill.repo) &&
          roots.some(root => fs.existsSync(path.join(root, id, 'SKILL.md')))).map(([id]) => id);
        return { ...skill, provider, installed: installedSkills.length > 0, installedSkills, enabled: null, statusError: '' };
      } catch (err) { return { ...skill, provider, installed: false, statusError: errorMessage(err) }; }
    }
    if (skill.kind === 'cli') return { ...skill, provider, installed: executable(skill.id), enabled: null, statusError: '' };
    const localId = [skill.id, ...(skill.aliases || [])].find(id => roots.some(root => fs.existsSync(path.join(root, id, 'SKILL.md'))));
    const local = !!localId;
    const localFile = local && roots.map(root => path.join(root, localId, 'SKILL.md')).find(file => fs.existsSync(file));
    const frontmatter = localFile ? fs.readFileSync(localFile, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] : '';
    const commandName = frontmatter?.match(/^name:\s*["']?([a-zA-Z0-9._-]+)["']?\s*$/m)?.[1] || localId || skill.id;
    const plugin = plugins.find(item => item.pluginId === `${skill.id}@${skill.id}`);
    const standalone = local || skill.installation === 'skill' || (provider === 'codex' && ['caveman', 'impeccable'].includes(skill.id));
    return { ...skill, provider, commandName, installed: local || !!plugin, pluginVersion: plugin?.version,
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

async function verifyMarketplace(provider, skill) {
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
  }
  return existing;
}

async function installPlugin(provider, skill) {
  if (!await verifyMarketplace(provider, skill)) {
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
    if (['repository', 'service'].includes(skill.kind)) throw new Error('Use this tool’s setup action.');
    key = skill.kind === 'cli' ? id : `${provider}:${id}`;
    if (pending.has(key)) throw new Error('Installation is already in progress.');
    pending.add(key);
  } catch (err) { return { success: false, error: errorMessage(err) }; }
  try {
    const status = (await getSkills(provider)).find(skill => skill.id === id);
    if (status.installed) return { success: true, alreadyInstalled: true };
    if (status.statusError) throw new Error(status.statusError);
    const skill = getSkill(id);
    if (skill.installCommand) {
      const [command, ...args] = skill.installCommand;
      if (!executable(command)) throw new Error(`Install ${command} first, then retry ${skill.name}.`);
      await run(command, args, os.homedir(), 600000);
    } else if (id === 'rtk') {
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
  const skill = getSkill(id);
  if (skill.kind === 'repository' && action === 'setup') {
    // Keep the native chooser and overwrite confirmations; never pass --yes.
    return `npx --yes skills add https://github.com/${normalizeRepository(skill.repo)} --agent ${provider === 'claude' ? 'claude-code' : 'codex'} --global`;
  }
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
  const updateAction = action => async (event, provider, id, token) => {
    try {
      validate(provider, id);
      return { success: true, update: await updates()[action](provider, id, token) };
    } catch (err) { return { success: false, error: errorMessage(err) }; }
  };
  ipcMain.handle(IPC.CHECK_SKILL_UPDATE, updateAction('check'));
  ipcMain.handle(IPC.APPLY_SKILL_UPDATE, updateAction('apply'));
  ipcMain.handle(IPC.ROLLBACK_SKILL_UPDATE, updateAction('rollback'));
  ipcMain.handle(IPC.OPEN_SKILL_BACKUP, async (event, provider, id, review = false) => {
    validate(provider, id);
    if (typeof review !== 'boolean') return { success: false, error: 'Invalid folder request.' };
    const error = await require('electron').shell.openPath(updates().backupDirectory(provider, id, review));
    return { success: !error, error };
  });
  ipcMain.handle(IPC.ADD_SKILL_REPOSITORY, (event, repo) => addRepository(repo));
  ipcMain.handle(IPC.REMOVE_SKILL_REPOSITORY, (event, id) => removeRepository(id));
  ipcMain.handle(IPC.LOAD_SKILLS, async (event, provider) => (await getSkills(provider)).map(skill => {
    try { return { ...skill, update: updates().state(provider, skill.id) }; }
    catch (err) { return { ...skill, update: { error: errorMessage(err) } }; }
  }));
  ipcMain.handle(IPC.INSTALL_SKILL, async (event, provider, id) => {
    try { return await updates().exclusive(() => installSkill(provider, id)); }
    catch (err) { return { success: false, error: errorMessage(err) }; }
  });
  ipcMain.handle(IPC.TOGGLE_SKILL, (event, provider, id, enabled) => toggleSkill(provider, id, enabled));
  ipcMain.handle(IPC.GET_SKILL_COMMAND, (event, provider, id, action) => getSkillCommand(provider, id, action));
}

module.exports = { setupIPC, getSkills, installSkill, toggleSkill, getSkillCommand, isExpectedRemote, addRepository, removeRepository, normalizeRepository };
