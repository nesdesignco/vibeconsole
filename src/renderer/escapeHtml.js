/**
 * Shared HTML Escape Utilities
 * Use escapeHtml for text content, escapeAttr for attribute values
 */

const _div = document.createElement('div');

/**
 * Escape HTML for safe rendering in text content
 */
function escapeHtml(text) {
  _div.textContent = text;
  return _div.innerHTML;
}

/**
 * Escape string for use in HTML attributes (also escapes quotes)
 */
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { escapeHtml, escapeAttr };
