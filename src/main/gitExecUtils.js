/**
 * Git Execution Utilities
 * Stateless execution and parsing helpers shared across git managers.
 */

const { execFile, spawn } = require('child_process');
const { buildExecEnv, resolveCommandPath } = require('../shared/pathUtils');

/**
 * Validate stash ref format (e.g. stash@{0})
 */
function isValidStashRef(ref) {
  return /^stash@\{\d+\}$/.test(ref);
}

/**
 * Execute git command safely using execFile (prevents argument injection)
 */
function execFileGit(args, projectPath, maxBuffer = 1024 * 1024, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const env = buildExecEnv();
    const gitCmd = resolveCommandPath('git', env.PATH) || 'git';
    execFile(gitCmd, args, { cwd: projectPath, timeout, maxBuffer, env }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stderr });
      } else {
        // Keep leading whitespace intact; some porcelain outputs rely on it.
        const safeStdout = (stdout || '').replace(/\s+$/, '');
        const safeStderr = (stderr || '').replace(/\s+$/, '');
        resolve({ stdout: safeStdout, stderr: safeStderr });
      }
    });
  });
}

function formatGitError(err, fallback) {
  const rawStderr = String(err && err.stderr ? err.stderr : '').trim();
  const rawError = String(err && err.error ? err.error : (err && err.message ? err.message : '')).trim();
  const raw = rawStderr || rawError;
  if (!raw) return fallback;

  const lines = raw.split('\n').map(l => String(l || '').trim()).filter(Boolean);
  const preferred = lines.find(l => /^fatal: /i.test(l) || /^error: /i.test(l) || /^CONFLICT/i.test(l)) || lines[0];
  const cleaned = preferred
    .replace(/^fatal:\s*/i, '')
    .replace(/^error:\s*/i, '')
    .replace(/^hint:\s*/i, '')
    .trim();

  // Keep toasts readable; detailed instructions usually follow on later lines.
  if (cleaned.length > 200) return `${cleaned.slice(0, 197)}...`;
  return cleaned || fallback;
}

/**
 * Execute git with stdin payload (used for hunk-level patch operations).
 */
function execGitWithStdin(args, input, projectPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const env = buildExecEnv();
    const gitCmd = resolveCommandPath('git', env.PATH) || 'git';
    const child = spawn(gitCmd, args, { cwd: projectPath, stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject({ error: err.message, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finished = true;
      if (code === 0) {
        resolve({
          stdout: (stdout || '').replace(/\s+$/, ''),
          stderr: (stderr || '').replace(/\s+$/, '')
        });
      } else {
        reject({ error: `git exited with code ${code}`, stderr: stderr.trim() || stdout.trim() });
      }
    });

    child.stdin.write(input || '');
    child.stdin.end();
  });
}

/**
 * Execute a non-git command safely using execFile
 */
function execFileCmd(cmd, args, projectPath, maxBuffer = 1024 * 1024, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const env = buildExecEnv();
    const resolvedCmd = resolveCommandPath(cmd, env.PATH);
    if (!resolvedCmd) {
      reject({ error: `Command not found: ${cmd}`, stderr: '' });
      return;
    }
    execFile(resolvedCmd, args, { cwd: projectPath, timeout, maxBuffer, env }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stderr });
      } else {
        resolve({
          stdout: (stdout || '').replace(/\s+$/, ''),
          stderr: (stderr || '').replace(/\s+$/, '')
        });
      }
    });
  });
}

/**
 * Parse git status --porcelain output
 * Format: XY PATH or XY OLDPATH -> PATH (for renames)
 * X = staged status, Y = unstaged status
 */
function parseStatusLine(line) {
  if (!line || line.length < 4) return null;

  const x = line[0]; // staged status
  const y = line[1]; // unstaged status
  const rest = line.substring(3);

  // Handle renames: "R  old -> new"
  let filePath = rest;
  let oldPath = null;
  const arrowIdx = rest.indexOf(' -> ');
  if (arrowIdx !== -1) {
    oldPath = rest.substring(0, arrowIdx);
    filePath = rest.substring(arrowIdx + 4);
  }

  return { x, y, path: filePath, oldPath };
}

/**
 * True for unmerged/conflict states from git status XY codes.
 * See git status short format: DD, AU, UD, UA, DU, AA, UU.
 */
function isUnmergedStatus(x, y) {
  const pair = `${x}${y}`;
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(pair);
}

/**
 * Parse commit list from a null-delimited git log format.
 */
function parseCommitList(stdout) {
  const commits = [];
  if (!stdout) return commits;
  stdout.split('\n').filter(Boolean).forEach(line => {
    const parts = line.split('\0');
    if (parts.length >= 5) {
      commits.push({
        hash: parts[0],
        shortHash: parts[1],
        message: parts[2],
        author: parts[3],
        relativeTime: parts[4]
      });
    }
  });
  return commits;
}

/**
 * Parse hunk header line for labels.
 */
function parseHunkHeaderLine(line) {
  const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: parseInt(match[2] || '1', 10),
    newStart: parseInt(match[3], 10),
    newCount: parseInt(match[4] || '1', 10)
  };
}

/**
 * Extract standalone hunk patches from a unified diff.
 */
function extractHunkPatches(diffText) {
  const lines = String(diffText || '').split('\n');
  const prefix = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) {
    if (lines[i] !== '') prefix.push(lines[i]);
    i++;
  }

  const hunks = [];
  while (i < lines.length) {
    if (!lines[i].startsWith('@@')) {
      i++;
      continue;
    }

    const header = lines[i];
    const body = [header];
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      if (lines[i] !== '') body.push(lines[i]);
      i++;
    }

    hunks.push({
      header,
      meta: parseHunkHeaderLine(header),
      patch: `${[...prefix, ...body].join('\n')}\n`
    });
  }

  return hunks;
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  isValidStashRef,
  execFileGit,
  formatGitError,
  execGitWithStdin,
  execFileCmd,
  parseStatusLine,
  isUnmergedStatus,
  parseCommitList,
  parseHunkHeaderLine,
  extractHunkPatches,
  formatLocalDate
};
