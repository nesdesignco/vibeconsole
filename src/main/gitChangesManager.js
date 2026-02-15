/**
 * Git Changes Manager Module
 * Handles git status, diff, stage, and unstage operations
 */

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const { isRelativePathWithinProject } = require('../shared/pathValidation');

// Shared utilities
const {
  execFileGit,
  formatGitError,
  execGitWithStdin,
  execFileCmd,
  parseStatusLine,
  isUnmergedStatus,
  parseCommitList,
  extractHunkPatches,
  formatLocalDate
} = require('./gitExecUtils');

// Domain operations
const gitStashOps = require('./gitStashOps');
const gitCommitOps = require('./gitCommitOps');

const ACTIVITY_LOOKBACK_DAYS = 365;
const ACTIVITY_CACHE_TTL_MS = 30000;
const REPO_STATUS_CACHE_TTL_MS = 1200;
const AHEAD_BEHIND_CACHE_TTL_MS = 1200;
const activityCache = new Map();
const repoStatusCache = new Map();
const repoStatusInFlight = new Map();
const aheadBehindCache = new Map();
const aheadBehindInFlight = new Map();

/**
 * Initialize manager
 */
function init(_window) {
  // Window reference reserved for future use
  gitCommitOps.init({ invalidateActivityCache });
}

function getActivityCacheKey(projectPath, days) {
  return `${projectPath}::${days}`;
}

function getRepoCacheKey(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return '';
  try {
    return path.resolve(projectPath);
  } catch {
    return projectPath;
  }
}

function invalidateActivityCache(projectPath) {
  for (const key of activityCache.keys()) {
    if (key.startsWith(`${projectPath}::`)) {
      activityCache.delete(key);
    }
  }
}

function invalidateRepoStatusCache(projectPath) {
  const key = getRepoCacheKey(projectPath);
  if (!key) return;
  repoStatusCache.delete(key);
  repoStatusInFlight.delete(key);
}

function invalidateAheadBehindCache(projectPath) {
  const key = getRepoCacheKey(projectPath);
  if (!key) return;
  aheadBehindCache.delete(key);
  aheadBehindInFlight.delete(key);
}

function invalidateRepoCaches(projectPath, options = {}) {
  const { status = true, aheadBehind = true, activity = false } = options;
  if (status) invalidateRepoStatusCache(projectPath);
  if (aheadBehind) invalidateAheadBehindCache(projectPath);
  if (activity) invalidateActivityCache(projectPath);
}

/**
 * Load recent commits from HEAD (used when no upstream/tracking branch is configured).
 */
async function loadLocalCommits(projectPath, maxCount = 20) {
  try {
    const count = Math.max(1, Math.min(Number(maxCount) || 20, 50));
    const { stdout } = await execFileGit(
      ['log', `--max-count=${count}`, '--pretty=format:%H%x00%h%x00%s%x00%an%x00%ar'],
      projectPath,
      2 * 1024 * 1024,
      15000
    );
    return parseCommitList(stdout);
  } catch {
    return [];
  }
}

/**
 * Load outgoing (ahead) and incoming (behind) commits relative to upstream.
 */
async function loadSyncCommits(projectPath) {
  try {
    // Find upstream tracking branch
    const { stdout: upstream } = await execFileGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      projectPath
    );

    if (!upstream) {
      return {
        outgoingCommits: [],
        incomingCommits: [],
        hasUpstream: false,
        trackingBranch: null
      };
    }

    // Get commits ahead of upstream (use null byte delimiter to avoid pipes/newlines in messages)
    const { stdout: outgoingStdout } = await execFileGit(
      ['log', '@{u}..HEAD', '--pretty=format:%H%x00%h%x00%s%x00%an%x00%ar', '--max-count=50'],
      projectPath
    );

    // Get commits behind upstream
    const { stdout: incomingStdout } = await execFileGit(
      ['log', 'HEAD..@{u}', '--pretty=format:%H%x00%h%x00%s%x00%an%x00%ar', '--max-count=50'],
      projectPath
    );

    return {
      outgoingCommits: parseCommitList(outgoingStdout),
      incomingCommits: parseCommitList(incomingStdout),
      hasUpstream: true,
      trackingBranch: upstream.trim()
    };
  } catch {
    // No upstream configured, detached HEAD, etc.
    return {
      outgoingCommits: [],
      incomingCommits: [],
      hasUpstream: false,
      trackingBranch: null
    };
  }
}

