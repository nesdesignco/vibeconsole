/**
 * Shared Path Validation Utility
 * Single source of truth for path-within-project checks
 */

const path = require('path');
const fs = require('fs');
const BLOCKED_PROJECT_SEGMENTS = new Set(['.git']);

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

function isPathWithinDirectory(targetPath, basePath) {
  if (!targetPath || !basePath) return false;
  const resolvedTarget = resolvePathForContainment(targetPath);
  const resolvedBase = resolvePathForContainment(basePath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

function getRelativeSegmentsWithinBase(targetPath, basePath) {
  if (!isPathWithinDirectory(targetPath, basePath)) return null;

  const resolvedTarget = resolvePathForContainment(targetPath);
  const resolvedBase = resolvePathForContainment(basePath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (!relative) return [];

  return relative
    .split(path.sep)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function hasBlockedPathSegment(targetPath, basePath, blockedSegments = BLOCKED_PROJECT_SEGMENTS) {
  const segments = getRelativeSegmentsWithinBase(targetPath, basePath);
  if (!segments) return false;

  for (const segment of segments) {
    if (blockedSegments.has(segment)) {
      return true;
    }
  }
  return false;
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
  return isPathWithinDirectory(filePath, projectPath);
}

/**
 * Validate that a file path is within the project directory and avoids protected
 * repository metadata paths like .git/.
 * @param {string} filePath - Absolute or relative file path
 * @param {string} projectPath - Absolute project root path
 * @returns {boolean}
 */
function isPathWithinProjectContent(filePath, projectPath) {
  return isPathWithinProject(filePath, projectPath)
    && !hasBlockedPathSegment(filePath, projectPath, BLOCKED_PROJECT_SEGMENTS);
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
  return isPathWithinProject(fullPath, projectPath);
}

/**
 * Validate that a relative file path stays within project content and does not
 * target protected metadata paths like .git/.
 * @param {string} projectPath - Absolute project root path
 * @param {string} relativePath - Relative file path within project
 * @returns {boolean}
 */
function isRelativePathWithinProjectContent(projectPath, relativePath) {
  if (!projectPath || !relativePath) return false;
  const fullPath = path.resolve(path.join(projectPath, relativePath));
  return isPathWithinProjectContent(fullPath, projectPath);
}

module.exports = {
  resolvePathForContainment,
  isPathWithinDirectory,
  isPathWithinProject,
  isPathWithinProjectContent,
  isRelativePathWithinProject,
  isRelativePathWithinProjectContent
};
