/**
 * Shared Lucide icon renderer for static app markup.
 */

const {
  Command,
  List,
  Map,
  Maximize2,
  Minimize2,
  Redo2,
  Replace,
  Save,
  Search,
  Undo2,
  WandSparkles,
  WrapText,
  createIcons
} = require('lucide/dist/cjs/lucide');

const EDITOR_ICONS = {
  Command,
  List,
  Map,
  Maximize2,
  Minimize2,
  Redo2,
  Replace,
  Save,
  Search,
  Undo2,
  WandSparkles,
  WrapText
};

/**
 * @param {Document|Element|DocumentFragment} [root]
 */
function renderEditorIcons(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  createIcons({
    root,
    icons: EDITOR_ICONS,
    attrs: {
      'stroke-width': 2
    }
  });
}

module.exports = {
  renderEditorIcons
};
