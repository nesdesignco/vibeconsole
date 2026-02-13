/**
 * Git Branches Manager Module
 * Handles git branch and worktree operations
 */

const { execFile } = require('child_process');
const { IPC } = require('../shared/ipcChannels');

let mainWindow = null;

/**
 * Validate branch name to prevent git argument injection
 * Allows alphanumeric, dots, underscores, hyphens, and slashes
 * Rejects names starting with '-' (flag injection)
 */
function isValidBranchName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 255) return false;
  if (name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  if (name.includes('.lock') || name.endsWith('.') || name.endsWith('/')) return false;
  if (name.includes('.git/') || name.includes('.git\\') || name === '.git') return false;
  return /^[a-zA-Z0-9._/-]+$/.test(name);
}

/**
 * Initialize manager
 */
function init(window) {
  mainWindow = window;
}

/**
 * Execute git command safely using execFile (prevents argument injection)
 */
function execFileGit(args, projectPath) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: projectPath, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stderr });
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

/**
 * Check if working tree is clean
 */
async function isWorkingTreeClean(projectPath) {
  try {
    const { stdout } = await execFileGit(['status', '--porcelain'], projectPath);
    return { clean: stdout === '', changes: stdout.split('\n').filter(Boolean) };
  } catch (err) {
    return { clean: false, error: err.error };
  }
}

/**
 * Load all branches
 */
async function loadBranches(projectPath) {
  if (!projectPath) {
    return { error: 'No project selected', branches: [] };
  }

  try {
    // Check if it's a git repo
    await execFileGit(['rev-parse', '--is-inside-work-tree'], projectPath);

    // Get current branch
    const { stdout: currentBranch } = await execFileGit(['branch', '--show-current'], projectPath);

    // Get all branches with details (use null byte delimiter to avoid pipe in subjects)
    const { stdout: branchOutput } = await execFileGit(
      ['branch', '-a', '--format=%(refname:short)%00%(objectname:short)%00%(committerdate:relative)%00%(subject)'],
      projectPath
    );

    const branches = branchOutput.split('\n')
      .filter(line => line)
      .map(line => {
        const [name, commit, date, ...messageParts] = line.split('\0');
        const message = messageParts.join('');
        const isRemote = name.startsWith('origin/');
        return {
          name: name,
          commit: commit || '',
          date: date || '',
          message: message || '',
          isRemote,
          isCurrent: name === currentBranch
        };
      })
      // Filter out HEAD pointer
      .filter(b => !b.name.includes('HEAD'));

    return { error: null, currentBranch, branches };
  } catch (err) {
    return { error: err.error || 'Not a git repository', branches: [] };
  }
}

/**
 * Switch to a branch
 */
async function switchBranch(projectPath, branchName) {
  if (!projectPath || !branchName) {
    return { error: 'Missing parameters' };
  }
  if (!isValidBranchName(branchName)) {
    return { error: 'Invalid branch name' };
  }

  // Check for uncommitted changes
  const status = await isWorkingTreeClean(projectPath);
  if (!status.clean && !status.error) {
    return {
      error: 'uncommitted_changes',
      message: 'You have uncommitted changes',
      changes: status.changes
    };
  }

  try {
    // Handle remote branches - create local tracking branch
    let targetBranch = branchName;
    if (branchName.startsWith('origin/')) {
      targetBranch = branchName.replace('origin/', '');
    }

    await execFileGit(['checkout', targetBranch], projectPath);
    return { error: null, branch: targetBranch };
  } catch (err) {
    return { error: err.error || err.message };
  }
}

/**
 * Create a new branch
 */
async function createBranch(projectPath, branchName, checkout = true, baseBranch = null) {
  if (!projectPath || !branchName) {
    return { error: 'Missing parameters' };
  }
  if (!isValidBranchName(branchName)) {
    return { error: 'Invalid branch name' };
  }
  if (baseBranch && !isValidBranchName(baseBranch)) {
    return { error: 'Invalid base branch name' };
  }

  try {
    let args;
    if (checkout) {
      // Create and switch to new branch
      args = baseBranch
        ? ['checkout', '-b', branchName, baseBranch]
        : ['checkout', '-b', branchName];
    } else {
      // Just create branch without switching
      args = baseBranch
        ? ['branch', branchName, baseBranch]
        : ['branch', branchName];
    }
    await execFileGit(args, projectPath);
    return { error: null, branch: branchName };
  } catch (err) {
    return { error: err.error || err.message };
  }
}

/**
 * Delete a branch
 */
