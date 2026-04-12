/**
 * Panel Coordinator
 * Keeps side panels mutually exclusive without coupling panel modules together.
 */

const panels = new Map();

function registerPanel(id, controller) {
  if (!id || !controller) return;
  panels.set(id, controller);
}

function getPanel(id) {
  return panels.get(id);
}

function hideOtherPanels(activeId) {
  panels.forEach((panel, panelId) => {
    if (panelId !== activeId && panel.isVisible()) {
      panel.hide();
    }
  });
}

function showPanel(id) {
  const panel = getPanel(id);
  if (!panel) return false;

  if (panel.isVisible()) return true;

  hideOtherPanels(id);
  panel.show();
  return panel.isVisible();
}

function hidePanel(id) {
  const panel = getPanel(id);
  if (!panel) return false;

  if (!panel.isVisible()) return false;
  panel.hide();
  return false;
}

function togglePanel(id) {
  const panel = getPanel(id);
  if (!panel) return false;

  return panel.isVisible() ? hidePanel(id) : showPanel(id);
}

module.exports = {
  registerPanel,
  showPanel,
  hidePanel,
  togglePanel
};
