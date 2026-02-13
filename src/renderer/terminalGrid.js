/**
 * Terminal Grid Module
 * Handles grid layout for multiple terminals
 */

const GRID_LAYOUTS = {
  '1x2': { rows: 1, cols: 2 },
  '1x3': { rows: 1, cols: 3 },
  '1x4': { rows: 1, cols: 4 },
  '2x1': { rows: 2, cols: 1 },
  '2x2': { rows: 2, cols: 2 },
  '3x1': { rows: 3, cols: 1 },
  '3x2': { rows: 3, cols: 2 },
  '3x3': { rows: 3, cols: 3 }
};

class TerminalGrid {
  constructor(container, manager) {
    this.container = container;
    this.manager = manager;
    this.cellSizes = new Map(); // Store custom cell sizes
    this._currentRows = 1;
    this._currentCols = 1;
  }

  /**
   * Render grid with terminals
   */
  render(terminals, layout) {
    const config = GRID_LAYOUTS[layout] || GRID_LAYOUTS['2x2'];
    const maxCells = config.rows * config.cols;
    const terminalsToShow = terminals.slice(0, maxCells);
    const cols = config.cols;
    const rows = config.rows;
    this._currentCols = cols;
    this._currentRows = rows;

    // Clear container
    this.container.innerHTML = '';
    this.container.className = 'terminal-grid';

    // Set grid template
    this.container.style.display = 'grid';
    this.container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    this.container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    this.container.style.gap = '2px';
    this.container.style.height = '100%';
    this.container.style.backgroundColor = 'var(--grid-gap-bg)';

    // Create cells (terminals first, then placeholders for empty panes)
    for (let index = 0; index < maxCells; index += 1) {
      const terminal = terminalsToShow[index];
      if (terminal) {
        const cell = this._createCell(terminal, index, maxCells);
        this.container.appendChild(cell);

        // Mount terminal in cell content
        const contentArea = cell.querySelector('.grid-cell-content');
        this.manager.mountTerminal(terminal.id, contentArea);
      } else {
        this.container.appendChild(this._createEmptyCell(index));
      }
    }
  }

  /**
   * Create a grid cell
   */
  _createCell(terminal, index, totalCells) {
    const cell = document.createElement('div');
    cell.className = `grid-cell ${terminal.isActive ? 'active' : ''}`;
    cell.dataset.terminalId = terminal.id;
    cell.dataset.index = index;

    cell.innerHTML = `
      <div class="grid-cell-header">
        <span class="grid-cell-name">${this._escapeHtml(terminal.customName || terminal.name)}</span>
        <div class="grid-cell-actions">
          <button class="btn btn-grid-focus" data-size="icon-sm" data-variant="ghost" title="Focus terminal" aria-label="Focus terminal">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
          </button>
          <button class="btn btn-close btn-grid-close" data-size="icon-sm" data-variant="ghost" title="Close" aria-label="Close terminal">✕</button>
        </div>
      </div>
      <div class="grid-cell-content"></div>
      <div class="grid-resizer grid-resizer-right"></div>
      <div class="grid-resizer grid-resizer-bottom"></div>
    `;

    const col = index % this._currentCols;
    const row = Math.floor(index / this._currentCols);
    const hasRightSibling = col < this._currentCols - 1 && index + 1 < totalCells;
    const hasBottomSibling = row < this._currentRows - 1 && index + this._currentCols < totalCells;

    if (!hasRightSibling) {
      cell.querySelector('.grid-resizer-right')?.classList.add('disabled');
    }
    if (!hasBottomSibling) {
      cell.querySelector('.grid-resizer-bottom')?.classList.add('disabled');
    }

    this._setupCellEvents(cell, terminal.id);
    return cell;
  }

  /**
   * Create an empty placeholder cell for unused grid panes
   */
  _createEmptyCell(index) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell grid-cell-empty';
    cell.dataset.index = index;
    cell.innerHTML = `
      <div class="grid-cell-empty-content">
        <span class="grid-cell-empty-label">Empty pane</span>
        <button class="btn-grid-new" title="Create terminal">+ New Terminal</button>
      </div>
    `;

