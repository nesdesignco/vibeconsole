#!/usr/bin/env node

const path = require('path');
const esbuild = require('esbuild');

const rootDir = path.join(__dirname, '..');

const workers = [
  {
    entry: 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
    outfile: 'dist/monaco-editor.worker.js'
  },
  {
    entry: 'node_modules/monaco-editor/esm/vs/language/json/json.worker.js',
    outfile: 'dist/monaco-json.worker.js'
  },
  {
    entry: 'node_modules/monaco-editor/esm/vs/language/css/css.worker.js',
    outfile: 'dist/monaco-css.worker.js'
  },
  {
    entry: 'node_modules/monaco-editor/esm/vs/language/html/html.worker.js',
    outfile: 'dist/monaco-html.worker.js'
  },
  {
    entry: 'node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js',
    outfile: 'dist/monaco-ts.worker.js'
  }
];

async function buildWorker({ entry, outfile }) {
  await esbuild.build({
    entryPoints: [path.join(rootDir, entry)],
    outfile: path.join(rootDir, outfile),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: true,
    logLevel: 'silent'
  });
}

Promise.all(workers.map(buildWorker)).catch((err) => {
  console.error(err);
  process.exit(1);
});