/**
 * Load ASCII lane graph for recent commits.
 */
async function loadCommitGraph(projectPath, maxCount = 200) {
  try {
    const { stdout } = await execFileGit([
      'log',
      '--graph',
      '--date-order',
      '--all',
      `--max-count=${Math.max(20, Math.min(maxCount, 400))}`,
      '--pretty=format:%x01%H%x01%h%x01%s%x01%an%x01%ar'
    ], projectPath, 5 * 1024 * 1024);

    const byHash = {};
    if (stdout) {
      stdout.split('\n').forEach(line => {
        const sep = line.indexOf('\x01');
        if (sep === -1) return;
        const graph = line.slice(0, sep);
        const [hash] = line.slice(sep + 1).split('\x01');
        if (hash && !byHash[hash]) byHash[hash] = graph;
      });
    }
    return { byHash };
  } catch {
    return { byHash: {} };
  }
}

/**
 * Load GitHub-style daily commit activity for the last N days.
 */
async function loadGitActivity(projectPath, days = ACTIVITY_LOOKBACK_DAYS) {
  if (!projectPath) return { activity: [], activityTotal: 0 };

  const cacheKey = getActivityCacheKey(projectPath, days);
  const cached = activityCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < ACTIVITY_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const end = new Date();
    end.setHours(12, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - Math.max(1, days) + 1);
    const since = formatLocalDate(start);

    const { stdout } = await execFileGit(
      ['log', '--all', `--since=${since}`, '--date=short', '--pretty=format:%ad'],
      projectPath,
      4 * 1024 * 1024,
      15000
    );

    const counts = new Map();
    let activityTotal = 0;
    if (stdout) {
      stdout.split('\n').filter(Boolean).forEach((dateStr) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
        const next = (counts.get(dateStr) || 0) + 1;
        counts.set(dateStr, next);
        activityTotal++;
      });
    }

    const activity = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const date = formatLocalDate(cursor);
      activity.push({
        date,
        count: counts.get(date) || 0
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    const value = { activity, activityTotal };
    activityCache.set(cacheKey, { cachedAt: Date.now(), value });
    return value;
  } catch {
    return { activity: [], activityTotal: 0 };
  }
}

/**
 * Fetch remote refs for accurate incoming/outgoing calculations.
 */
async function gitFetch(projectPath, prune = true) {
  if (!projectPath) return { error: 'Missing project path' };

  try {
    const args = ['fetch'];
    if (prune) args.push('--prune');
    await execFileGit(args, projectPath, 2 * 1024 * 1024, 120000);
    return { error: null };
  } catch (err) {
    const stderr = err.stderr || '';
    if (stderr.includes('No remote repository specified')) return { error: 'No remote configured' };
    return { error: err.error || 'Fetch failed' };
  }
}

async function gitPush(projectPath, branch, setUpstream) {
  if (!projectPath) return { error: 'Missing project path' };

  try {
    const args = ['push'];
    if (setUpstream && branch) {
      args.push('-u', 'origin', branch);
    }
    await execFileGit(args, projectPath, 2 * 1024 * 1024, 120000);
    return { error: null };
  } catch (err) {
    return { error: formatGitError(err, 'Push failed') };
  }
}

async function gitPull(projectPath, branch, noUpstream) {
  if (!projectPath) return { error: 'Missing project path' };

  try {
    const args = ['pull'];
    if (noUpstream && branch) {
      args.push('origin', branch);
    }
    await execFileGit(args, projectPath, 10 * 1024 * 1024, 120000);
    return { error: null };
  } catch (err) {
    return { error: formatGitError(err, 'Pull failed') };
  }
}

/**
 * Apply a single hunk patch to index and/or working tree.
 */
