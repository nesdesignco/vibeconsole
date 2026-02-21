/**
 * Context Menu Utility
 * Shared context menu with builder pattern, viewport bounds, and AbortController cleanup
 */

function createContextMenu() {
  let activeMenu = null;
  let cleanupController = null;

  function close() {
    if (cleanupController) {
      cleanupController.abort();
      cleanupController = null;
    }
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
  }

  /**
   * Show a context menu at (x, y).
   * @param {number} x - clientX
   * @param {number} y - clientY
   * @param {(menu: {addItem: Function, addSeparator: Function}) => void} builderFn
   */
  function show(x, y, builderFn) {
    close();

    const menu = document.createElement('div');
    menu.className = 'file-tree-context-menu';
    menu.setAttribute('role', 'menu');

    const builder = {
      addItem(label, onClick, opts = {}) {
        const item = document.createElement('div');
        item.className = 'file-tree-context-menu-item' + (opts.danger ? ' danger' : '');
        item.textContent = label;
        item.tabIndex = 0;
        item.setAttribute('role', 'menuitem');

        const runAction = (event) => {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          close();
          Promise.resolve(onClick()).catch((err) => {
            console.error('Context menu action failed:', err);
          });
        };

        item.addEventListener('click', runAction);
        if (opts.keyboard !== false) {
          item.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            runAction(e);
          });
        }

        menu.appendChild(item);
      },

      addSeparator() {
        const sep = document.createElement('div');
        sep.className = 'file-tree-context-menu-separator';
        menu.appendChild(sep);
      }
    };

    builderFn(builder);

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.body.appendChild(menu);

    // Adjust if menu goes off screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }

    activeMenu = menu;
    cleanupController = new AbortController();
    const { signal } = cleanupController;

    document.addEventListener('pointerdown', (e) => {
      const target = e.target instanceof Node ? e.target : null;
      if (!target || !menu.contains(target)) {
        close();
      }
    }, { capture: true, signal });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }, { signal });

    window.addEventListener('blur', close, { signal });
  }

  return { show, close };
}

module.exports = { createContextMenu };
