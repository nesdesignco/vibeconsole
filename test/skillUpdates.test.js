const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function harness(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-update-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (file, value) => {
    const destination = path.join(home, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof value === 'string' ? value : JSON.stringify(value)); return destination;
  };
  const skill = { id: 'my-skill', repo: 'example/my-skill', kind: 'skill', installed: true, provider: 'claude', ...options.skill };
  write('.claude/skills/my-skill/SKILL.md', '---\nname: my-skill\n---\nMy customized content\n');
  write('.claude/skills/my-skill/only-local.md', 'Keep my notes');
  write('remote/SKILL.md', '---\nname: my-skill\n---\nUpdated content\n');
  write('remote/script.js', 'export const version = 2;');
  const calls = [];
  const run = async (command, args, cwd) => {
    calls.push([command, args]);
    const result = await options.run?.(command, args, { home, write, skill });
    if (result) return result;
    if (args.includes('clone')) { fs.cpSync(path.join(home, 'remote'), args.at(-1), { recursive: true }); return { stdout: '' }; }
    if (args[0] === 'rev-parse') return { stdout: 'a'.repeat(40) };
    if (args.includes('diff')) { fs.writeFileSync(args.find(arg => arg.startsWith('--output=')).slice(9), '-My customized content\n+Updated content'); throw { exitCode: 1, stdout: '' }; }
    return { stdout: '' };
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/skillUpdates.js'), 'utf8'), {
    module: mod, console, Buffer, AbortSignal, fetch,
    require: id => id === 'electron' ? { app: { getPath: () => path.join(home, 'app') } }
      : id === 'os' ? { homedir: () => home } : require(id)
  });
  const create = () => mod.exports.createSkillUpdater({ getSkills: async provider => [{ ...skill, provider }],
    configDir: provider => path.join(home, '.' + provider), normalizeRepository: repo => repo,
    findExecutable: command => path.join(home, 'bin', command), run,
    verifyMarketplace: options.verifyMarketplace || (async () => true),
    request: options.request || (async () => [{ tag_name: 'v2.0.0', body: 'Changes' }]) });
  return { home, write, calls, skill, updater: create(), reload: create };
}

test('review is read-only; explicit update backs up custom files and rollback survives restart', async t => {
  const h = harness(t);
  const file = path.join(h.home, '.claude/skills/my-skill/SKILL.md');
  const before = fs.readFileSync(file, 'utf8');
  const review = await h.updater.check('claude', 'my-skill');
  assert.equal(review.available, true);
  assert.match(review.diff, /My customized content/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await assert.rejects(h.updater.apply('claude', 'my-skill', 'wrong-token'), /Check updates/);
  await h.updater.apply('claude', 'my-skill', review.token);
  assert.match(fs.readFileSync(file, 'utf8'), /Updated content/);
  assert.equal(fs.existsSync(path.join(h.home, '.claude/skills/my-skill/only-local.md')), false);
  const backup = h.updater.backupDirectory('claude', 'my-skill');
  assert.equal(fs.readFileSync(path.join(backup, 'backup/0/only-local.md'), 'utf8'), 'Keep my notes');
  assert.equal(h.reload().state('claude', 'my-skill').canRollback, true);
  await h.reload().rollback('claude', 'my-skill');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(h.home, '.claude/skills/my-skill/script.js')), false);
  assert.equal(h.reload().state('claude', 'my-skill').canRollback, false);
});

test('stale reviews and changed files after update are never overwritten', async t => {
  const h = harness(t);
  let review = await h.updater.check('claude', 'my-skill');
  h.write('.claude/skills/my-skill/SKILL.md', 'edit after review');
  await assert.rejects(h.updater.apply('claude', 'my-skill', review.token), /Files changed/);
  review = await h.updater.check('claude', 'my-skill');
  await h.updater.apply('claude', 'my-skill', review.token);
  h.write('.claude/skills/my-skill/SKILL.md', 'edit after update');
  await assert.rejects(h.reload().rollback('claude', 'my-skill'), /Files changed/);
  assert.equal(fs.readFileSync(path.join(h.home, '.claude/skills/my-skill/SKILL.md'), 'utf8'), 'edit after update');
});

test('files named __proto__ remain covered by changed-file checks', async t => {
  const h = harness(t);
  h.write('.claude/skills/my-skill/__proto__', 'original');
  const review = await h.updater.check('claude', 'my-skill');
  h.write('.claude/skills/my-skill/__proto__', 'edited');
  await assert.rejects(h.updater.apply('claude', 'my-skill', review.token), /Files changed/);
  assert.equal(fs.readFileSync(path.join(h.home, '.claude/skills/my-skill/__proto__'), 'utf8'), 'edited');
});

