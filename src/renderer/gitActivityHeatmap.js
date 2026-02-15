/**
 * Git Activity Heatmap Module
 * Pure rendering functions for commit activity heatmap visualization
 */

const { escapeHtml, escapeAttr } = require('./escapeHtml');

const HEATMAP_DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const HEATMAP_CELL_SIZE = 10;
const HEATMAP_GAP = 3;
const HEATMAP_LABEL_WIDTH = 24;
const HEATMAP_MIN_MONTH_GAP = 28;

function formatActivityDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function activityLevel(count) {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 7) return 3;
  return 4;
}

function buildActivityGrid(activity) {
  if (!Array.isArray(activity) || activity.length === 0) {
    return { cols: [], monthLabels: [], total: 0 };
  }

  const dayMap = new Map();
  let total = 0;
  for (const item of activity) {
    if (!item || typeof item.date !== 'string') continue;
    const count = Number(item.count) || 0;
    dayMap.set(item.date, count);
    total += count;
  }

  const start = new Date(`${activity[0].date}T12:00:00`);
  const end = new Date(`${activity[activity.length - 1].date}T12:00:00`);
  const mondayAligned = new Date(start);
  const dow = (mondayAligned.getDay() + 6) % 7; // Monday=0
  mondayAligned.setDate(mondayAligned.getDate() - dow);

  const cells = [];
  const cursor = new Date(mondayAligned);
  while (cursor <= end) {
    const date = formatActivityDate(cursor);
    const count = dayMap.get(date) || 0;
    cells.push({ date, count, level: activityLevel(count) });
    cursor.setDate(cursor.getDate() + 1);
  }

  while (cells.length % 7 !== 0) {
    const last = new Date(`${cells[cells.length - 1].date}T12:00:00`);
    last.setDate(last.getDate() + 1);
    cells.push({ date: formatActivityDate(last), count: 0, level: 0 });
  }

  const cols = [];
  for (let i = 0; i < cells.length; i += 7) {
    cols.push(cells.slice(i, i + 7));
  }

  const monthLabels = [];
  let lastMonth = -1;
  for (let i = 0; i < cols.length; i++) {
    const date = new Date(`${cols[i][0].date}T12:00:00`);
    const month = date.getMonth();
    if (month === lastMonth) continue;

    const x = HEATMAP_LABEL_WIDTH + i * (HEATMAP_CELL_SIZE + HEATMAP_GAP);
    if (monthLabels.length > 0) {
      const prev = monthLabels[monthLabels.length - 1];
      if ((x - prev.x) < HEATMAP_MIN_MONTH_GAP) {
        lastMonth = month;
        continue;
      }
    }

    monthLabels.push({
      text: date.toLocaleDateString('en-US', { month: 'short' }),
      x
    });
    lastMonth = month;
  }

  return { cols, monthLabels, total };
}

function renderActivityHeatmapSection(activity, totalHint = null, options = {}) {
  const grid = buildActivityGrid(activity);
  if (grid.cols.length === 0) return '';

  const gridWidth = HEATMAP_LABEL_WIDTH + grid.cols.length * (HEATMAP_CELL_SIZE + HEATMAP_GAP);
  const displayTotal = typeof totalHint === 'number' && totalHint > 0 ? totalHint : grid.total;
  const legend = ['None', 'Low', 'Mid', 'High', 'Max'];
  const pending = Boolean(options.pending);
  const sync = options.sync || {};
  const branch = typeof sync.branch === 'string' && sync.branch.trim() ? sync.branch : null;
  const hasUpstream = Boolean(sync.hasUpstream);
  const upstream = hasUpstream && typeof sync.upstream === 'string' && sync.upstream.trim() ? sync.upstream : null;
  const syncHeader = branch ? `
        <div class="sc-activity-sync">
          <span class="sc-activity-branch-name">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"/>
              <circle cx="18" cy="6" r="3"/>
              <circle cx="6" cy="18" r="3"/>
              <path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
            ${escapeHtml(branch)}
          </span>
          ${upstream
            ? `<span class="sc-upstream-name" title="Tracking ${escapeAttr(upstream)}">${escapeHtml(upstream)}</span>`
            : '<span class="sc-upstream-name no-upstream">No upstream</span>'}
        </div>
      ` : '';

  return `
    <div class="sc-activity-card">
      <div class="sc-activity-header">
        <div class="sc-activity-header-main">
          <h4 class="sc-activity-title">Activity</h4>
          <div class="sc-activity-meta">
            <span class="sc-activity-total">${displayTotal} commit${displayTotal === 1 ? '' : 's'} last year</span>
            ${pending ? '<span class="sc-activity-pending">Committing...</span>' : ''}
          </div>
        </div>
        ${syncHeader}
      </div>
      <div class="sc-activity-heatmap-scroll">
        <div class="sc-activity-heatmap" style="width:${gridWidth}px">
          <div class="sc-activity-months" style="margin-left:${HEATMAP_LABEL_WIDTH}px">
            ${grid.monthLabels.map(label => `
              <span class="sc-activity-month" style="left:${label.x - HEATMAP_LABEL_WIDTH}px">${escapeHtml(label.text)}</span>
            `).join('')}
          </div>
          <div
            class="sc-activity-grid"
            style="
              grid-template-columns:${HEATMAP_LABEL_WIDTH}px repeat(${grid.cols.length}, ${HEATMAP_CELL_SIZE}px);
              grid-template-rows:repeat(7, ${HEATMAP_CELL_SIZE}px);
              gap:${HEATMAP_GAP}px;
            "
          >
            ${Array.from({ length: 7 }).map((_, dayIndex) => `
              <div class="sc-activity-day-label">${HEATMAP_DAY_LABELS[dayIndex]}</div>
              ${grid.cols.map((col) => {
                const cell = col[dayIndex];
                const tip = `${cell.count} commit${cell.count === 1 ? '' : 's'} on ${new Date(`${cell.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
                return `<div class="sc-activity-cell lvl-${cell.level}" title="${escapeAttr(tip)}" aria-label="${escapeAttr(tip)}"></div>`;
              }).join('')}
            `).join('')}
          </div>
        </div>
      </div>
      <div class="sc-activity-legend">
        <span>Less</span>
        ${legend.map((label, i) => `<span class="sc-activity-cell lvl-${i}" title="${label}"></span>`).join('')}
        <span>More</span>
      </div>
    </div>
  `;
}

module.exports = {
  renderActivityHeatmapSection,
  buildActivityGrid
};
