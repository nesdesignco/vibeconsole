/** Reviewed, user-triggered updates. Remote content is staged, never executed during checks. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app, net } = require('electron');

const exists = file => { try { fs.lstatSync(file); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; } };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function inventory(root, rejectLinks = false) {
  const files = Object.create(null);
  let bytes = 0;
  let count = 0;
  function visit(file, name) {
    if (++count > 50000) throw new Error('This installation has too many files for an in-app backup. Use its package manager.');
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      if (rejectLinks) throw new Error('The source contains symbolic links. Use the repository’s installer to review them.');
      files[name] = { hash: digest(fs.readlinkSync(file)), link: true };
    } else if (stat.isDirectory()) {
      files[`${name}/`] = { directory: true, mode: stat.mode & 0o777 };
      for (const entry of fs.readdirSync(file).sort()) {
        if (entry === '.git' && rejectLinks) continue;
        visit(path.join(file, entry), name ? `${name}/${entry}` : entry);
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      // ponytail: bounded snapshots; larger tool environments need streaming backup support.
      if (bytes > 512 * 1024 * 1024 || stat.size > 128 * 1024 * 1024) throw new Error('This installation is too large for an in-app backup. Use its package manager.');
      files[name] = { hash: digest(fs.readFileSync(file)), mode: stat.mode & 0o777 };
    } else throw new Error('Unsupported file type in installation.');
  }
  if (exists(root)) visit(root, '');
  return { files, hash: digest(JSON.stringify(files)), exists: exists(root) };
}

function copy(from, to, skipGit = false) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(from).isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), to); return; }
  fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
    filter: file => !skipGit || path.basename(file) !== '.git' });
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

async function fetchJson(url) {
  const response = await (net?.fetch || fetch)(url, { signal: AbortSignal.timeout(20000), redirect: 'error', headers: { 'User-Agent': 'VibeConsole', Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Update source returned HTTP ${response.status}. Retry later.`);
  const body = await response.text();
  if (body.length > 4 * 1024 * 1024) throw new Error('Update response is too large.');
  return JSON.parse(body);
}

function createSkillUpdater({ getSkills, configDir, skillLockFile, normalizeRepository, findExecutable, run, verifyMarketplace, request = fetchJson }) {
  const plans = new Map();
  let working = false;
  const root = () => path.join(app.getPath('userData'), 'skill-updates');
  const key = (provider, id) => `${provider}:${id}`;
  const recordPath = (provider, id) => path.join(root(), digest(key(provider, id)) + '.json');
  const readRecord = (provider, id) => exists(recordPath(provider, id)) ? json(recordPath(provider, id)) : null;
  const save = plan => atomicJson(recordPath(plan.provider, plan.id), plan);

  async function exclusive(task) {
    if (working) throw new Error('Another skill operation is running. Wait for it to finish.');
    working = true;
    try { return await task(); } finally { working = false; }
  }

  function state(provider, id) {
    const record = readRecord(provider, id);
    const plan = plans.get(key(provider, id));
    return { ...plan?.view, lastAction: record?.phase, canRollback: !!record?.backedUp && record.phase !== 'rolled-back',
      recoveryNeeded: !!record?.backedUp && !['applied', 'rolled-back'].includes(record.phase) };
  }

  function target(file) {
    return { path: file, before: inventory(file) };
  }

  function skillRoots(provider) {
    return [path.join(configDir(provider), 'skills'), ...(provider === 'codex' ? [path.join(os.homedir(), '.agents', 'skills')] : [])];
  }

  function localSkills(skill) {
    const names = skill.kind === 'repository' ? skill.installedSkills || [] : [skill.id, ...(skill.aliases || [])];
    const allowed = [...skillRoots('claude'), ...skillRoots('codex')].filter(exists).map(dir => fs.realpathSync(dir));
    const found = new Map();
    for (const name of names) for (const dir of skillRoots(skill.provider)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..')) continue;
      const file = path.join(dir, name);
      if (!exists(path.join(file, 'SKILL.md'))) continue;
      const resolved = fs.realpathSync(file);
      if (!allowed.some(rootDir => inside(rootDir, resolved))) throw new Error('This skill links outside the agent skill directories. Update it at its original location.');
      if (exists(path.join(resolved, '.git'))) throw new Error('This skill is a Git checkout. Update it in its repository to preserve Git history.');
      found.set(resolved, { name, path: resolved });
    }
    return [...found.values()];
  }

  async function stageRepository(skill, directory, compiled = false) {
    if (skill.id === 'impeccable' && compiled) {
      const download = await require('./droppedFiles').downloadUrlToTemp('https://impeccable.style/api/download/bundle/universal');
      if (!download.success) throw new Error(download.error);
      const zip = path.join(directory, 'bundle.zip');
      const checkout = path.join(directory, 'source');
      fs.copyFileSync(download.path, zip);
      fs.unlinkSync(download.path);
      if (fs.statSync(zip).size > 64 * 1024 * 1024) throw new Error('The Impeccable bundle is too large.');
      const buffer = fs.readFileSync(zip);
      const entries = (await run('unzip', ['-Z1', zip])).stdout.split('\n');
      if (entries.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw new Error('Unsafe archive path.');
      const metadata = (await run('zipinfo', ['-l', zip])).stdout;
      if (/^l[rwx-]{9}\s/m.test(metadata)) throw new Error('Symbolic links are not allowed in the downloaded bundle.');
      const uncompressed = metadata.match(/(\d+) bytes uncompressed/);
      if (!uncompressed || Number(uncompressed[1]) > 512 * 1024 * 1024 || entries.length > 50000) throw new Error('The expanded bundle is too large.');
      await run('unzip', ['-q', zip, '-d', checkout]);
      inventory(checkout, true);
      return { checkout, revision: digest(buffer) };
    }
    const repo = normalizeRepository(skill.repo);
    const checkout = path.join(directory, 'source');
    await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'clone', '--depth=1', '--no-recurse-submodules', '--', `https://github.com/${repo}.git`, checkout], os.homedir(), 120000);
    // File updates validate selected skill directories; unrelated repository links are never followed.
    inventory(checkout, !compiled);
    const revision = (await run('git', ['rev-parse', 'HEAD'], checkout)).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('Could not verify the source revision.');
    return { checkout, revision };
  }

  function sourceSkills(checkout) {
    const found = [];
    function walk(dir) {
      const marker = path.join(dir, 'SKILL.md');
      if (exists(marker) && fs.lstatSync(marker).isFile()) {
        const text = fs.readFileSync(marker, 'utf8');
        const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
        const name = frontmatter.match(/^name:\s*["']?([a-zA-Z0-9._-]+)["']?\s*$/m)?.[1] || path.basename(dir);
        found.push({ name, path: dir });
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) walk(path.join(dir, entry.name));
      }
    }
    walk(checkout);
    return found;
  }

  async function prepareFiles(skill, plan, locals) {
    const { checkout, revision } = await stageRepository(skill, plan.directory, true);
    const sources = sourceSkills(checkout);
    const lockFile = skillLockFile();
    const lock = exists(lockFile) ? json(lockFile).skills || {} : {};
    plan.targets = [];
    const changes = [];
    for (const local of locals) {
      let candidates = sources.filter(source => source.name === local.name || (skill.kind !== 'repository' && [skill.id, ...(skill.aliases || [])].includes(source.name)));
      if (skill.sourcePath) candidates = candidates.filter(source => path.relative(checkout, source.path).split(path.sep).join('/') === skill.sourcePath);
      const tracked = lock[local.name];
      if (tracked && String(tracked.source).toLowerCase() === skill.repo.toLowerCase() && typeof tracked.skillPath === 'string') {
        const lockedPath = path.resolve(checkout, path.dirname(tracked.skillPath));
        if (inside(checkout, lockedPath) && candidates.some(candidate => candidate.path === lockedPath)) candidates = candidates.filter(candidate => candidate.path === lockedPath);
      }
      const distribution = candidates.filter(candidate => candidate.path.includes(`${path.sep}dist${path.sep}${skill.provider}${path.sep}`));
      if (distribution.length === 1) candidates = distribution;
      if (skill.id === 'impeccable') {
        const providerFolder = skill.provider === 'codex' ? '.agents' : '.claude';
        candidates = candidates.filter(candidate => candidate.path.includes(`${path.sep}${providerFolder}${path.sep}`));
      }
      if (candidates.length !== 1) throw new Error(`Cannot safely identify the source for ${local.name}. Use this repository’s installer.`);
      inventory(candidates[0].path, true);
      const stagedSource = path.join(plan.directory, 'next', String(plan.targets.length));
      copy(candidates[0].path, stagedSource, true);
      const item = { ...target(local.path), source: stagedSource, label: local.name, sourceHash: '' };
      const next = inventory(item.source, true);
      item.sourceHash = next.hash;
      for (const name of new Set([...Object.keys(item.before.files), ...Object.keys(next.files)])) {
        if (JSON.stringify(item.before.files[name]) !== JSON.stringify(next.files[name])) changes.push(`${local.name}/${name}: ${!item.before.files[name] ? 'added' : !next.files[name] ? 'removed' : 'changed'}`);
      }
      plan.targets.push(item);
    }
    plan.mode = 'files';
    plan.view = { available: changes.length > 0, comparison: 'files', latest: revision.slice(0, 12), changes: changes.slice(0, 500).join('\n'),
      note: 'Review the complete file differences before applying. Current files, including custom edits, will be backed up and replaced with this reviewed revision. Shared installations update every agent using the same files.',
      changesUrl: skill.id === 'impeccable' ? `https://github.com/${skill.repo}/releases` : `https://github.com/${skill.repo}/commit/${revision}`, canApply: changes.length > 0 };
    // The native diff handles text/binary formats without a new diff dependency.
    let diff = '';
    let shortened = changes.length > 500;
    for (const [index, item] of plan.targets.entries()) {
      const output = path.join(plan.directory, `changes-${index}.diff`);
      try {
        await run('git', ['--no-pager', 'diff', `--output=${output}`, '--no-index', '--no-ext-diff', '--no-textconv', '--', item.path, item.source], os.homedir());
      } catch (err) { if (err.exitCode !== 1) throw err; }
      const length = fs.statSync(output).size;
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, 180000 - diff.length)));
      const fd = fs.openSync(output, 'r');
      try { fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
      diff += buffer.toString('utf8');
      shortened ||= length > buffer.length;
    }
    plan.view.diff = diff;
    if (shortened) plan.view.note += ' Preview shortened; open the review folder for the full diff.';

  }

  async function preparePlugin(skill, plan) {
    if (!await verifyMarketplace(skill.provider, skill)) throw new Error('The expected plugin marketplace is missing.');
    plan.repo = skill.repo;
    plan.configRoot = fs.realpathSync(configDir(skill.provider));
    const { checkout, revision } = await stageRepository(skill, plan.directory);
    const manifestName = skill.provider === 'codex' ? '.codex-plugin' : '.claude-plugin';
    const manifest = json(path.join(checkout, manifestName, 'plugin.json'));
    const current = skill.pluginVersion;
    if (!current || typeof manifest.version !== 'string') throw new Error('Plugin version could not be verified.');
    plan.mode = 'plugin';
    plan.latest = manifest.version;
    const cache = path.join(configDir(skill.provider), 'plugins', 'cache', skill.id);
    if (!exists(cache)) throw new Error('The plugin cache was not found. Refresh the installed status.');
    plan.targets = [target(cache)];
    if (skill.provider === 'claude') plan.targets.push(target(path.join(configDir('claude'), 'plugins', 'installed_plugins.json')));
    else plan.targets.push(target(path.join(configDir('codex'), 'config.toml')));
    rejectPluginLinks(plan);
    plan.commands = skill.provider === 'claude'
      ? [['claude', ['plugin', 'marketplace', 'update', skill.id]], ['claude', ['plugin', 'update', `${skill.id}@${skill.id}`, '--scope', 'user']]]
      : [['codex', ['plugin', 'marketplace', 'upgrade', skill.id]], ['codex', ['plugin', 'add', `${skill.id}@${skill.id}`, '--json']]];
    plan.view = { available: current !== plan.latest, current, latest: plan.latest, canApply: current !== plan.latest,
      changesUrl: `https://github.com/${skill.repo}/commit/${revision}`,
      note: 'Updates through the agent’s plugin manager. Plugin files and registration are backed up. Existing custom files remain in that backup. Restart the agent afterward.' };
  }

  async function prepareCLI(skill, plan) {
    plan.mode = 'cli';
    plan.targets = [];
    const executable = findExecutable(skill.id);
    if (!executable) throw new Error('Install this tool before checking its installed version.');
    let current, latest;
    if (skill.id === 'rtk') {
      const data = JSON.parse((await run('brew', ['info', '--json=v2', 'rtk'])).stdout).formulae?.[0];
      current = data?.linked_keg;
      latest = data?.versions?.stable;
      const prefix = (await run('brew', ['--prefix'])).stdout.trim();
      const cellar = (await run('brew', ['--cellar', 'rtk'])).stdout.trim();
      if (!current || !inside(fs.realpathSync(cellar), fs.realpathSync(executable))) throw new Error('This RTK installation is not managed by Homebrew. Use its original installer.');
      plan.targets = [target(path.join(cellar, current)), target(path.join(prefix, 'bin', 'rtk')), target(path.join(prefix, 'opt', 'rtk')), target(path.join(prefix, 'var', 'homebrew', 'linked', 'rtk'))];
      plan.commands = [['env', ['HOMEBREW_NO_INSTALL_CLEANUP=1', 'HOMEBREW_NO_AUTO_UPDATE=1', findExecutable('brew'), 'upgrade', 'rtk']]];
      plan.versionCommand = [executable, ['--version']];
    } else if (skill.id === 'qmd') {
      const packageName = '@tobilu/qmd';
      const modules = (await run('npm', ['root', '--global'])).stdout.trim();
      const directory = fs.realpathSync(path.join(modules, packageName));
      const manifest = json(path.join(directory, 'package.json'));
      if (!inside(directory, fs.realpathSync(executable))) throw new Error('This QMD installation is not managed by the active npm.');
      const remote = await request('https://registry.npmjs.org/@tobilu%2Fqmd/latest');
      current = manifest.version; latest = remote.version;
      const prefix = (await run('npm', ['prefix', '--global'])).stdout.trim();
      const names = new Set([...Object.keys(manifest.bin || {}), ...Object.keys(remote.bin || {})]);
      plan.targets = [target(directory), ...[...names].map(name => {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid package executable name.');
        return target(path.join(prefix, 'bin', name));
      })];
      plan.commands = [['npm', ['install', '--global', `${packageName}@${validVersion(latest)}`]]];
      plan.versionFile = path.join(directory, 'package.json');
    } else {
      const packageName = skill.id === 'headroom' ? 'headroom-ai' : skill.id;
      const toolsDir = (await run('uv', ['tool', 'dir'])).stdout.trim();
      const directory = fs.realpathSync(path.join(toolsDir, packageName));
      if (!exists(directory) || !inside(directory, fs.realpathSync(executable))) throw new Error('This installation is not managed by the active uv.');
      const list = (await run('uv', ['tool', 'list'])).stdout;
      current = list.split('\n').find(line => line.startsWith(packageName + ' v'))?.split(' ')[1]?.slice(1);
      latest = (await request(`https://pypi.org/pypi/${packageName}/json`)).info?.version;
      plan.binDir = (await run('uv', ['tool', 'dir', '--bin'])).stdout.trim();
      plan.toolDir = directory;
      plan.targets = [target(directory), ...toolLinks(plan.binDir, directory).map(target)];
      plan.commands = [['uv', ['tool', 'upgrade', `${packageName}==${validVersion(latest)}`]]];
      plan.versionPackage = packageName;
    }
    validVersion(current); validVersion(latest);
    plan.latest = latest;
    plan.view = { available: current !== latest, current, latest, canApply: current !== latest,
      changesUrl: `https://github.com/${skill.repo}/releases`,
      note: 'Updates the installed tool through its package manager. Its current files and launchers are backed up for local rollback. Notes, vaults and agent settings are not replaced.' };
  }

  function validVersion(value) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)+(?:[a-zA-Z0-9.+_-]*)$/.test(value)) throw new Error('The package version could not be verified.');
    return value;
  }

  function toolLinks(binDir, directory) {
    return fs.readdirSync(binDir).map(name => path.join(binDir, name)).filter(file => {
      if (!fs.lstatSync(file).isSymbolicLink()) return false;
      const linked = path.resolve(path.dirname(file), fs.readlinkSync(file));
      return inside(directory, exists(linked) ? fs.realpathSync(linked) : linked);
    });
  }

  function rejectPluginLinks(plan) {
    const config = configDir(plan.provider);
    if (fs.realpathSync(config) !== plan.configRoot) throw new Error('The plugin configuration location changed. Check updates again.');
    for (const item of plan.targets) {
      const expected = path.resolve(plan.configRoot, path.relative(config, item.path));
      if (exists(item.path) && (fs.realpathSync(item.path) !== expected ||
          Object.values(inventory(item.path).files).some(file => file.link))) {
        throw new Error('Plugin files or settings use symbolic links. Update through the agent CLI to preserve their original locations.');
      }
    }
  }

  function trackNewLaunchers(plan) {
    if (!plan.binDir) return;
    for (const file of toolLinks(plan.binDir, plan.toolDir)) {
      if (!plan.targets.some(item => item.path === file)) plan.targets.push({ path: file, before: { exists: false, hash: digest('{}'), files: {} } });
    }
  }

  async function check(provider, id) {
    return exclusive(async () => {
      const skill = (await getSkills(provider)).find(item => item.id === id);
      if (!skill) throw new Error('Unknown skill.');
      const prior = readRecord(provider, id);
      if (prior?.backedUp && !['applied', 'rolled-back'].includes(prior.phase)) throw new Error('The previous update was interrupted. Restore its backup before checking again.');
      const draft = recordPath(provider, id) + '.review';
      const previous = exists(draft) ? json(draft) : plans.get(key(provider, id));
      if (previous && previous.directory !== prior?.directory) fs.rmSync(previous.directory, { recursive: true, force: true });
      fs.rmSync(draft, { force: true });
      plans.delete(key(provider, id));
      fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
      const plan = { provider, id, directory: fs.mkdtempSync(path.join(root(), 'review-')), token: crypto.randomUUID(), checkedAt: new Date().toISOString() };
      try {
        if (skill.kind === 'service' || !skill.installed) {
          const releases = await request(`https://api.github.com/repos/${normalizeRepository(skill.repo)}/releases?per_page=1`);
          plan.view = { canApply: false, latest: releases[0]?.tag_name || 'No tagged release', changes: String(releases[0]?.body || '').slice(0, 20000),
            changesUrl: `https://github.com/${skill.repo}/releases`, note: skill.kind === 'service' ? 'Release information only. Follow the service’s upgrade guide; its deployed version and database are managed outside VibeConsole.' : 'Install this tool first to compare its installed version.' };
        } else if (skill.kind === 'cli') await prepareCLI(skill, plan);
        else {
          const locals = localSkills(skill);
          if (locals.length) await prepareFiles(skill, plan, locals);
          else if (skill.pluginVersion) await preparePlugin(skill, plan);
          else throw new Error('No installed files could be safely matched to this repository.');
        }
        plan.view = { ...plan.view, token: plan.token, checkedAt: plan.checkedAt };
        atomicJson(draft, { directory: plan.directory });
        plans.set(key(provider, id), plan);
        return state(provider, id);
      } catch (err) {
        fs.rmSync(plan.directory, { recursive: true, force: true });
        throw err;
      }
    });
  }

  function unchanged(targets, field) {
    for (const item of targets) {
      const current = inventory(item.path);
      if (current.hash !== item[field].hash || current.exists !== item[field].exists) throw new Error('Files changed since the review or update. Nothing was overwritten. Review again, or recover files from the backup.');
    }
  }

  function backup(plan) {
    plan.targets.forEach((item, index) => {
      item.backup = path.join(plan.directory, 'backup', String(index));
      if (item.before.exists) copy(item.path, item.backup);
      if (item.before.exists && inventory(item.backup).hash !== item.before.hash) throw new Error('Backup verification failed. No update was applied.');
    });
    plan.backedUp = true; plan.phase = 'backed-up'; save(plan);
  }

  function restore(plan) {
    // Copy first, then rename beside the destination; a failed copy never removes the live tree.
    for (const item of plan.targets) {
      if (item.before.exists && inventory(item.backup).hash !== item.before.hash) throw new Error('Backup integrity check failed. Current files were kept.');
    }
    for (const item of plan.targets) {
      const staged = `${item.path}.vibe-restore-${plan.token}`;
      const displaced = `${item.path}.vibe-displaced-${plan.token}`;
      if (exists(staged) || exists(displaced)) throw new Error('A previous recovery is unfinished. Keep its files and complete recovery before retrying.');
      if (item.before.exists) copy(item.backup, staged);
      if (exists(item.path)) fs.renameSync(item.path, displaced);
      try { if (item.before.exists) fs.renameSync(staged, item.path); }
      catch (err) { if (exists(displaced)) fs.renameSync(displaced, item.path); throw err; }
      if (exists(displaced)) fs.rmSync(displaced, { recursive: true, force: true });
    }
    unchanged(plan.targets, 'before');
    plan.phase = 'rolled-back'; save(plan);
  }

  async function apply(provider, id, token) {
    return exclusive(async () => {
      const plan = plans.get(key(provider, id));
      if (!plan || plan.token !== token || !plan.view.canApply || plan.backedUp) throw new Error('Check updates again before applying.');
      unchanged(plan.targets, 'before');
      if (plan.mode === 'files') for (const item of plan.targets) {
        if (inventory(item.source, true).hash !== item.sourceHash) throw new Error('The staged source changed. Check updates again.');
      }
      if (plan.mode === 'plugin') {
        const skill = (await getSkills(provider)).find(item => item.id === id);
        if (!skill || skill.repo !== plan.repo || !await verifyMarketplace(provider, skill)) throw new Error('The plugin source changed. Check updates again.');
        rejectPluginLinks(plan);
      }
      backup(plan);
      plan.phase = 'applying'; save(plan);
      try {
        if (plan.mode === 'files') {
          for (const item of plan.targets) {
            const next = `${item.path}.vibe-update-${plan.token}`;
            copy(item.source, next);
            if (inventory(next).hash !== inventory(item.source).hash) throw new Error('Staged update verification failed.');
            const previous = `${item.path}.vibe-previous-${plan.token}`;
            fs.renameSync(item.path, previous);
            try { fs.renameSync(next, item.path); }
            catch (err) { fs.renameSync(previous, item.path); throw err; }
            fs.rmSync(previous, { recursive: true });
          }
        } else {
          for (const [command, args] of plan.commands) await run(command, args, os.homedir(), 600000);
          trackNewLaunchers(plan);
          let version;
          if (plan.mode === 'plugin') version = (await getSkills(provider)).find(item => item.id === id)?.pluginVersion;
          else if (plan.versionFile) version = json(plan.versionFile).version;
          else if (plan.versionPackage) version = (await run('uv', ['tool', 'list'])).stdout.split('\n').find(line => line.startsWith(plan.versionPackage + ' v'))?.split(' ')[1]?.slice(1);
          else version = (await run(...plan.versionCommand)).stdout.match(/\d+\.\d+(?:\.\d+)?[^\s]*/)?.[0];
          if (version !== plan.latest) throw new Error('The installed version differs from the reviewed version.');
        }
        plan.targets.forEach(item => { item.after = inventory(item.path); });
        plan.phase = 'applied'; save(plan);
        plans.delete(key(provider, id));
        return state(provider, id);
      } catch (err) {
        trackNewLaunchers(plan);
        plan.phase = 'failed'; save(plan);
        // Preserve partial output and any edits made while a native installer ran.
        plan.targets.forEach((item, index) => {
          if (exists(item.path)) copy(item.path, path.join(plan.directory, 'failed-current', String(index)));
        });
        try { restore(plan); } catch (recovery) { throw new Error(`Update failed; backup retained for recovery: ${recovery.message}`, { cause: recovery }); }
        plans.delete(key(provider, id));
        throw new Error(`Update failed; previous files restored. ${String(err.message || err.error || err).slice(0, 500)}`, { cause: err });
      }
    });
  }

  async function rollback(provider, id) {
    return exclusive(async () => {
      const plan = readRecord(provider, id);
      if (!plan?.backedUp || plan.phase === 'rolled-back') throw new Error('No update backup is available.');
      if (plan.phase === 'applied') unchanged(plan.targets, 'after');
      else throw new Error('The interrupted update needs manual recovery. Open the backup folder; current files are kept.');
      plan.targets.forEach((item, index) => {
        if (exists(item.path)) copy(item.path, path.join(plan.directory, 'before-rollback', String(index)));
      });
      restore(plan);
      plans.delete(key(provider, id));
      return state(provider, id);
    });
  }

  function backupDirectory(provider, id, review = false) {
    return (review ? plans.get(key(provider, id))?.directory : readRecord(provider, id)?.directory) || root();
  }

  return { check, apply, rollback, state, exclusive, backupDirectory };
}

module.exports = { createSkillUpdater, inventory };