test('tampered backup and staged source fail closed', async t => {
  const h = harness(t);
  let review = await h.updater.check('claude', 'my-skill');
  const root = path.join(h.home, 'app/skill-updates');
  const staged = fs.readdirSync(root).find(name => name.startsWith('review-'));
  fs.writeFileSync(path.join(root, staged, 'next/0/SKILL.md'), 'tampered');
  await assert.rejects(h.updater.apply('claude', 'my-skill', review.token), /staged source changed/);
  review = await h.updater.check('claude', 'my-skill');
  await h.updater.apply('claude', 'my-skill', review.token);
  fs.writeFileSync(path.join(h.updater.backupDirectory('claude', 'my-skill'), 'backup/0/SKILL.md'), 'tampered');
  await assert.rejects(h.updater.rollback('claude', 'my-skill'), /integrity/);
  assert.match(fs.readFileSync(path.join(h.home, '.claude/skills/my-skill/SKILL.md'), 'utf8'), /Updated content/);
});

test('remote symlinks and local symlinks escaping skill roots are rejected', async t => {
  const h = harness(t);
  fs.symlinkSync('/etc/passwd', path.join(h.home, 'remote/link'));
  await assert.rejects(h.updater.check('claude', 'my-skill'), /symbolic links/);
  fs.unlinkSync(path.join(h.home, 'remote/link'));
  fs.renameSync(path.join(h.home, '.claude/skills/my-skill'), path.join(h.home, 'outside'));
  fs.symlinkSync(path.join(h.home, 'outside'), path.join(h.home, '.claude/skills/my-skill'));
  await assert.rejects(h.updater.check('claude', 'my-skill'), /outside/);
});

test('custom repository updates touch only its installed skills for the selected provider', async t => {
  const h = harness(t, { skill: { id: 'repo:example/pack', repo: 'example/pack', kind: 'repository', installedSkills: ['my-skill'] } });
  h.write('.claude/skills/unrelated/SKILL.md', 'unrelated');
  h.write('.codex/skills/my-skill/SKILL.md', 'Codex customized');
  const review = await h.updater.check('claude', h.skill.id);
  await h.updater.apply('claude', h.skill.id, review.token);
  assert.equal(fs.readFileSync(path.join(h.home, '.codex/skills/my-skill/SKILL.md'), 'utf8'), 'Codex customized');
  assert.equal(fs.readFileSync(path.join(h.home, '.claude/skills/unrelated/SKILL.md'), 'utf8'), 'unrelated');
});

test('external services expose release information without pretending to update deployment', async t => {
  const h = harness(t, { skill: { kind: 'service', installed: null } });
  const review = await h.updater.check('claude', 'my-skill');
  assert.equal(review.latest, 'v2.0.0');
  assert.equal(review.canApply, false);
  await assert.rejects(h.updater.apply('claude', 'my-skill', review.token), /Check updates/);
  assert.equal(h.calls.length, 0);
});

test('npm tool update pins reviewed version; native failure restores files and keeps partial output', async t => {
  let fail = true;
  const h = harness(t, { skill: { id: 'qmd', kind: 'cli' }, request: async () => ({ version: '2.0.0', bin: { qmd: 'cli.js' } }),
    run: async (command, args, { home, write }) => {
      if (args[0] === 'root') return { stdout: path.join(home, 'modules') };
      if (args[0] === 'prefix') return { stdout: home };
      if (command === 'npm' && args[0] === 'install') {
        assert.equal(args.at(-1), '@tobilu/qmd@2.0.0');
        write('modules/@tobilu/qmd/package.json', { version: '2.0.0', bin: { qmd: 'cli.js' } });
        if (fail) throw new Error('network failed during install');
        return { stdout: '' };
      }
    } });
  h.write('modules/@tobilu/qmd/package.json', { version: '1.0.0', bin: { qmd: 'cli.js' } });
  h.write('modules/@tobilu/qmd/cli.js', 'old executable');
  fs.mkdirSync(path.join(h.home, 'bin'));
  fs.symlinkSync('../modules/@tobilu/qmd/cli.js', path.join(h.home, 'bin/qmd'));
  let review = await h.updater.check('claude', 'qmd');
  await assert.rejects(h.updater.apply('claude', 'qmd', review.token), /previous files restored/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'modules/@tobilu/qmd/package.json'))).version, '1.0.0');
  assert.equal(fs.readlinkSync(path.join(h.home, 'bin/qmd')), '../modules/@tobilu/qmd/cli.js');
  fail = false;
  review = await h.updater.check('claude', 'qmd');
  await h.updater.apply('claude', 'qmd', review.token);
  await h.reload().rollback('claude', 'qmd');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'modules/@tobilu/qmd/package.json'))).version, '1.0.0');
});

