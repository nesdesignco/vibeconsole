#!/usr/bin/env node
/**
 * Notarize and staple the built DMG, then refresh updater metadata.
 *
 * electron-builder notarizes only the .app inside the DMG; the DMG container
 * needs its own ticket for `spctl --assess --type open` to accept it (and for
 * offline Gatekeeper checks on the download itself). Stapling changes the DMG
 * bytes, so the .dmg.blockmap and the latest-mac.yml entry are rebuilt with
 * the same code path electron-builder uses.
 *
 * Auth: uses APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID env vars (CI),
 * falling back to the local `vibeconsole-notary` keychain profile.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

const releaseDir = process.argv[2] || 'release';
const dmgs = fs.readdirSync(releaseDir).filter(f => f.endsWith('.dmg'));
if (dmgs.length !== 1) {
  console.error(`Expected exactly one DMG in ${releaseDir}, found: ${dmgs.join(', ') || 'none'}`);
  process.exit(1);
}
const dmgPath = path.join(releaseDir, dmgs[0]);

const auth = process.env.APPLE_APP_SPECIFIC_PASSWORD
  ? ['--apple-id', process.env.APPLE_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', process.env.APPLE_TEAM_ID]
  : ['--keychain-profile', 'vibeconsole-notary'];

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

run('xcrun', ['notarytool', 'submit', dmgPath, ...auth, '--wait', '--timeout', '30m']);
// stapler fails if notarization did not end in Accepted, gating the release
run('xcrun', ['stapler', 'staple', dmgPath]);

(async () => {
  const updateInfo = await buildBlockMap(dmgPath, 'gzip', `${dmgPath}.blockmap`);
  const ymlPath = path.join(releaseDir, 'latest-mac.yml');
  const meta = yaml.load(fs.readFileSync(ymlPath, 'utf8'));
  const dmgName = path.basename(dmgPath);
  for (const entry of meta.files || []) {
    if (entry.url === dmgName) {
      entry.sha512 = updateInfo.sha512;
      entry.size = updateInfo.size;
    }
  }
  if (meta.path === dmgName) {
    meta.sha512 = updateInfo.sha512;
  }
  fs.writeFileSync(ymlPath, yaml.dump(meta, { lineWidth: 8000 }));
  console.log(`Stapled ${dmgName}; refreshed blockmap and latest-mac.yml`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
