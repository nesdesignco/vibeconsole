const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function harness(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-skills-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const calls = [];
  let codexPlugins = [];
  const write = (file, value) => {
    const destination = path.join(home, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const binary = name => { write(`bin/${name}`, '#!/bin/sh\n'); fs.chmodSync(path.join(bin, name), 0o700); };
  binary('claude'); binary('codex'); binary('git'); binary('npx'); binary('brew'); binary('uv');
  const execFileCmd = async (command, args, cwd) => {
    const name = path.basename(command);
    calls.push({ command: name, args: [...args], cwd });
    if (options.run) {
      const result = await options.run(name, args, { write, binary, setCodex: value => { codexPlugins = value; } });
      if (result) return result;
    }
    if (args.join(' ') === 'plugin list --json') return { stdout: JSON.stringify({ installed: codexPlugins }) };
    if (args.join(' ') === 'plugin marketplace list --json') return { stdout: JSON.stringify(name === 'codex' ? { marketplaces: [] } : []) };
    if (name === 'brew') binary('rtk');
    if (name === 'uv') binary('headroom');
    if (name === 'npx') {
      const id = args[1] === 'impeccable' ? 'impeccable' : args[args.indexOf('--skill') + 1];
      const provider = args.includes('claude-code') ? '.claude' : '.agents';
      write(`${provider}/skills/${id}/SKILL.md`, `---\nname: ${id}\n---`);
    }
    if (args[1] === 'install') {
      write('.claude/plugins/installed_plugins.json', { plugins: { [args[2]]: [{}] } });
      write('.claude/settings.json', { enabledPlugins: { [args[2]]: true } });
    }
    if (args[1] === 'add') codexPlugins = [{ pluginId: args[2], enabled: true }];
    return { stdout: '' };
  };
  const create = () => {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/skillsManager.js'), 'utf8'), {
      module: mod, process: { env: {} }, console,
      require: id => {
        if (id === 'os') return { homedir: () => home };
        if (id === '../shared/pathUtils') return { buildAugmentedPath: () => bin };
        if (id === './gitExecUtils') return { execFileCmd };
        return require(id.startsWith('../shared/') ? `../src/shared/${id.split('/').pop()}` : id);
      }
    });
    return mod.exports;
  };
  return { home, calls, write, binary, manager: create(), reload: create };
}

test('opening and refreshing skills never installs or creates configuration', async t => {
  const h = harness(t);
  for (const provider of ['claude', 'codex']) {
    const skills = await h.manager.getSkills(provider);
    assert.equal(skills.length, 8);
    assert.ok(skills.every(skill => !skill.installed));
    await h.manager.getSkills(provider);
  }
  assert.ok(h.calls.every(call => call.args.join(' ') === 'plugin list --json'));
  assert.equal(fs.existsSync(path.join(h.home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(h.home, '.codex')), false);
});

test('app restart/update preserves installed disabled skills and install is a no-op', async t => {
  const h = harness(t);
  h.write('.claude/plugins/installed_plugins.json', { plugins: { 'ponytail@ponytail': [{ version: '1' }] } });
  h.write('.claude/settings.json', { enabledPlugins: { 'ponytail@ponytail': false }, unrelated: 'keep' });
  const before = fs.readFileSync(path.join(h.home, '.claude/settings.json'), 'utf8');
  for (const manager of [h.manager, h.reload()]) {
    const ponytail = (await manager.getSkills('claude')).find(s => s.id === 'ponytail');
    assert.equal(ponytail.installed, true);
    assert.equal(ponytail.enabled, false);
    assert.equal((await manager.installSkill('claude', 'ponytail')).alreadyInstalled, true);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(h.home, '.claude/settings.json'), 'utf8'), before);
});

test('Claude installation uses the exact marketplace and user scope; retry skips download', async t => {
  const h = harness(t);
  assert.equal((await h.manager.installSkill('claude', 'ponytail')).success, true);
  assert.deepEqual(h.calls.map(c => c.args), [
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'marketplace', 'add', 'DietrichGebert/ponytail'],
    ['plugin', 'install', 'ponytail@ponytail', '--scope', 'user']
  ]);
  assert.equal((await h.reload().installSkill('claude', 'ponytail')).alreadyInstalled, true);
  assert.equal(h.calls.length, 3);
});

test('Codex installs independently and a restart does not reinstall it', async t => {
  const h = harness(t);
  assert.equal((await h.manager.installSkill('codex', 'ponytail')).success, true);
  assert.ok(h.calls.every(c => c.command === 'codex'));
  assert.equal(fs.existsSync(path.join(h.home, '.claude')), false);
  h.calls.length = 0;
  assert.equal((await h.reload().installSkill('codex', 'ponytail')).alreadyInstalled, true);
  assert.ok(h.calls.every(c => c.args.join(' ') === 'plugin list --json'));
});

test('binary installs are reused by both providers across reloads', async t => {
  const h = harness(t);
  for (const id of ['rtk', 'headroom']) {
    assert.equal((await h.manager.installSkill('claude', id)).success, true);
    h.calls.length = 0;
    assert.equal((await h.reload().installSkill('codex', id)).alreadyInstalled, true);
    assert.ok(h.calls.every(c => c.args.join(' ') === 'plugin list --json'));
  }
});

test('Caveman Codex uses a global skill without the cross-agent installer', async t => {
  const h = harness(t);
  assert.equal((await h.manager.installSkill('codex', 'caveman')).success, true);
  const npx = h.calls.find(c => c.command === 'npx');
  assert.deepEqual(npx.args, ['--yes', 'skills', 'add', 'JuliusBrussee/caveman', '--skill', 'caveman', '--agent', 'codex', '--global', '--yes']);
  assert.equal((await h.reload().installSkill('codex', 'caveman')).alreadyInstalled, true);
  assert.equal(h.calls.filter(c => c.command === 'npx').length, 1);
});

