/**
 * AI Tool Process Detector Module
 * Determines which AI CLI (claude/codex) is actually running inside each
 * PTY by walking the shell's process tree, and pushes per-terminal
 * detections to the renderer. This is the authoritative signal; the
 * renderer's keystroke heuristic only provides instant feedback.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { IPC } = require('../shared/ipcChannels');
const ptyManager = require('./ptyManager');

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 3000;
// A CLI can briefly vanish from a ps snapshot mid fork/exec (e.g. while it
// shells out), so a detection is only cleared after consecutive misses.
const NULL_DEBOUNCE_TICKS = 2;
const MAX_TREE_DEPTH = 32;

let mainWindow = null;
let pollTimer = null;
let tickInFlight = false;
const perTerminalState = new Map(); // terminalId -> { effective, nullStreak }

/**
 * Parse `ps -ax -o pid=,ppid=,comm=` output.
 * comm is taken as rest-of-line: on macOS it is a full executable path
 * that may contain spaces, so the whole line must not be split on whitespace.
 * @returns {{ commByPid: Map<number,string>, childrenByPpid: Map<number,number[]> }}
 */
function parsePsOutput(text) {
  const commByPid = new Map();
  const childrenByPpid = new Map();

  for (const line of String(text || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;

    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    commByPid.set(pid, match[3].trim());

    const siblings = childrenByPpid.get(ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      childrenByPpid.set(ppid, [pid]);
    }
  }

  return { commByPid, childrenByPpid };
}

/**
 * Map a process comm (name or full path) to an AI tool id.
 * Exact basename match only, so helpers like `codex-code-mode-host`
 * don't count (their parent `codex` is already in the tree).
 * @returns {'claude'|'codex'|null}
 */
function commToTool(comm) {
  if (typeof comm !== 'string' || !comm) return null;

  const basename = comm.slice(comm.lastIndexOf('/') + 1).toLowerCase();
  if (basename === 'claude') return 'claude';
  if (basename === 'codex') return 'codex';
  return null;
}

/**
 * BFS over the shell's descendants; the match nearest to the shell wins
 * (if claude is launched from inside codex, the tool the user started
 * from the shell is reported).
 * @returns {'claude'|'codex'|null}
 */
function detectToolForPid(shellPid, { commByPid, childrenByPpid }) {
  const visited = new Set();
  let frontier = childrenByPpid.get(shellPid) || [];

  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next = [];
    for (const pid of frontier) {
      if (visited.has(pid)) continue;
      visited.add(pid);

      const tool = commToTool(commByPid.get(pid));
      if (tool) return tool;

      const children = childrenByPpid.get(pid);
      if (children) next.push(...children);
    }
    frontier = next;
  }

  return null;
}

/**
 * Debounce state machine: a detected tool applies immediately, a
 * disappearance only after NULL_DEBOUNCE_TICKS consecutive misses.
 */
function nextDetectionState(prevState, rawDetected) {
  const prev = prevState || { effective: null, nullStreak: 0 };

  if (rawDetected) {
    return { effective: rawDetected, nullStreak: 0 };
  }

  const nullStreak = prev.nullStreak + 1;
  if (prev.effective !== null && nullStreak < NULL_DEBOUNCE_TICKS) {
    return { effective: prev.effective, nullStreak };
  }
  return { effective: null, nullStreak };
}

function pruneState(pids) {
  const alive = new Set(pids.map(entry => entry.terminalId));
  for (const terminalId of perTerminalState.keys()) {
    if (!alive.has(terminalId)) {
      perTerminalState.delete(terminalId);
    }
  }
}

async function pollOnce() {
  if (tickInFlight) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const pids = ptyManager.getTerminalPids();
  pruneState(pids);
  if (pids.length === 0) return;

  tickInFlight = true;
  try {
    let maps = null;
    try {
      const { stdout } = await execFileAsync(
        '/bin/ps',
        ['-ax', '-o', 'pid=,ppid=,comm='],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 5 * 1024 * 1024 }
      );
      maps = parsePsOutput(stdout);
    } catch {
      maps = null;
    }

    // Fallback when ps is unavailable: node-pty's foreground process name.
    // Weaker (only sees the TTY's foreground process), but keeps detection alive.
    const foregroundNames = maps ? null : new Map(
      ptyManager.getTerminalForegroundNames().map(({ terminalId, name }) => [terminalId, name])
    );

    const detections = {};
    for (const { terminalId, pid } of pids) {
      const raw = maps
        ? detectToolForPid(pid, maps)
        : commToTool(foregroundNames.get(terminalId) || '');
      const next = nextDetectionState(perTerminalState.get(terminalId), raw);
      perTerminalState.set(terminalId, next);
      detections[terminalId] = next.effective;
    }

    // Full snapshot every tick so the renderer converges even if the
    // keystroke heuristic set a tag main never observed.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.TERMINAL_AI_TOOL_DETECTED, { detections });
    }
  } finally {
    tickInFlight = false;
  }
}

/**
 * Initialize the module with window reference
 */
function init(window) {
  mainWindow = window;
  startPolling();
}

function startPolling(interval = POLL_INTERVAL_MS) {
  stopPolling();
  // No ps on Windows; the keystroke heuristic remains the only signal there.
  if (process.platform === 'win32') return;

  pollTimer = setInterval(() => {
    pollOnce();
  }, interval);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Cleanup on app quit
 */
function cleanup() {
  stopPolling();
  perTerminalState.clear();
  mainWindow = null;
}

module.exports = {
  init,
  cleanup,
  startPolling,
  stopPolling,
  pollOnce,
  parsePsOutput,
  commToTool,
  detectToolForPid,
  nextDetectionState
};