async function applyGitHunk(projectPath, filePath, diffType, action, hunkPatch) {
  if (!projectPath || !filePath || !diffType || !action || !hunkPatch) {
    return { error: 'Missing parameters' };
  }
  if (!isRelativePathWithinProject(projectPath, filePath)) {
    return { error: 'Path is outside project directory' };
  }
  if (typeof hunkPatch !== 'string' || hunkPatch.length > 1024 * 1024 || !hunkPatch.includes('@@')) {
    return { error: 'Invalid hunk patch' };
  }

  const normalizedAction = String(action).toLowerCase();
  if (!['stage', 'unstage', 'discard'].includes(normalizedAction)) {
    return { error: 'Invalid hunk action' };
  }

  try {
    let args;
    if (normalizedAction === 'stage') {
      if (!['unstaged', 'conflict'].includes(diffType)) return { error: 'Hunk stage is only available for unstaged/conflict diff' };
      args = ['apply', '--cached', '--whitespace=nowarn', '-'];
    } else if (normalizedAction === 'unstage') {
      if (diffType !== 'staged') return { error: 'Hunk unstage is only available for staged diff' };
      args = ['apply', '-R', '--cached', '--whitespace=nowarn', '-'];
    } else {
      if (!['unstaged', 'conflict'].includes(diffType)) return { error: 'Hunk discard is only available for unstaged/conflict diff' };
      args = ['apply', '-R', '--whitespace=nowarn', '-'];
    }

    await execGitWithStdin(args, hunkPatch, projectPath, 30000);
    return { error: null };
  } catch (err) {
    return { error: err.stderr || err.error || 'Failed to apply hunk' };
  }
}

/**
 * Load base/ours/theirs versions for a conflicted file.
 */
async function loadGitConflict(projectPath, filePath) {
  if (!projectPath || !filePath) return { error: 'Missing parameters' };
  if (!isRelativePathWithinProject(projectPath, filePath)) return { error: 'Path is outside project directory' };

  const fullPath = path.join(projectPath, filePath);

  try {
    const { stdout: unmerged } = await execFileGit(['ls-files', '-u', '--', filePath], projectPath);
    if (!unmerged) {
      return { error: 'File is not in conflict state' };
    }

    const readStage = async (stage) => {
      try {
        const { stdout } = await execFileGit(['show', `:${stage}:${filePath}`], projectPath, 5 * 1024 * 1024);
        return stdout;
      } catch {
        return '';
      }
    };

    const base = await readStage(1);
    const ours = await readStage(2);
    const theirs = await readStage(3);
    const current = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : ours || theirs || '';

    return { error: null, filePath, base, ours, theirs, current };
  } catch (err) {
    return { error: err.error || 'Failed to load conflict data' };
  }
}

/**
 * Save resolved conflict content and stage file.
 */
async function resolveGitConflict(projectPath, filePath, resolvedContent) {
  if (!projectPath || !filePath || typeof resolvedContent !== 'string') return { error: 'Missing parameters' };
  if (!isRelativePathWithinProject(projectPath, filePath)) return { error: 'Path is outside project directory' };
  if (resolvedContent.length > 5 * 1024 * 1024) return { error: 'Resolved content too large' };

  try {
    const fullPath = path.join(projectPath, filePath);
    fs.writeFileSync(fullPath, resolvedContent, 'utf8');
    await execFileGit(['add', '--', filePath], projectPath);
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to resolve conflict' };
  }
}

/**
 * Load diff for a specific commit
 */
async function loadCommitDiff(projectPath, commitHash) {
  if (!projectPath || !commitHash) {
    return { error: 'Missing parameters', diff: '' };
  }

  // Sanitize commit hash - only allow hex characters
  if (!/^[a-f0-9]+$/i.test(commitHash)) {
    return { error: 'Invalid commit hash', diff: '' };
  }

  try {
    // Use `git show` for commit diffs; it's stable for root commits and doesn't
    // depend on parent range construction.
    const { stdout } = await execFileGit(
      ['show', '--format=', '--no-color', '--root', commitHash],
      projectPath,
      5 * 1024 * 1024,
      15000
    );
    return { error: null, diff: stdout || '(No diff available)' };
  } catch (err) {
    return { error: err.error || 'Failed to load commit diff', diff: '' };
  }
}

/**
 * Load git changes (status)
 */
