/**
 * Panel Visibility Utility
 * Manages show/hide/toggle with .visible class and optional callbacks
 */

/**
 * Create a panel visibility controller.
 * @param {HTMLElement} element - the panel element
 * @param {object} [options]
 * @param {() => void} [options.onShow] - called after panel becomes visible
 * @param {() => void} [options.onHide] - called after panel is hidden
 */
function createPanelVisibility(element, options = {}) {
  const { onShow, onHide } = options;

  function isVisible() {
    return Boolean(element && element.classList.contains('visible'));
  }

  function show() {
    if (!element || isVisible()) return;
    element.classList.add('visible');
    if (onShow) onShow();
  }

  function hide() {
    if (!element || !isVisible()) return;
    element.classList.remove('visible');
    if (onHide) onHide();
  }

  function toggle() {
    if (isVisible()) {
      hide();
    } else {
      show();
    }
  }

  return { show, hide, toggle, isVisible };
}

module.exports = { createPanelVisibility };