test('operation lock rejects duplicate checks without executing them', async t => {
  const h = harness(t);
  let release;
  const pending = h.updater.exclusive(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(h.updater.check('claude', 'my-skill'), /Another skill operation/);
  assert.equal(h.calls.length, 0);
  release(); await pending;
});

test('restarted checks replace drafts while a fresh review keeps the previous backup accessible', async t => {
  const h = harness(t);
  await h.updater.check('claude', 'my-skill');
  const first = h.updater.backupDirectory('claude', 'my-skill', true);
  const restarted = h.reload();
  const review = await restarted.check('claude', 'my-skill');
  assert.equal(fs.existsSync(first), false);
  await restarted.apply('claude', 'my-skill', review.token);
  const backup = restarted.backupDirectory('claude', 'my-skill');
  await restarted.check('claude', 'my-skill');
  assert.equal(restarted.backupDirectory('claude', 'my-skill'), backup);
  assert.notEqual(restarted.backupDirectory('claude', 'my-skill', true), backup);
  assert.equal(fs.existsSync(path.join(backup, 'backup/0/SKILL.md')), true);
});

test('plugin checks and applies reject a changed marketplace and linked native files', async t => {
  let trusted = false;
  const h = harness(t, { skill: { id: 'pack', pluginVersion: '1.0.0' },
    verifyMarketplace: async () => { if (!trusted) throw new Error('different source'); return true; } });
  h.write('remote/.claude-plugin/plugin.json', { version: '2.0.0' });
  const cache = h.write('.claude/plugins/cache/pack/plugin.txt', 'original');
  const settings = h.write('.claude/plugins/installed_plugins.json', '{}');
  await assert.rejects(h.updater.check('claude', 'pack'), /different source/);
  trusted = true;
  for (const file of [cache, settings]) {
    fs.renameSync(file, file + '.original');
    fs.symlinkSync(file + '.original', file);
    await assert.rejects(h.updater.check('claude', 'pack'), /symbolic links/);
    fs.unlinkSync(file); fs.renameSync(file + '.original', file);
  }
  const review = await h.updater.check('claude', 'pack');
  trusted = false;
  await assert.rejects(h.updater.apply('claude', 'pack', review.token), /different source/);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'original');
  assert.equal(h.updater.state('claude', 'pack').canRollback, false);
});

