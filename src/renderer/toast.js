/**
 * Toast Notification Utility
 * Shared toast component for all panels
 */

function getToastIcon(type) {
  switch (type) {
    case 'success':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    case 'error':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    default:
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }
}

/**
 * Create a toast controller bound to a container element.
 * @param {HTMLElement} containerElement - element to append toasts to
 * @param {object} [options]
 * @param {number} [options.displayTime=2000] - ms before fade starts
 * @param {number} [options.fadeTime=300] - ms for fade-out transition
 * @param {boolean} [options.useIcons=true] - whether to show type icons
 */
function createToast(containerElement, options = {}) {
  const { displayTime = 2000, fadeTime = 300, useIcons = true } = options;
  let activeToast = null;

  function show(message, type = 'info') {
    if (activeToast) {
      activeToast.remove();
      activeToast = null;
    }

    const toast = document.createElement('div');
    toast.className = `vibe-toast vibe-toast-${type}`;

    if (useIcons) {
      // Build icon + message using DOM methods for safety.
      // Icon SVGs are static trusted strings (not user content).
      const iconSpan = document.createElement('span');
      iconSpan.className = 'toast-icon';
      iconSpan.innerHTML = getToastIcon(type); // trusted static SVG

      const msgSpan = document.createElement('span');
      msgSpan.className = 'toast-message';
      msgSpan.textContent = message; // user text safely escaped via textContent

      toast.appendChild(iconSpan);
      toast.appendChild(msgSpan);
    } else {
      toast.textContent = message;
    }

    if (containerElement) {
      containerElement.appendChild(toast);
    }
    activeToast = toast;

    requestAnimationFrame(() => toast.classList.add('visible'));

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => {
        if (toast === activeToast) {
          activeToast = null;
        }
        toast.remove();
      }, fadeTime);
    }, displayTime);
  }

  return { show };
}

module.exports = { createToast };