async function loadChanges(projectPath) {
  if (!projectPath) {
    return {
      error: 'No project selected',
      conflicts: [],
      staged: [],
      unstaged: [],
      untracked: [],
      totalCount: 0,
      unpushedCommits: [],
      outgoingCommits: [],
      incomingCommits: [],
      localCommits: [],
      commitGraphByHash: {},
      activity: [],
      activityTotal: 0,
      hasUpstream: false,
      trackingBranch: null
    };
  }

  try {
    await execFileGit(['rev-parse', '--is-inside-work-tree'], projectPath);

    const { stdout } = await execFileGit(['status', '--porcelain'], projectPath);

    const conflicts = [];
    const staged = [];
    const unstaged = [];
    const untracked = [];

    if (stdout) {
      stdout.split('\n').filter(Boolean).forEach(line => {
        const parsed = parseStatusLine(line);
        if (!parsed) return;

        const { x, y } = parsed;
        const fileInfo = { path: parsed.path, oldPath: parsed.oldPath };

        // Unmerged conflicts are their own section in professional UIs.
        if (isUnmergedStatus(x, y)) {
          conflicts.push({ ...fileInfo, status: `${x}${y}`, x, y });
          return;
        }

        // Untracked files
        if (x === '?' && y === '?') {
          untracked.push({ ...fileInfo, status: '?' });
          return;
        }

        // Staged changes (X column, ignore '?' and ' ')
        if (x !== ' ' && x !== '?') {
          staged.push({ ...fileInfo, status: x });
        }

        // Unstaged changes (Y column, ignore '?' and ' ')
        if (y !== ' ' && y !== '?') {
          unstaged.push({ ...fileInfo, status: y });
        }
      });
    }

    // Load sync metadata
    const {
      outgoingCommits,
      incomingCommits,
      hasUpstream,
      trackingBranch
    } = await loadSyncCommits(projectPath);

    const { byHash: commitGraphByHash } = await loadCommitGraph(projectPath);
    const { activity, activityTotal } = await loadGitActivity(projectPath);
    const decorateCommit = (commit) => ({
      ...commit,
      graph: commitGraphByHash[commit.hash] || '*'
    });

    const outgoingWithGraph = outgoingCommits.map(decorateCommit);
    const incomingWithGraph = incomingCommits.map(decorateCommit);
    const localCommits = hasUpstream ? [] : (await loadLocalCommits(projectPath)).map(decorateCommit);
    const unpushedCommits = outgoingWithGraph;
    const totalCount = conflicts.length + staged.length + unstaged.length + untracked.length;
    return {
      error: null,
      conflicts,
      staged,
      unstaged,
      untracked,
      totalCount,
      unpushedCommits,
      outgoingCommits: outgoingWithGraph,
      incomingCommits: incomingWithGraph,
      localCommits,
      commitGraphByHash,
      activity,
      activityTotal,
      hasUpstream,
      trackingBranch
    };
  } catch (err) {
    return {
      error: err.error || 'Not a git repository',
      conflicts: [],
      staged: [],
      unstaged: [],
      untracked: [],
      totalCount: 0,
      unpushedCommits: [],
      outgoingCommits: [],
      incomingCommits: [],
      localCommits: [],
      commitGraphByHash: {},
      activity: [],
      activityTotal: 0,
      hasUpstream: false,
      trackingBranch: null
    };
  }
}

async function loadChangesCached(projectPath, options = {}) {
  const key = getRepoCacheKey(projectPath);
  if (!key) return loadChanges(projectPath);

  if (options.force === true) {
    invalidateRepoStatusCache(projectPath);
  }

  const cached = repoStatusCache.get(key);
  if (cached && (Date.now() - cached.cachedAt) < REPO_STATUS_CACHE_TTL_MS) {
    return cached.value;
  }

  const inFlight = repoStatusInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = loadChanges(projectPath)
    .then((value) => {
      repoStatusCache.set(key, { cachedAt: Date.now(), value });
      return value;
    })
    .finally(() => {
      repoStatusInFlight.delete(key);
    });

  repoStatusInFlight.set(key, promise);
  return promise;
}

/**
 * Load diff for a specific file
 * diffType: 'staged', 'unstaged', 'untracked', 'conflict'
 */
