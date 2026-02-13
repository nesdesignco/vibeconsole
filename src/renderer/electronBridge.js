/**
 * Renderer-side bridge that prefers preload APIs and falls back to Electron APIs
 * when nodeIntegration is available (development/backward compatibility).
 */

function getPreloadApi() {
  if (typeof window !== 'undefined' && window.vibe) {
    return window.vibe;
  }
  return null;
}

function fallbackRequire(moduleName) {
  const req = (typeof globalThis === 'object' && typeof globalThis['require'] === 'function')
    ? globalThis['require']
    : null;
  if (req) {
    try {
      return req(moduleName);
    } catch {
      return null;
    }
  }
  return null;
}

function getElectronFallback() {
  return fallbackRequire('electron') || {};
}

function detectSeparator(paths) {
  for (const value of paths) {
    if (typeof value === 'string' && value.includes('\\')) {
      return '\\';
    }
  }
  return '/';
}

function normalize(inputPath) {
  return (inputPath || '').replace(/\\/g, '/');
}

function parseSegments(inputPath) {
  const normalized = normalize(inputPath);
  let rest = normalized;
  let root = '';
  let absolute = false;

  const driveMatch = rest.match(/^([A-Za-z]:)(\/|$)/);
  if (driveMatch) {
    root = driveMatch[1];
    rest = rest.slice(root.length);
    if (rest.startsWith('/')) {
      absolute = true;
      rest = rest.slice(1);
    }
  } else if (rest.startsWith('/')) {
    absolute = true;
    rest = rest.slice(1);
  }

  const raw = rest.split('/').filter(Boolean);
  const segments = [];
  for (const segment of raw) {
    if (segment === '.') continue;
    if (segment === '..') {
      const canPop = segments.length > 0 && segments[segments.length - 1] !== '..';
      if (canPop) {
        segments.pop();
      } else if (!absolute) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }

  return { root, absolute, segments };
}

function formatPath(parts, separator) {
  const { root, absolute, segments } = parts;
  const rootPrefix = root
    ? (absolute ? `${root}${separator}` : root)
    : (absolute ? separator : '');
  const body = segments.join(separator);
  if (rootPrefix && body) return `${rootPrefix}${body}`;
  if (rootPrefix) return rootPrefix;
  return body;
}

function joinPath(...parts) {
  const separator = detectSeparator(parts);
  let base = '';
  for (const part of parts) {
    if (!part) continue;
    const parsed = parseSegments(part);
    if (parsed.absolute || parsed.root) {
      base = part;
    } else if (!base) {
      base = part;
    } else {
      base = `${normalize(base).replace(/\/+$/, '')}/${normalize(part).replace(/^\/+/, '')}`;
    }
  }
  if (!base) return '';
  return formatPath(parseSegments(base), separator);
}

function dirnamePath(inputPath) {
  const separator = detectSeparator([inputPath]);
  const parsed = parseSegments(inputPath);
  if (parsed.segments.length > 0) {
    parsed.segments.pop();
    const value = formatPath(parsed, separator);
    return value || (parsed.absolute ? separator : '.');
  }
  if (parsed.root) {
    return parsed.absolute ? `${parsed.root}${separator}` : parsed.root;
  }
  return parsed.absolute ? separator : '.';
}

function basenamePath(inputPath) {
  const normalized = normalize(inputPath).replace(/\/+$/, '');
  if (!normalized) return '';
  const idx = normalized.lastIndexOf('/');
  if (idx === -1) return normalized;
  return normalized.slice(idx + 1);
}

function relativePath(fromPath, toPath) {
  const separator = detectSeparator([fromPath, toPath]);
  const from = parseSegments(fromPath);
  const to = parseSegments(toPath);

  if ((from.root || '') !== (to.root || '') || from.absolute !== to.absolute) {
    return toPath || '';
  }

  let common = 0;
  const maxCommon = Math.min(from.segments.length, to.segments.length);
  while (common < maxCommon && from.segments[common] === to.segments[common]) {
    common++;
  }

  const up = new Array(from.segments.length - common).fill('..');
  const down = to.segments.slice(common);
  const rel = [...up, ...down].join(separator);
  return rel || '';
}

function getPathFallback() {
  return fallbackRequire('path') || {
    join: (...parts) => joinPath(...parts),
    dirname: (inputPath) => dirnamePath(inputPath),
    basename: (inputPath) => basenamePath(inputPath),
    relative: (fromPath, toPath) => relativePath(fromPath, toPath),
    sep: detectSeparator([])
  };
}

const preload = getPreloadApi();
const electronFallback = getElectronFallback();
const pathFallback = getPathFallback();

const fallbackIpc = electronFallback.ipcRenderer;
const ipcRenderer = preload?.ipc ? {
  send: (channel, ...args) => preload.ipc.send(channel, ...args),
  invoke: (channel, ...args) => preload.ipc.invoke(channel, ...args),
  on: (channel, listener) => preload.ipc.on(channel, (...args) => listener(undefined, ...args))
} : {
  send: (channel, ...args) => fallbackIpc?.send(channel, ...args),
  invoke: (channel, ...args) => fallbackIpc?.invoke(channel, ...args),
  on: (channel, listener) => {
    if (!fallbackIpc || typeof fallbackIpc.on !== 'function') return () => {};
    const wrapped = (_event, ...args) => listener(undefined, ...args);
    fallbackIpc.on(channel, wrapped);
    return () => {
      if (typeof fallbackIpc.removeListener === 'function') {
        fallbackIpc.removeListener(channel, wrapped);
      } else if (typeof fallbackIpc.off === 'function') {
        fallbackIpc.off(channel, wrapped);
      }
    };
  }
};

const clipboard = preload?.clipboard ? {
  readText: () => preload.clipboard.readText(),
  writeText: (text) => preload.clipboard.writeText(text)
} : electronFallback.clipboard;

const pathApi = preload?.path || pathFallback;

module.exports = {
  ipcRenderer,
  clipboard,
  pathApi
};
