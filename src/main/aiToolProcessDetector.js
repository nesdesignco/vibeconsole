/**
 * AI Tool Process Detector Module
 * Determines which AI CLI is actually running inside each
 * PTY by walking the shell's process tree, and pushes per-terminal
 * detections to the renderer. This is the authoritative signal; the
 * renderer's keystroke heuristic only provides instant feedback.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { IPC } = require('../shared/ipcChannels');
const ptyManager = require('./ptyManager');
const { AI_TOOL_COMMAND_MAP } = require('../shared/aiToolDetection');

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
 * @returns {string|null}
 */
function commToTool(comm) {
  if (typeof comm !== 'string' || !comm) return null;

  const basename = comm.slice(comm.lastIndexOf('/') + 1).toLowerCase();
  if (basename === 'agent' && path.isAbsolute(comm)) {
    // Both installers provide this alias. Identify its actual target instead
    // of assigning every `agent` process to Cursor.
    try {
      const target = path.basename(fs.realpathSync(comm));
      if (target === 'cursor-agent') return 'cursor';
      if (/^grok-(?:macos|linux)-(?:aarch64|x86_64)$/.test(target) || target === 'grok') return 'grok';
    } catch { /* Missing or unreadable aliases carry no provider identity. */ }
    return null;
  }
  return Object.hasOwn(AI_TOOL_COMMAND_MAP, basename) ? AI_TOOL_COMMAND_MAP[basename] : null;
}

// ps flattens argv, including spaces inside executable/script paths. Recover
// an existing absolute file prefix before falling back to token parsing. Stop
// at the first file so paths in later prompt arguments cannot become scripts.
function takeProcessArgument(text) {
  const input = text.trimStart();
  if (path.isAbsolute(input)) {
    const boundaries = input.matchAll(/\s+|$/g);
    for (const boundary of boundaries) {
      // macOS paths are limited to 1024 bytes; keep failed probes bounded.
      if (Buffer.byteLength(input.slice(0, boundary.index)) > 1024) break;
      const candidate = input.slice(0, boundary.index);
      try {
        if (fs.statSync(candidate).isFile()) {
          return [candidate, input.slice(boundary.index).trimStart()];
        }
      } catch { /* A partial path can be absent until the next space. */ }
    }
  }
  const match = /^(?:"([^"]*)"|'([^']*)'|(\S+))\s*/.exec(input);
  return match ? [match[1] ?? match[2] ?? match[3], input.slice(match[0].length)] : ['', ''];
}

// Interpreter processes expose "node"/"python" as comm. Inspect only their
// entry script, never arbitrary prompt arguments or shell command strings.
function interpreterToTool(comm, args) {
  const runtime = (comm || '').split('/').pop().toLowerCase();
  if (!/^(node|nodejs|bun|python(?:\d+(?:\.\d+)*)?)$/.test(runtime) || !args) return null;
  let [, remaining] = takeProcessArgument(args);
  let [script, rest] = takeProcessArgument(remaining);
  while (/^(--no-warnings|--enable-source-maps|--experimental-[\w-]+|--inspect(?:-brk)?(?:=.*)?|-u|-B)$/.test(script)) {
    [script, rest] = takeProcessArgument(rest);
  }
  if (runtime.startsWith('python') && script === '-m') {
    return takeProcessArgument(rest)[0] === 'kimi_cli' ? 'kimi' : null;
  }
  if (script.startsWith('-')) return null;
  const direct = commToTool(script);
  if (direct) return direct;
  /** @type {Array<[RegExp, string]>} */
  const entries = [
    [/\/@google\/gemini-cli\/dist\/index\.js$/, 'gemini'],
    [/\/@qwen-code\/qwen-code\/dist\/index\.js$/, 'qwen'],
    [/\/@github\/copilot\/(?:npm-loader|index)\.js$/, 'copilot'],
    [/\/@moonshot-ai\/kimi-code\/dist\/main\.mjs$/, 'kimi'],
    [/\/@anthropic-ai\/claude-code\/cli\.js$/, 'claude'],
    [/\/@openai\/codex\/bin\/codex\.js$/, 'codex'],
    [/\/cursor-agent\/versions\/[^/]+\/index\.js$/, 'cursor']
  ];
  return entries.find(([pattern]) => pattern.test(script))?.[1] || null;
}

/**
 * BFS over the shell's descendants; the match nearest to the shell wins
 * (if claude is launched from inside codex, the tool the user started
 * from the shell is reported).
 * @returns {string|null}
 */
function detectToolForPid(shellPid, { commByPid, childrenByPpid, argsByPid = new Map() }) {
  const visited = new Set();
  let frontier = childrenByPpid.get(shellPid) || [];

  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next = [];
    for (const pid of frontier) {
      if (visited.has(pid)) continue;
      visited.add(pid);

      const tool = commToTool(commByPid.get(pid)) || interpreterToTool(commByPid.get(pid), argsByPid.get(pid));
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
      maps = { ...parsePsOutput(stdout), argsByPid: new Map() };
      try {
        const { stdout: args } = await execFileAsync(
          '/bin/ps', ['-axww', '-o', 'pid=,ppid=,args='],
          { encoding: 'utf8', timeout: 5000, maxBuffer: 5 * 1024 * 1024 }
        );
        maps.argsByPid = parsePsOutput(args).commByPid;
      } catch {
        // Keep native executable detection if argv inspection is unavailable.
      }
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
  interpreterToTool,
  detectToolForPid,
  nextDetectionState
};
