/**
 * Git Commit Operations
 * Commit creation, amendment, undo, and revert extracted from gitChangesManager.
 */

const { execFileGit, formatGitError } = require('./gitExecUtils');

let _invalidateActivityCache = null;

/**
 * Initialize with callbacks from the orchestrator.
 * @param {{ invalidateActivityCache: Function }} deps
 */
function init(deps) {
  if (deps && typeof deps.invalidateActivityCache === 'function') {
    _invalidateActivityCache = deps.invalidateActivityCache;
  }
}

function onActivityChange(projectPath) {
  if (_invalidateActivityCache) _invalidateActivityCache(projectPath);
}

/**
 * Create a git commit with the given message
 */
async function gitCommit(projectPath, message) {
  if (!projectPath) return { error: 'Missing project path' };
  if (!message || !message.trim()) return { error: 'Commit message cannot be empty' };
  if (message.length > 10000) return { error: 'Commit message too long' };

  try {
    // Avoid buffering huge staged file lists in large repos.
    const { stdout: staged } = await execFileGit(
      ['diff', '--cached', '--name-only'],
      projectPath,
      10 * 1024 * 1024,
      60000
    );
    if (!staged) return { error: 'Nothing staged to commit' };

    const trimmed = message.trim();
    const splitIdx = trimmed.indexOf('\n\n');
    const summary = splitIdx === -1 ? trimmed : trimmed.slice(0, splitIdx).trim();
    const body = splitIdx === -1 ? '' : trimmed.slice(splitIdx + 2).trim();
    const args = body ? ['commit', '-m', summary, '-m', body] : ['commit', '-m', summary];

    // Hooks can be slow; keep the UI responsive but don't time out too aggressively.
    await execFileGit(args, projectPath, 10 * 1024 * 1024, 5 * 60 * 1000);
    onActivityChange(projectPath);
    return { error: null };
  } catch (err) {
    const stderr = err.stderr || '';
    if (stderr.includes('nothing to commit')) return { error: 'Nothing to commit' };
    if (stderr.includes('empty ident')) return { error: 'Git user name/email not configured' };
    if (stderr.includes('hook') || (err.error && err.error.includes('hook'))) return { error: 'Pre-commit hook failed' };
    return { error: err.error || 'Commit failed' };
  }
}

/**
 * Amend the last commit, optionally with a new message
 */
async function gitCommitAmend(projectPath, message) {
  if (!projectPath) return { error: 'Missing project path' };
  if (message && message.length > 10000) return { error: 'Commit message too long' };

  try {
    let args;
    if (message && message.trim()) {
      const trimmed = message.trim();
      const splitIdx = trimmed.indexOf('\n\n');
      const summary = splitIdx === -1 ? trimmed : trimmed.slice(0, splitIdx).trim();
      const body = splitIdx === -1 ? '' : trimmed.slice(splitIdx + 2).trim();
      args = body
        ? ['commit', '--amend', '-m', summary, '-m', body]
        : ['commit', '--amend', '-m', summary];
    } else {
      args = ['commit', '--amend', '--no-edit'];
    }

    await execFileGit(args, projectPath, 10 * 1024 * 1024, 5 * 60 * 1000);
    onActivityChange(projectPath);
    return { error: null };
  } catch (err) {
    const stderr = err.stderr || '';
    if (stderr.includes('hook') || (err.error && err.error.includes('hook'))) return { error: 'Pre-commit hook failed' };
    return { error: err.error || 'Amend failed' };
  }
}

/**
 * Undo last commit (soft reset, keeps changes staged)
 */
async function undoLastCommit(projectPath) {
  if (!projectPath) {
    return { error: 'Missing parameters' };
  }

  try {
    // Check that HEAD~1 exists (not initial commit)
    await execFileGit(['rev-parse', 'HEAD~1'], projectPath);
    await execFileGit(['reset', '--soft', 'HEAD~1'], projectPath);
    onActivityChange(projectPath);
    return { error: null };
  } catch (err) {
    if (err.stderr && err.stderr.includes('unknown revision')) {
      // Initial commit: delete the current branch ref to return to an unborn branch,
      // leaving index intact (files remain staged).
      try {
        const { stdout: branch } = await execFileGit(['branch', '--show-current'], projectPath);
        const name = String(branch || '').trim();
        if (!name) return { error: 'Cannot undo: detached HEAD' };
        // Basic refname sanity check (keep it conservative).
        if (!/^[A-Za-z0-9._/-]+$/.test(name)) return { error: 'Cannot undo: invalid branch name' };
        await execFileGit(['update-ref', '-d', `refs/heads/${name}`], projectPath);
        onActivityChange(projectPath);
        return { error: null };
      } catch (inner) {
        return { error: inner.error || 'Failed to undo initial commit' };
      }
    }
    return { error: err.error || 'Failed to undo commit' };
  }
}

/**
 * Revert a specific commit (creates a new revert commit)
 */
async function revertCommit(projectPath, commitHash) {
  if (!projectPath || !commitHash) {
    return { error: 'Missing parameters' };
  }

  // Validate commit hash
  if (!/^[a-f0-9]+$/i.test(commitHash)) {
    return { error: 'Invalid commit hash' };
  }

  try {
    // If this is a merge commit, git requires a mainline parent. Most GUIs use -m 1.
    let args = ['revert', '--no-edit'];
    try {
      const { stdout } = await execFileGit(['rev-list', '--parents', '-n', '1', commitHash], projectPath);
      const parts = String(stdout || '').trim().split(/\s+/).filter(Boolean);
      const parentCount = Math.max(0, parts.length - 1);
      if (parentCount > 1) args = ['revert', '--no-edit', '-m', '1'];
    } catch {
      // If the metadata lookup fails, fall back to a normal revert and let git report the error.
    }

    await execFileGit([...args, commitHash], projectPath);
    onActivityChange(projectPath);
    return { error: null };
  } catch (err) {
    return { error: formatGitError(err, 'Failed to revert commit') };
  }
}

module.exports = {
  init,
  gitCommit,
  gitCommitAmend,
  undoLastCommit,
  revertCommit
};