    const createBtn = cell.querySelector('.btn-grid-new');
    createBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.manager.createTerminal({ projectPath: this.manager.getCurrentProject() })
        .then((terminalId) => {
          if (terminalId) {
            this.manager.setActiveTerminal(terminalId);
          }
        })
        .catch((err) => {
          console.error('Failed to create terminal from grid pane:', err);
        });
    });

    return cell;
  }

  /**
   * Setup cell event handlers
   */
  _setupCellEvents(cell, terminalId) {
    // Click to focus
    cell.addEventListener('click', (e) => {
      if (!e.target.closest('.grid-cell-actions')) {
        this.manager.setActiveTerminal(terminalId);
        this._updateActiveCell(terminalId);
      }
    });

    // Focus button
    cell.querySelector('.btn-grid-focus').addEventListener('click', (e) => {
      e.stopPropagation();
      this.manager.setActiveTerminal(terminalId);
      this.manager.setViewMode('tabs'); // Switch to tabs to show focused terminal
    });

    // Close button
    cell.querySelector('.btn-grid-close').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Close this terminal?')) return;
      this.manager.closeTerminal(terminalId);
    });

    // Setup resizers
    this._setupResizer(cell, 'right');
    this._setupResizer(cell, 'bottom');
  }

  /**
   * Update active cell styling
   */
  _updateActiveCell(activeId) {
    const cells = this.container.querySelectorAll('.grid-cell');
    cells.forEach(cell => {
      cell.classList.toggle('active', cell.dataset.terminalId === activeId);
    });
  }

  /**
   * Setup resizer for a cell
   */
  _setupResizer(cell, direction) {
    const resizer = cell.querySelector(`.grid-resizer-${direction}`);
    if (!resizer) return;

    let startPos;
    let startSize;
    let siblingCell;
    let siblingStartSize;

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();

      const isHorizontal = direction === 'right';
      startPos = isHorizontal ? e.clientX : e.clientY;
      startSize = isHorizontal ? cell.offsetWidth : cell.offsetHeight;

      const cells = Array.from(this.container.querySelectorAll('.grid-cell'));
      const index = cells.indexOf(cell);
      const cols = this._currentCols;
      const col = index % cols;

      siblingCell = isHorizontal
        ? (col < cols - 1 ? cells[index + 1] : null)
        : cells[index + cols];

      // No adjacent cell in this direction, so resizing here is invalid.
      if (!siblingCell) return;

      siblingStartSize = isHorizontal ? siblingCell.offsetWidth : siblingCell.offsetHeight;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
      resizer.classList.add('active');
    });

    const onMouseMove = (e) => {
      try {
        const isHorizontal = direction === 'right';
        const currentPos = isHorizontal ? e.clientX : e.clientY;
        const delta = currentPos - startPos;

        // Apply constraints
        const minSize = 150;
        const newSize = Math.max(minSize, startSize + delta);

        const siblingNewSize = Math.max(minSize, siblingStartSize - delta);
        if (siblingNewSize < minSize) return;

        // Apply size to CSS grid template
        const cells = Array.from(this.container.querySelectorAll('.grid-cell'));
        const cellIndex = cells.indexOf(cell);
        const prop = isHorizontal ? 'gridTemplateColumns' : 'gridTemplateRows';
        const count = isHorizontal ? this._currentCols : this._currentRows;
        const colOrRow = isHorizontal ? cellIndex % count : Math.floor(cellIndex / count);

        // Build new template sizes array
        const sizes = Array(count).fill(null).map(() => `1fr`);
        // Replace the resized track and its sibling with pixel values
        sizes[colOrRow] = `${newSize}px`;
        if (colOrRow + 1 < count) {
          sizes[colOrRow + 1] = `${siblingNewSize}px`;
        }
        this.container.style[prop] = sizes.join(' ');

        // Fit terminals after resize
        this.manager.fitAll();
      } catch (err) {
        console.error('Grid resize error:', err);
        onMouseUp();
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      resizer.classList.remove('active');
    };
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}

module.exports = { TerminalGrid, GRID_LAYOUTS };