test('failed uv upgrade removes newly created launchers without replacing unrelated commands', async t => {
  const h = harness(t, { skill: { id: 'basic-memory', kind: 'cli' }, request: async () => ({ info: { version: '2.0.0' } }),
    run: async (command, args, { home, write }) => {
      if (command !== 'uv') return;
      if (args[1] === 'dir') return { stdout: path.join(home, args.includes('--bin') ? 'bin' : 'tools') };
      if (args[1] === 'list') return { stdout: 'basic-memory v1.0.0' };
      if (args[1] === 'upgrade') {
        assert.equal(args.includes('--force'), false);
        write('tools/basic-memory/bin/extra', 'new');
        fs.symlinkSync('../tools/basic-memory/bin/extra', path.join(home, 'bin/extra'));
        fs.symlinkSync(path.join(fs.realpathSync(path.join(home, 'tools/basic-memory')), 'bin/missing'), path.join(home, 'bin/dangling'));
        throw new Error('installation failed');
      }
    } });
  h.write('tools/basic-memory/bin/basic-memory', 'old');
  h.write('bin/unrelated', 'keep');
  fs.symlinkSync('../tools/basic-memory/bin/basic-memory', path.join(h.home, 'bin/basic-memory'));
  const review = await h.updater.check('claude', 'basic-memory');
  await assert.rejects(h.updater.apply('claude', 'basic-memory', review.token), /previous files restored/);
  assert.equal(fs.existsSync(path.join(h.home, 'bin/extra')), false);
  assert.throws(() => fs.lstatSync(path.join(h.home, 'bin/dangling')), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(path.join(h.home, 'bin/unrelated'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(h.home, 'bin/basic-memory'), 'utf8'), 'old');
});

for (const provider of ['claude', 'codex']) test(`${provider} plugin update verifies version and restores its registration on rollback`, async t => {
  const h = harness(t, { skill: { id: 'pack', pluginVersion: '1.0.0' },
    run: async (command, args, { write, skill }) => {
      if (command === provider && ['update', 'add'].includes(args[1])) {
        skill.pluginVersion = '2.0.0';
        write(`.${provider}/plugins/cache/pack/pack/2.0.0/plugin.txt`, 'new files');
        if (provider === 'claude') write('.claude/plugins/installed_plugins.json', { version: '2.0.0' });
        return { stdout: '' };
      }
    } });
  h.write('remote/.claude-plugin/plugin.json', { version: '2.0.0' });
  h.write('remote/.codex-plugin/plugin.json', { version: '2.0.0' });
  h.write(`.${provider}/plugins/cache/pack/pack/1.0.0/plugin.txt`, 'custom plugin files');
  h.write(`.${provider}/config.toml`, 'unrelated = "keep"');
  h.write('.claude/plugins/installed_plugins.json', { version: '1.0.0' });
  const review = await h.updater.check(provider, 'pack');
  assert.equal(review.current, '1.0.0');
  await h.updater.apply(provider, 'pack', review.token);
  assert.equal(h.updater.state(provider, 'pack').canRollback, true);
  await h.reload().rollback(provider, 'pack');
  assert.equal(fs.existsSync(path.join(h.home, `.${provider}/plugins/cache/pack/pack/2.0.0`)), false);
  assert.equal(fs.readFileSync(path.join(h.home, `.${provider}/plugins/cache/pack/pack/1.0.0/plugin.txt`), 'utf8'), 'custom plugin files');
  assert.equal(fs.readFileSync(path.join(h.home, `.${provider}/config.toml`), 'utf8'), 'unrelated = "keep"');
});

for (const id of ['headroom', 'basic-memory', 'obsidian-wiki']) test(`${id} uses pinned uv updates and restores its environment and launcher`, async t => {
  const pkg = id === 'headroom' ? 'headroom-ai' : id;
  let version = '1.0.0';
  const h = harness(t, { skill: { id, kind: 'cli' }, request: async () => ({ info: { version: '2.0.0' } }),
    run: async (command, args, { home, write }) => {
      if (command !== 'uv') return;
      if (args[1] === 'dir') return { stdout: path.join(home, args.includes('--bin') ? 'bin' : 'tools') };
      if (args[1] === 'list') return { stdout: `${pkg} v${version}\n- ${id}` };
      if (args[1] === 'upgrade') {
        assert.deepEqual(Array.from(args), ['tool', 'upgrade', `${pkg}==2.0.0`]);
        version = '2.0.0'; write(`tools/${pkg}/bin/${id}`, 'new executable'); return { stdout: '' };
      }
    } });
  h.write(`tools/${pkg}/bin/${id}`, 'old executable');
  fs.mkdirSync(path.join(h.home, 'bin'));
  fs.symlinkSync(`../tools/${pkg}/bin/${id}`, path.join(h.home, `bin/${id}`));
  const review = await h.updater.check('claude', id);
  await h.updater.apply('claude', id, review.token);
  await h.reload().rollback('claude', id);
  assert.equal(fs.readFileSync(path.join(h.home, `bin/${id}`), 'utf8'), 'old executable');
  assert.equal(fs.readlinkSync(path.join(h.home, `bin/${id}`)), `../tools/${pkg}/bin/${id}`);
});

test('Homebrew RTK keeps the old keg and restores all links on rollback', async t => {
  let version = '1.0.0';
  const h = harness(t, { skill: { id: 'rtk', kind: 'cli' }, run: async (command, args, { home, write }) => {
    if (args[0] === 'info') return { stdout: JSON.stringify({ formulae: [{ linked_keg: '1.0.0', versions: { stable: '2.0.0' } }] }) };
    if (args[0] === '--prefix') return { stdout: home };
    if (args[0] === '--cellar') return { stdout: path.join(home, 'Cellar/rtk') };
    if (command === 'env') {
      assert.ok(args.includes('HOMEBREW_NO_INSTALL_CLEANUP=1'));
      write('Cellar/rtk/2.0.0/bin/rtk', 'new'); version = '2.0.0';
      for (const [link, dest] of [['bin/rtk','../Cellar/rtk/2.0.0/bin/rtk'],['opt/rtk','../Cellar/rtk/2.0.0'],['var/homebrew/linked/rtk','../../../Cellar/rtk/2.0.0']]) {
        fs.unlinkSync(path.join(home, link)); fs.symlinkSync(dest, path.join(home, link));
      }
      return { stdout: '' };
    }
    if (args[0] === '--version') return { stdout: `rtk ${version}` };
  } });
  h.write('Cellar/rtk/1.0.0/bin/rtk', 'old');
  for (const [link, dest] of [['bin/rtk','../Cellar/rtk/1.0.0/bin/rtk'],['opt/rtk','../Cellar/rtk/1.0.0'],['var/homebrew/linked/rtk','../../../Cellar/rtk/1.0.0']]) {
    fs.mkdirSync(path.dirname(path.join(h.home, link)), { recursive: true }); fs.symlinkSync(dest, path.join(h.home, link));
  }
  const review = await h.updater.check('claude', 'rtk');
  await h.updater.apply('claude', 'rtk', review.token);
  await h.reload().rollback('claude', 'rtk');
  assert.equal(fs.readFileSync(path.join(h.home, 'bin/rtk'), 'utf8'), 'old');
  assert.equal(fs.readlinkSync(path.join(h.home, 'opt/rtk')), '../Cellar/rtk/1.0.0');
});