async function deleteBranch(projectPath, branchName, force = false) {
  if (!projectPath || !branchName) {
    return { error: 'Missing parameters' };
  }
  if (!isValidBranchName(branchName)) {
    return { error: 'Invalid branch name' };
  }

  try {
    const flag = force ? '-D' : '-d';
    await execFileGit(['branch', flag, branchName], projectPath);
    return { error: null, branch: branchName };
  } catch (err) {
    return { error: err.error || err.message };
  }
}

/**
 * Load worktrees
 */
async function loadWorktrees(projectPath) {
  if (!projectPath) {
    return { error: 'No project selected', worktrees: [] };
  }

  try {
    const { stdout } = await execFileGit(['worktree', 'list', '--porcelain'], projectPath);

    const worktrees = [];
    let current = {};

    stdout.split('\n').forEach(line => {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.substring(9) };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.substring(5);
      } else if (line.startsWith('branch ')) {
        current.branch = line.substring(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        current.bare = true;
      } else if (line === 'detached') {
        current.detached = true;
      }
    });

    if (current.path) worktrees.push(current);

    // Mark main worktree
    if (worktrees.length > 0) {
      worktrees[0].isMain = true;
    }

    return { error: null, worktrees };
  } catch (err) {
    return { error: err.error || err.message, worktrees: [] };
  }
}

/**
 * Add a worktree
 */
async function addWorktree(projectPath, worktreePath, branchName, createBranch = false) {
  if (!projectPath || !worktreePath || !branchName) {
    return { error: 'Missing parameters' };
  }
  if (!isValidBranchName(branchName)) {
    return { error: 'Invalid branch name' };
  }

  // Validate worktree path is within home directory to prevent arbitrary filesystem access
  const os = require('os');
  const path = require('path');
  const resolvedPath = path.resolve(worktreePath);
  const homeDir = os.homedir();
  if (!resolvedPath.startsWith(homeDir + path.sep) && resolvedPath !== homeDir) {
    return { error: 'Worktree path must be within home directory' };
  }

  try {
    const args = createBranch
      ? ['worktree', 'add', '-b', branchName, worktreePath]
      : ['worktree', 'add', worktreePath, branchName];
    await execFileGit(args, projectPath);
    return { error: null, path: worktreePath, branch: branchName };
  } catch (err) {
    return { error: err.error || err.message };
  }
}

/**
 * Remove a worktree
 */
async function removeWorktree(projectPath, worktreePath, force = false) {
  if (!projectPath || !worktreePath) {
    return { error: 'Missing parameters' };
  }

  try {
    const args = force
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath];
    await execFileGit(args, projectPath);
    return { error: null, path: worktreePath };
  } catch (err) {
    return { error: err.error || err.message };
  }
}

/**
 * Setup IPC handlers
 */
function setupIPC(ipcMain) {
  // Load branches
  ipcMain.handle(IPC.LOAD_GIT_BRANCHES, async (event, projectPath) => {
    return await loadBranches(projectPath);
  });

  // Switch branch
  ipcMain.handle(IPC.SWITCH_GIT_BRANCH, async (event, { projectPath, branchName }) => {
    return await switchBranch(projectPath, branchName);
  });

  // Create branch
  ipcMain.handle(IPC.CREATE_GIT_BRANCH, async (event, { projectPath, branchName, checkout, baseBranch }) => {
    return await createBranch(projectPath, branchName, checkout, baseBranch);
  });

  // Delete branch
  ipcMain.handle(IPC.DELETE_GIT_BRANCH, async (event, { projectPath, branchName, force }) => {
    return await deleteBranch(projectPath, branchName, force);
  });

  // Load worktrees
  ipcMain.handle(IPC.LOAD_GIT_WORKTREES, async (event, projectPath) => {
    return await loadWorktrees(projectPath);
  });

  // Add worktree
  ipcMain.handle(IPC.ADD_GIT_WORKTREE, async (event, { projectPath, worktreePath, branchName, createBranch }) => {
    return await addWorktree(projectPath, worktreePath, branchName, createBranch);
  });

  // Remove worktree
  ipcMain.handle(IPC.REMOVE_GIT_WORKTREE, async (event, { projectPath, worktreePath, force }) => {
    return await removeWorktree(projectPath, worktreePath, force);
  });

  // Toggle panel from menu
  ipcMain.on(IPC.TOGGLE_GIT_BRANCHES_PANEL, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.TOGGLE_GIT_BRANCHES_PANEL);
    }
  });
}

module.exports = {
  init,
  loadBranches,
  switchBranch,
  createBranch,
  deleteBranch,
  loadWorktrees,
  addWorktree,
  removeWorktree,
  isWorkingTreeClean,
  setupIPC
};
