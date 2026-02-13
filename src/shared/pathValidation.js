/**
 * Shared Path Validation Utility
 * Single source of truth for path-within-project checks
 */

const path = require('path');
const fs = require('fs');

/**
 * Resolve a path for containment checks.
 * If the full target does not exist, resolves the nearest existing ancestor via realpath
 * and re-attaches the remaining path segments. This prevents symlink escape bypasses
 * for create/write operations on non-existent targets.
 */
function resolvePathForContainment(p) {
  const absolute = path.resolve(p);

  try {
    return fs.realpathSync(absolute);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      return absolute;
    }

    // Walk up until we find an existing ancestor
    let cursor = absolute;
    const missingSegments = [];

    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return absolute;
      }
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }

    let resolvedBase;
    try {
      resolvedBase = fs.realpathSync(cursor);
    } catch {
      resolvedBase = path.resolve(cursor);
    }

    return path.resolve(resolvedBase, ...missingSegments);
  }
}

/**
 * Validate that a file path is within the project directory.
 * Prevents path traversal attacks (e.g. ../../etc/passwd).
 * Resolves symlinks to prevent symlink-based escapes.
 * @param {string} filePath - Absolute or relative file path
 * @param {string} projectPath - Absolute project root path
 * @returns {boolean}
 */
function isPathWithinProject(filePath, projectPath) {
  if (!projectPath || !filePath) return false;
  const resolvedFile = resolvePathForContainment(filePath);
  const resolvedProject = resolvePathForContainment(projectPath);
  return resolvedFile.startsWith(resolvedProject + path.sep) || resolvedFile === resolvedProject;
}

/**
 * Validate that a relative file path stays within the project directory.
 * Used by git managers where filePath is relative to projectPath.
 * Resolves symlinks to prevent symlink-based escapes.
 * @param {string} projectPath - Absolute project root path
 * @param {string} relativePath - Relative file path within project
 * @returns {boolean}
 */
function isRelativePathWithinProject(projectPath, relativePath) {
  if (!projectPath || !relativePath) return false;
  const fullPath = path.resolve(path.join(projectPath, relativePath));
  const resolvedProject = resolvePathForContainment(projectPath);
  const resolvedFile = resolvePathForContainment(fullPath);
  return resolvedFile.startsWith(resolvedProject + path.sep) || resolvedFile === resolvedProject;
}

module.exports = { isPathWithinProject, isRelativePathWithinProject };
