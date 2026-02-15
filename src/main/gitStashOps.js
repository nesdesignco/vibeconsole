/**
 * Git Stash Operations
 * All stash-related operations extracted from gitChangesManager.
 */

const { execFileGit, isValidStashRef } = require('./gitExecUtils');
const { isRelativePathWithinProject } = require('../shared/pathValidation');

/**
 * Stash changes (optionally a single file, with optional message)
 */
async function stashChanges(projectPath, filePath, message, includeUntracked = false) {
  if (!projectPath) {
    return { error: 'Missing parameters' };
  }

  if (filePath && !isRelativePathWithinProject(projectPath, filePath)) {
    return { error: 'Path is outside project directory' };
  }

  try {
    const args = ['stash', 'push'];
    if (includeUntracked) {
      args.push('--include-untracked');
    }
    if (message) {
      args.push('-m', message);
    }
    if (filePath) {
      args.push('--', filePath);
    }
    await execFileGit(args, projectPath);
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to stash changes' };
  }
}

/**
 * List stashes
 */
async function stashList(projectPath) {
  if (!projectPath) {
    return { error: 'Missing parameters', stashes: [] };
  }

  try {
    const { stdout } = await execFileGit(
      ['stash', 'list', '--pretty=format:%gd%x00%s%x00%ar'],
      projectPath
    );

    const stashes = [];
    if (stdout) {
      stdout.split('\n').filter(Boolean).forEach(line => {
        const parts = line.split('\0');
        if (parts.length >= 3) {
          stashes.push({
            ref: parts[0],
            message: parts[1],
            relativeTime: parts[2]
          });
        }
      });
    }

    return { error: null, stashes };
  } catch (err) {
    return { error: err.error || 'Failed to list stashes', stashes: [] };
  }
}

/**
 * Apply a stash (keeps it in the stash list)
 */
async function stashApply(projectPath, stashRef) {
  if (!projectPath || !stashRef) {
    return { error: 'Missing parameters' };
  }
  if (!isValidStashRef(stashRef)) {
    return { error: 'Invalid stash reference' };
  }

  try {
    const result = await execFileGit(['stash', 'apply', stashRef], projectPath);
    const hasConflicts = result.stderr && result.stderr.includes('CONFLICT');
    return { error: null, conflicts: hasConflicts };
  } catch (err) {
    if (err.stderr && err.stderr.includes('CONFLICT')) {
      return { error: null, conflicts: true };
    }
    return { error: err.error || 'Failed to apply stash' };
  }
}

/**
 * Pop a stash (apply and remove from stash list)
 */
async function stashPop(projectPath, stashRef) {
  if (!projectPath || !stashRef) {
    return { error: 'Missing parameters' };
  }
  if (!isValidStashRef(stashRef)) {
    return { error: 'Invalid stash reference' };
  }

  try {
    const result = await execFileGit(['stash', 'pop', stashRef], projectPath);
    const hasConflicts = result.stderr && result.stderr.includes('CONFLICT');
    return { error: null, conflicts: hasConflicts };
  } catch (err) {
    if (err.stderr && err.stderr.includes('CONFLICT')) {
      return { error: null, conflicts: true, kept: true };
    }
    return { error: err.error || 'Failed to pop stash' };
  }
}

/**
 * Drop a stash
 */
async function stashDrop(projectPath, stashRef) {
  if (!projectPath || !stashRef) {
    return { error: 'Missing parameters' };
  }
  if (!isValidStashRef(stashRef)) {
    return { error: 'Invalid stash reference' };
  }

  try {
    await execFileGit(['stash', 'drop', stashRef], projectPath);
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to drop stash' };
  }
}

/**
 * Show stash diff
 */
async function stashShow(projectPath, stashRef) {
  if (!projectPath || !stashRef) {
    return { error: 'Missing parameters', diff: '' };
  }
  if (!isValidStashRef(stashRef)) {
    return { error: 'Invalid stash reference', diff: '' };
  }

  try {
    const { stdout } = await execFileGit(['stash', 'show', '-p', stashRef], projectPath, 5 * 1024 * 1024);
    return { error: null, diff: stdout || '(No diff available)' };
  } catch (err) {
    return { error: err.error || 'Failed to show stash', diff: '' };
  }
}

module.exports = {
  stashChanges,
  stashList,
  stashApply,
  stashPop,
  stashDrop,
  stashShow
};