async function loadDiff(projectPath, filePath, diffType) {
  if (!projectPath || !filePath) {
    return { error: 'Missing parameters', diff: '' };
  }

  if (!isRelativePathWithinProject(projectPath, filePath)) {
    return { error: 'Path is outside project directory', diff: '' };
  }

  try {
    let diff = '';

    if (diffType === 'untracked') {
      // For untracked files, read file content and format as "all added"
      const fullPath = path.join(projectPath, filePath);
      try {
        // Check if binary
        const { stdout: mimeOut } = await execFileCmd('file', ['--mime-encoding', fullPath], projectPath);
        if (mimeOut.includes('binary')) {
          return { error: null, diff: 'Binary file', filePath };
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
        diff += lines.map(line => `+${line}`).join('\n');
      } catch {
        return { error: 'Cannot read file', diff: '' };
      }
    } else if (diffType === 'staged') {
      const { stdout } = await execFileGit(['diff', '--cached', '--', filePath], projectPath);
      if (stdout) {
        diff = stdout;
      } else {
        // Fallback: staging state may have changed since the list was loaded
        const { stdout: headDiff } = await execFileGit(['diff', 'HEAD', '--', filePath], projectPath);
        diff = headDiff || '(No diff available)';
      }
    } else {
      const { stdout } = await execFileGit(['diff', '--', filePath], projectPath);
      if (stdout) {
        diff = stdout;
      } else {
        // Fallback: file may have been staged since the list was loaded
        const { stdout: headDiff } = await execFileGit(['diff', 'HEAD', '--', filePath], projectPath);
        diff = headDiff || '(No diff available)';
      }
    }

    // Check for binary
    if (diff.includes('Binary files')) {
      return { error: null, diff: 'Binary file', filePath };
    }

    return { error: null, diff, filePath };
  } catch (err) {
    return { error: err.error || 'Failed to load diff', diff: '' };
  }
}

/**
 * Stage a file
 */
async function stageFile(projectPath, filePath) {
  if (!projectPath || !filePath) {
    return { error: 'Missing parameters' };
  }

  if (!isRelativePathWithinProject(projectPath, filePath)) {
    return { error: 'Path is outside project directory' };
  }

  try {
    await execFileGit(['add', '--', filePath], projectPath);
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to stage file' };
  }
}

/**
 * Unstage a file
 */
async function unstageFile(projectPath, filePath) {
  if (!projectPath || !filePath) {
    return { error: 'Missing parameters' };
  }

  if (!isRelativePathWithinProject(projectPath, filePath)) {
    return { error: 'Path is outside project directory' };
  }

  try {
    await execFileGit(['reset', 'HEAD', '--', filePath], projectPath);
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to unstage file' };
  }
}

/**
 * Discard changes for a file
 * diffType: 'staged', 'unstaged', 'untracked'
 */
async function discardFile(projectPath, filePath, diffType) {
  if (!projectPath || !filePath) {
    return { error: 'Missing parameters' };
  }

  if (!isRelativePathWithinProject(projectPath, filePath)) {
    return { error: 'Path is outside project directory' };
  }

  try {
    if (diffType === 'untracked') {
      // Move untracked file or directory to trash (recoverable)
      const fullPath = path.join(projectPath, filePath);
      await shell.trashItem(fullPath);
    } else if (diffType === 'staged') {
      // Restore staged file to HEAD version
      await execFileGit(['checkout', 'HEAD', '--', filePath], projectPath);
    } else {
      // Restore unstaged changes
      await execFileGit(['checkout', '--', filePath], projectPath);
    }
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to discard file' };
  }
}

/**
 * Discard all unstaged changes
 */
async function discardAllUnstaged(projectPath) {
  if (!projectPath) {
    return { error: 'Missing parameters' };
  }

  try {
    // Restore tracked files and remove untracked files/dirs.
    // Keep ignored files intact (no -x) to match "unstaged changes" scope.
    await execFileGit(['checkout', '--', '.'], projectPath);
    await execFileGit(['clean', '-fd'], projectPath);
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to discard changes' };
  }
}

/**
 * Stage all files
 */
async function stageAll(projectPath) {
  if (!projectPath) {
    return { error: 'Missing parameters' };
  }

  try {
    await execFileGit(['add', '.'], projectPath);
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to stage all' };
  }
}

/**
 * Unstage all files
 */
async function unstageAll(projectPath) {
  if (!projectPath) {
    return { error: 'Missing parameters' };
  }

  try {
    try {
      // Normal case: reset index to HEAD (unstage everything).
      await execFileGit(['reset'], projectPath);
    } catch (err) {
      // Unborn branch (e.g. after undoing the initial commit): remove everything from index.
      if (err.stderr && err.stderr.includes('unknown revision')) {
        await execFileGit(['rm', '-r', '--cached', '.'], projectPath, 10 * 1024 * 1024, 60000);
      } else {
        throw err;
      }
    }
    return { error: null };
  } catch (err) {
    return { error: err.error || 'Failed to unstage all' };
  }
}

/**
 * Get ahead/behind count relative to upstream tracking branch
 */
async function gitAheadBehind(projectPath) {
  if (!projectPath) return { ahead: 0, behind: 0, branch: null, hasUpstream: false };

  try {
    const { stdout: branch } = await execFileGit(['branch', '--show-current'], projectPath);
    if (!branch) return { ahead: 0, behind: 0, branch: null, hasUpstream: false };

    let upstream;
    try {
      const result = await execFileGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], projectPath);
      upstream = result.stdout;
    } catch {
      return { ahead: 0, behind: 0, branch, hasUpstream: false };
    }

    const { stdout: counts } = await execFileGit(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], projectPath);
    const parts = counts.split(/\s+/);
    const behind = parseInt(parts[0], 10) || 0;
    const ahead = parseInt(parts[1], 10) || 0;

    return { ahead, behind, branch, upstream, hasUpstream: true };
  } catch {
    return { ahead: 0, behind: 0, branch: null, hasUpstream: false };
  }
}

