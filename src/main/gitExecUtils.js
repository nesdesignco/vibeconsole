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
 * Validate branch name to prevent git argument injection
 * Allows alphanumeric, dots, underscores, hyphens, and slashes
 * Rejects names starting with '-' (flag injection)
 *
 * Branch names are not always user-typed: `git branch --show-current` echoes
 * whatever `.git/HEAD` contains, and a crafted HEAD can yield `--upload-pack=...`,
 * which git executes locally. Every branch name reaching git must pass through here.
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
 * Git flags that make git run an arbitrary command. VibeConsole never uses any of
 * them, so any occurrence means a caller-supplied value was interpreted as a flag
 * (e.g. a branch name read from a crafted `.git/HEAD`). Backstop only — call sites
 * are still responsible for validating refs before they reach git.
 */
const COMMAND_EXECUTION_FLAGS = ['--upload-pack', '--receive-pack', '--exec'];

function findCommandExecutionFlag(args) {
  if (!Array.isArray(args)) return null;
  return args.find(arg =>
    typeof arg === 'string' &&
    COMMAND_EXECUTION_FLAGS.some(flag => arg === flag || arg.startsWith(`${flag}=`))
  ) || null;
}

function rejectIfCommandExecutionFlag(args, reject) {
  const flag = findCommandExecutionFlag(args);
  if (!flag) return false;
  reject({ error: `Refused unsafe git argument: ${flag}`, stderr: '' });
  return true;
}

/**
 * Execute git command safely using execFile (prevents argument injection)
 */
function execFileGit(args, projectPath, maxBuffer = 1024 * 1024, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (rejectIfCommandExecutionFlag(args, reject)) return;
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
    if (rejectIfCommandExecutionFlag(args, reject)) return;
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
 * Execute git command capturing stdout as a raw Buffer (for binary content like `git show :file`).
 */
function execFileGitBuffer(args, projectPath, maxBufferBytes = 20 * 1024 * 1024, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (rejectIfCommandExecutionFlag(args, reject)) return;
    const env = buildExecEnv();
    const gitCmd = resolveCommandPath('git', env.PATH) || 'git';
    const child = spawn(gitCmd, args, { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'], env });
    const stdoutChunks = [];
    let stdoutSize = 0;
    let stderr = '';
    let finished = false;
    let aborted = false;
    const timer = setTimeout(() => {
      if (!finished) {
        aborted = true;
        child.kill('SIGTERM');
      }
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxBufferBytes) {
        aborted = true;
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject({ error: err.message, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finished = true;
      if (aborted) {
        reject({ error: stdoutSize > maxBufferBytes ? 'Output too large' : 'Command timed out', stderr });
        return;
      }
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr: stderr.trim() });
      } else {
        reject({ error: `git exited with code ${code}`, stderr: stderr.trim() });
      }
    });
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
 * Parse `git status --porcelain -z` output.
 *
 * The -z form is required, not a nicety: without it git C-quotes any path
 * containing non-ASCII, quotes or backslashes (café.txt becomes
 * "caf\303\251.txt"), and that mangled string is then rejected by every
 * subsequent `git add`/`diff`/`checkout` on the file. -z also removes the
 * " -> " rename ambiguity, since the old path arrives as its own NUL-terminated
 * record instead of being embedded in the same field.
 *
 * Record shape: `XY <path>` and, for renames/copies, a following `<oldPath>`.
 * X = staged status, Y = unstaged status.
 *
 * @param {string} stdout raw NUL-delimited output
 * @returns {Array<{x: string, y: string, path: string, oldPath: string|null}>}
 */
function parseStatusRecords(stdout) {
  const records = [];
  if (!stdout) return records;

  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;

    const x = entry[0];
    const y = entry[1];
    const filePath = entry.substring(3);

    // In -z mode the field order is reversed and the arrow dropped: the new
    // path sits in this record and the old path is the next one.
    let oldPath = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const next = parts[i + 1];
      if (next) {
        oldPath = next;
        i++;
      }
    }

    records.push({ x, y, path: filePath, oldPath });
  }

  return records;
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
  isValidBranchName,
  execFileGit,
  execFileGitBuffer,
  formatGitError,
  execGitWithStdin,
  execFileCmd,
  parseStatusRecords,
  isUnmergedStatus,
  parseCommitList,
  parseHunkHeaderLine,
  extractHunkPatches,
  formatLocalDate
};
