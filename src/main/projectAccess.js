/**
 * Project Access Module
 *
 * The path-containment helpers in shared/pathValidation are correct, but every
 * IPC handler called them as `isPathWithinProjectContent(filePath, projectPath)`
 * with *both* arguments taken from the same renderer message. A caller could
 * therefore supply its own base — `{ projectPath: '/', filePath: '~/.ssh/id_rsa' }`
 * satisfies containment — which made the checks vacuous.
 *
 * This module keeps the set of project roots the main process itself has seen,
 * and re-exports the validators with that check applied first. Handlers keep
 * calling the same function names; only their import changes.
 *
 * Roots become known in exactly two ways, both authoritative and both in main:
 *   - the folder picker / new-project dialog registers the path it just produced
 *   - the workspace file, which is where every previously opened project lives
 */

const path = require('path');
const workspace = require('./workspace');
const {
  isPathWithinProjectContent: isPathWithinProjectContentUnchecked,
  isRelativePathWithinProjectContent: isRelativePathWithinProjectContentUnchecked
} = require('../shared/pathValidation');

const registeredRoots = new Set();

function normalizeRoot(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return null;
  try {
    return path.resolve(projectPath);
  } catch {
    return null;
  }
}

/**
 * Record a project root the main process produced itself.
 * @param {string} projectPath
 * @returns {string|null} the resolved root, or null if the input was unusable
 */
function registerProjectRoot(projectPath) {
  const resolved = normalizeRoot(projectPath);
  if (resolved) registeredRoots.add(resolved);
  return resolved;
}

/**
 * True when projectPath is a root this process knows about.
 *
 * The workspace file is consulted lazily rather than snapshotted at startup:
 * the renderer registers a newly picked project through ADD_PROJECT_TO_WORKSPACE
 * and projects persist across runs, so the file — not a boot-time copy — is the
 * source of truth.
 */
function isKnownProjectRoot(projectPath) {
  const resolved = normalizeRoot(projectPath);
  if (!resolved) return false;
  if (registeredRoots.has(resolved)) return true;

  for (const project of workspace.getProjects()) {
    const known = normalizeRoot(project && project.path);
    if (known) registeredRoots.add(known);
  }
  return registeredRoots.has(resolved);
}

function isPathWithinProjectContent(filePath, projectPath) {
  if (!isKnownProjectRoot(projectPath)) return false;
  return isPathWithinProjectContentUnchecked(filePath, projectPath);
}

function isRelativePathWithinProjectContent(projectPath, relativePath) {
  if (!isKnownProjectRoot(projectPath)) return false;
  return isRelativePathWithinProjectContentUnchecked(projectPath, relativePath);
}

module.exports = {
  registerProjectRoot,
  isKnownProjectRoot,
  isPathWithinProjectContent,
  isRelativePathWithinProjectContent
};