async function gitAheadBehindCached(projectPath, options = {}) {
  const key = getRepoCacheKey(projectPath);
  if (!key) return gitAheadBehind(projectPath);

  if (options.force === true) {
    invalidateAheadBehindCache(projectPath);
  }

  const cached = aheadBehindCache.get(key);
  if (cached && (Date.now() - cached.cachedAt) < AHEAD_BEHIND_CACHE_TTL_MS) {
    return cached.value;
  }

  const inFlight = aheadBehindInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = gitAheadBehind(projectPath)
    .then((value) => {
      aheadBehindCache.set(key, { cachedAt: Date.now(), value });
      return value;
    })
    .finally(() => {
      aheadBehindInFlight.delete(key);
    });

  aheadBehindInFlight.set(key, promise);
  return promise;
}

/**
 * Setup IPC handlers
 */
function setupIPC(ipcMain) {
  const invalidateOnSuccess = (projectPath, result, options = {}) => {
    if (!result || !result.error) {
      invalidateRepoCaches(projectPath, options);
    }
    return result;
  };

  ipcMain.handle(IPC.LOAD_GIT_CHANGES, async (event, projectPath) => {
    return await loadChangesCached(projectPath);
  });

  ipcMain.handle(IPC.LOAD_GIT_DIFF, async (event, { projectPath, filePath, diffType }) => {
    return await loadDiff(projectPath, filePath, diffType);
  });

  ipcMain.handle(IPC.APPLY_GIT_HUNK, async (event, { projectPath, filePath, diffType, action, hunkPatch }) => {
    const result = await applyGitHunk(projectPath, filePath, diffType, action, hunkPatch);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.LOAD_GIT_CONFLICT, async (event, { projectPath, filePath }) => {
    return await loadGitConflict(projectPath, filePath);
  });

  ipcMain.handle(IPC.RESOLVE_GIT_CONFLICT, async (event, { projectPath, filePath, resolvedContent }) => {
    const result = await resolveGitConflict(projectPath, filePath, resolvedContent);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.LOAD_COMMIT_DIFF, async (event, { projectPath, commitHash }) => {
    return await loadCommitDiff(projectPath, commitHash);
  });

  ipcMain.handle(IPC.STAGE_GIT_FILE, async (event, { projectPath, filePath }) => {
    const result = await stageFile(projectPath, filePath);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.UNSTAGE_GIT_FILE, async (event, { projectPath, filePath }) => {
    const result = await unstageFile(projectPath, filePath);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.DISCARD_GIT_FILE, async (event, { projectPath, filePath, diffType }) => {
    const result = await discardFile(projectPath, filePath, diffType);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.DISCARD_ALL_UNSTAGED, async (event, projectPath) => {
    const result = await discardAllUnstaged(projectPath);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.STAGE_ALL_GIT, async (event, projectPath) => {
    const result = await stageAll(projectPath);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.UNSTAGE_ALL_GIT, async (event, projectPath) => {
    const result = await unstageAll(projectPath);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.UNDO_LAST_COMMIT, async (event, projectPath) => {
    const result = await gitCommitOps.undoLastCommit(projectPath);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: true, activity: true });
  });

  ipcMain.handle(IPC.REVERT_COMMIT, async (event, { projectPath, commitHash }) => {
    const result = await gitCommitOps.revertCommit(projectPath, commitHash);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: true, activity: true });
  });

  ipcMain.handle(IPC.STASH_CHANGES, async (event, { projectPath, filePath, message, includeUntracked }) => {
    const result = await gitStashOps.stashChanges(projectPath, filePath, message, includeUntracked === true);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.STASH_LIST, async (event, projectPath) => {
    return await gitStashOps.stashList(projectPath);
  });

  ipcMain.handle(IPC.STASH_APPLY, async (event, { projectPath, stashRef }) => {
    const result = await gitStashOps.stashApply(projectPath, stashRef);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.STASH_POP, async (event, { projectPath, stashRef }) => {
    const result = await gitStashOps.stashPop(projectPath, stashRef);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.STASH_DROP, async (event, { projectPath, stashRef }) => {
    const result = await gitStashOps.stashDrop(projectPath, stashRef);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: false });
  });

  ipcMain.handle(IPC.STASH_SHOW, async (event, { projectPath, stashRef }) => {
    return await gitStashOps.stashShow(projectPath, stashRef);
  });

  ipcMain.handle(IPC.GIT_COMMIT, async (event, { projectPath, message }) => {
    const result = await gitCommitOps.gitCommit(projectPath, message);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: true, activity: true });
  });

  ipcMain.handle(IPC.GIT_COMMIT_AMEND, async (event, { projectPath, message }) => {
    const result = await gitCommitOps.gitCommitAmend(projectPath, message);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: true, activity: true });
  });

  ipcMain.handle(IPC.GIT_PUSH, async (event, { projectPath, branch, setUpstream }) => {
    const result = await gitPush(projectPath, branch, setUpstream);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: true, activity: false });
  });

  ipcMain.handle(IPC.GIT_PULL, async (event, { projectPath, branch, noUpstream }) => {
    const result = await gitPull(projectPath, branch, noUpstream);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: true, activity: true });
  });

  ipcMain.handle(IPC.GIT_FETCH, async (event, { projectPath, prune }) => {
    const result = await gitFetch(projectPath, prune !== false);
    return invalidateOnSuccess(projectPath, result, { status: true, aheadBehind: true, activity: false });
  });

  ipcMain.handle(IPC.GIT_AHEAD_BEHIND, async (event, projectPath) => {
    return await gitAheadBehindCached(projectPath);
  });
}

module.exports = {
  init,
  loadChanges,
  loadDiff,
  loadCommitDiff,
  loadSyncCommits,
  loadCommitGraph,
  loadGitActivity,
  gitFetch,
  applyGitHunk,
  extractHunkPatches,
  loadGitConflict,
  resolveGitConflict,
  stageFile,
  unstageFile,
  discardFile,
  discardAllUnstaged,
  stageAll,
  unstageAll,
  // Re-exported from gitCommitOps
  undoLastCommit: gitCommitOps.undoLastCommit,
  revertCommit: gitCommitOps.revertCommit,
  gitCommit: gitCommitOps.gitCommit,
  gitCommitAmend: gitCommitOps.gitCommitAmend,
  // Re-exported from gitStashOps
  stashChanges: gitStashOps.stashChanges,
  stashList: gitStashOps.stashList,
  stashApply: gitStashOps.stashApply,
  stashPop: gitStashOps.stashPop,
  stashDrop: gitStashOps.stashDrop,
  stashShow: gitStashOps.stashShow,
  gitAheadBehind,
  setupIPC
};
