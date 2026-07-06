const test = require('node:test');
const assert = require('node:assert/strict');

function escapeForHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function installDocumentStub() {
  global.document = {
    createElement() {
      let text = '';
      return {
        set textContent(value) {
          text = value == null ? '' : String(value);
        },
        get innerHTML() {
          return escapeForHtml(text);
        }
      };
    }
  };
}

function text(value) {
  return { nodeType: 3, textContent: value };
}

function el(tagName, attrs, children = []) {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes: children,
    getAttribute(name) {
      return attrs[name] || null;
    }
  };
}

function loadTestApi() {
  installDocumentStub();
  process.env.NODE_ENV = 'test';
  delete require.cache[require.resolve('../src/renderer/escapeHtml')];
  delete require.cache[require.resolve('../src/renderer/updaterModal')];
  return require('../src/renderer/updaterModal').__test;
}

test('updater release notes render GitHub HTML without exposing raw tags', () => {
  global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  global.DOMParser = class {
    parseFromString() {
      return {
        body: el('body', {}, [
          el('h2', {}, [text("What's Changed")]),
          el('ul', {}, [
            el('li', {}, [
              text('Bump actions/checkout in '),
              el('a', {
                href: 'https://github.com/nesdesignco/vibeconsole/pull/11',
                onclick: 'alert(1)'
              }, [text('#11')])
            ])
          ]),
          el('p', {}, [
            el('strong', {}, [text('Full Changelog')]),
            text(': '),
            el('a', { href: 'https://github.com/nesdesignco/vibeconsole/compare/v1.3.5...v1.3.6' }, [
              el('tt', {}, [text('v1.3.5...v1.3.6')])
            ])
          ]),
          el('script', {}, [text('alert(1)')]),
          el('a', { href: 'javascript:alert(1)' }, [text('bad link')])
        ])
      };
    }
  };

  const { renderReleaseNotesMarkup } = loadTestApi();
  const html = renderReleaseNotesMarkup('<h2>ignored by fake parser</h2>');

  assert.match(html, /What's Changed/);
  assert.match(html, /<ul><li>Bump actions\/checkout in /);
  assert.match(html, /class="updater-notes-link"/);
  assert.match(html, /https:\/\/github\.com\/nesdesignco\/vibeconsole\/pull\/11/);
  assert.match(html, /<code>v1\.3\.5\.\.\.v1\.3\.6<\/code>/);
  assert.match(html, /bad link/);
  assert.doesNotMatch(html, /<h2|<script|onclick|javascript:/i);
});

test('updater release notes fallback strips HTML when DOMParser is unavailable', () => {
  delete global.Node;
  delete global.DOMParser;
  const { renderReleaseNotesMarkup } = loadTestApi();

  const html = renderReleaseNotesMarkup(`
    <h2>What's Changed</h2>
    <ul><li>Bump actions/checkout in <a href="https://github.com/nesdesignco/vibeconsole/pull/8">#8</a></li></ul>
    <p><strong>Full Changelog</strong>: <a href="https://github.com/nesdesignco/vibeconsole/compare/v1.3.5...v1.3.6"><tt>v1.3.5...v1.3.6</tt></a></p>
  `);

  assert.match(html, /What's Changed/);
  assert.match(html, /Bump actions\/checkout/);
  assert.match(html, /Full Changelog/);
  assert.doesNotMatch(html, /<h2|<a|href=|class="issue-link"/i);
});

test('updater release notes keep existing markdown rendering', () => {
  delete global.Node;
  delete global.DOMParser;
  const { renderReleaseNotesMarkup } = loadTestApi();

  const html = renderReleaseNotesMarkup('## Changes\n- Added `Monaco`\n- **Safe** notes');

  assert.match(html, /updater-notes-heading-inline/);
  assert.match(html, /<code>Monaco<\/code>/);
  assert.match(html, /<strong>Safe<\/strong>/);
});
