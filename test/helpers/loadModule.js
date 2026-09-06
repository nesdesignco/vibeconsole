const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Load production modules with explicit platform adapters, without launching Electron.
function loadModule(file, mocks = {}, globals = {}) {
  const filename = path.resolve(__dirname, '../..', file);
  const native = createRequire(filename);
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : native(name),
    __dirname: path.dirname(filename), __filename: filename,
    console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    ...globals
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports;
}

function createElements() {
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) {
      const classes = new Set();
      const listeners = new Map();
      elements.set(key, {
        style: {}, value: '', textContent: '', className: '', disabled: false,
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle() {} },
        addEventListener: (name, callback) => listeners.set(name, callback),
        setAttribute() {}, querySelector: element, focus() {}, listeners
      });
    }
    return elements.get(key);
  };
  return element;
}

module.exports = { loadModule, createElements };
