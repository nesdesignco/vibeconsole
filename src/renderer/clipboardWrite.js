/**
 * Clipboard Write Utility
 * Electron clipboard → navigator.clipboard → textarea/execCommand fallback
 */

const { clipboard } = require('./electronBridge');

async function writeClipboardText(text) {
  const value = String(text ?? '');

  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await Promise.resolve(clipboard.writeText(value));
      return true;
    } catch (err) {
      console.warn('Clipboard write failed via Electron API:', err?.message || err);
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (err) {
      console.warn('Clipboard write failed via Navigator API:', err?.message || err);
    }
  }

  // Last-resort fallback for restricted environments.
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  try {
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    if (success) return true;
    console.warn('Clipboard write failed via execCommand fallback.');
  } catch (err) {
    console.warn('Clipboard write threw via execCommand fallback:', err?.message || err);
  } finally {
    if (textarea.parentNode) {
      textarea.parentNode.removeChild(textarea);
    }
  }

  return false;
}

module.exports = { writeClipboardText };
