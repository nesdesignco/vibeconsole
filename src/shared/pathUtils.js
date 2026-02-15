/**
 * Shared PATH Augmentation Utilities
 * Finder-launched Electron apps on macOS don't inherit the user's shell PATH.
 * These helpers ensure common package-manager and language-manager bins are reachable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const commandPathCache = new Map();

/**
 * Build an augmented PATH string that includes common bin directories.
 * @returns {string} Colon/semicolon-separated PATH
 */
function buildAugmentedPath() {
  const delimiter = path.delimiter || ':';
  const currentPath = process.env.PATH || '';
  const homeDir = (typeof os.homedir === 'function' ? os.homedir() : '') || process.env.HOME || process.env.USERPROFILE || '';

  const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/local/sbin',
    homeDir ? path.join(homeDir, 'bin') : null,
    homeDir ? path.join(homeDir, '.local/bin') : null,
    homeDir ? path.join(homeDir, '.npm-global/bin') : null,
    homeDir ? path.join(homeDir, '.yarn/bin') : null,
    homeDir ? path.join(homeDir, '.bun/bin') : null,
    homeDir ? path.join(homeDir, '.cargo/bin') : null,
    homeDir ? path.join(homeDir, '.asdf/bin') : null,
    homeDir ? path.join(homeDir, '.asdf/shims') : null,
    homeDir ? path.join(homeDir, '.pyenv/bin') : null,
    homeDir ? path.join(homeDir, '.pyenv/shims') : null
  ].filter(Boolean);

  const parts = [...currentPath.split(delimiter), ...extraPaths]
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  return [...new Set(parts)].join(delimiter);
}

/**
 * Build a process.env clone with augmented PATH.
 * @returns {Object} Environment object
 */
function buildExecEnv() {
  return {
    ...process.env,
    PATH: buildAugmentedPath()
  };
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command name to its absolute path using the given PATH string.
 * Results are cached for the lifetime of the process.
 * @param {string} cmd - Command name (e.g. 'git')
 * @param {string} [envPath] - PATH string to search (defaults to augmented PATH)
 * @returns {string|null} Absolute path or null
 */
function resolveCommandPath(cmd, envPath) {
  const command = String(cmd || '').trim();
  if (!command) return null;
  if (path.isAbsolute(command) || command.includes(path.sep)) return command;
  const cacheKey = `${command}::${envPath || ''}`;
  if (commandPathCache.has(cacheKey)) return commandPathCache.get(cacheKey);

  const delimiter = path.delimiter || ':';
  const pathEntries = String(envPath || '').split(delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  const extCandidates = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map(ext => ext.toLowerCase())
    : [''];
  const commandLower = command.toLowerCase();

  for (const entry of pathEntries) {
    if (!entry) continue;
    if (isWin) {
      const hasExt = extCandidates.some(ext => ext && commandLower.endsWith(ext));
      const candidates = hasExt
        ? [path.join(entry, command)]
        : extCandidates.map(ext => path.join(entry, `${command}${ext}`));
      for (const candidate of candidates) {
        if (isExecutableFile(candidate)) {
          commandPathCache.set(cacheKey, candidate);
          return candidate;
        }
      }
      continue;
    }

    const candidate = path.join(entry, command);
    if (isExecutableFile(candidate)) {
      commandPathCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  commandPathCache.set(cacheKey, null);
  return null;
}

module.exports = {
  buildAugmentedPath,
  buildExecEnv,
  resolveCommandPath
};