test('invalid IDs and providers cannot execute commands', async t => {
  const h = harness(t);
  assert.equal((await h.manager.installSkill('bash', 'ponytail')).success, false);
  assert.equal((await h.manager.installSkill('claude', '--help')).success, false);
  assert.equal((await h.manager.toggleSkill('codex', 'ponytail', true)).success, false);
  assert.throws(() => h.manager.getSkillCommand('claude', 'rtk', 'anything'));
  assert.throws(() => h.manager.getSkillCommand('codex; echo bad', 'headroom', 'start'));
  assert.equal(h.calls.length, 0);
});

test('marketplace name collision fails before installing from an unexpected repository', async t => {
  const h = harness(t, { run: async (name, args) => args[1] === 'marketplace' && args[2] === 'list'
    ? { stdout: JSON.stringify([{ name: 'ponytail', source: { repo: 'attacker/ponytail' } }]) } : null });
  const result = await h.manager.installSkill('claude', 'ponytail');
  assert.equal(result.success, false);
  assert.match(result.error, /different source/);
  assert.equal(h.calls.length, 1);
});

test('installation failures release the lock and remain retryable', async t => {
  let fail = true;
  const h = harness(t, { run: async (name, args) => {
    if (args[1] === 'install' && fail) { fail = false; throw { stderr: 'network unavailable' }; }
  } });
  assert.match((await h.manager.installSkill('claude', 'ponytail')).error, /network unavailable/);
  assert.equal((await h.manager.installSkill('claude', 'ponytail')).success, true);
});

test('concurrent clicks cannot start duplicate installers', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { run: async (name, args) => { if (args[1] === 'install') await gate; } });
  const first = h.manager.installSkill('claude', 'ponytail');
  const second = await h.manager.installSkill('claude', 'ponytail');
  assert.equal(second.success, false);
  assert.match(second.error, /already in progress/);
  release();
  assert.equal((await first).success, true);
  assert.equal(h.calls.filter(c => c.args[1] === 'install').length, 1);
});

test('broken settings are surfaced instead of treated as an uninstalled skill', async t => {
  const h = harness(t);
  h.write('.claude/settings.json', '{');
  assert.equal((await h.manager.installSkill('claude', 'ponytail')).success, false);
  assert.equal(h.calls.length, 0);
});

test('a project-only Claude plugin does not suppress the optional user installation', async t => {
  const h = harness(t);
  h.write('.claude/plugins/installed_plugins.json', { plugins: { 'ponytail@ponytail': [{ scope: 'project' }] } });
  const skill = (await h.manager.getSkills('claude')).find(s => s.id === 'ponytail');
  assert.equal(skill.installed, false);
  assert.equal((await h.manager.installSkill('claude', 'ponytail')).success, true);
  assert.ok(h.calls.some(call => call.args[1] === 'install' && call.args.includes('user')));
});

test('UI skills install only for the selected provider and are reused after restart', async t => {
  for (const provider of ['claude', 'codex']) {
    for (const id of ['impeccable', 'design-dna', 'frontend-design', 'web-design-guidelines']) {
      const h = harness(t);
      assert.equal((await h.manager.installSkill(provider, id)).success, true, `${provider}:${id}`);
      const installed = (await h.reload().getSkills(provider)).find(s => s.id === id);
      assert.equal(installed.installed, true);
      assert.equal(installed.toggleable, provider === 'claude' && id === 'impeccable');
      if (id === 'impeccable' && provider === 'codex') {
        assert.deepEqual(h.calls.find(c => c.command === 'npx').args,
          ['--yes', 'impeccable', 'install', '--providers=codex', '--scope=global', '--no-hooks']);
      } else if (id !== 'impeccable') {
        const args = h.calls.find(c => c.command === 'npx').args;
        assert.equal(args[args.indexOf('--skill') + 1], id);
        assert.equal(args[args.indexOf('--agent') + 1], provider === 'claude' ? 'claude-code' : 'codex');
        assert.ok(args.includes('--global'));
      }
      h.calls.length = 0;
      assert.equal((await h.reload().installSkill(provider, id)).alreadyInstalled, true);
      assert.ok(h.calls.every(c => c.args.join(' ') === 'plugin list --json'));
    }
  }
});

test('existing native skill folders are detected without overwriting or enabling plugins', async t => {
  const h = harness(t);
  h.write('.claude/skills/design-dna/SKILL.md', 'custom Claude copy');
  h.write('.codex/skills/design-dna/SKILL.md', 'custom Codex copy');
  h.write('.agents/skills/impeccable/SKILL.md', 'existing shared copy');
  for (const provider of ['claude', 'codex']) {
    const skill = (await h.manager.getSkills(provider)).find(s => s.id === 'design-dna');
    assert.equal(skill.installed, true);
    assert.equal(skill.enabled, null);
    assert.equal(skill.toggleable, false);
    assert.equal((await h.manager.installSkill(provider, 'design-dna')).alreadyInstalled, true);
  }
  assert.equal((await h.manager.installSkill('codex', 'impeccable')).alreadyInstalled, true);
  assert.ok(h.calls.every(c => c.args.join(' ') === 'plugin list --json'));
  assert.equal(fs.readFileSync(path.join(h.home, '.codex/skills/design-dna/SKILL.md'), 'utf8'), 'custom Codex copy');
});
