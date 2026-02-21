const { escapeHtml, escapeAttr } = require('../escapeHtml');

function renderCommitItem(commit, options = { kind: 'outgoing' }) {
  const isOutgoing = options.kind !== 'incoming';
  const graphLane = typeof commit.graph === 'string' && commit.graph.length > 0 ? commit.graph : '*';
  const actions = isOutgoing ? `
      <div class="git-commit-actions">
        <button class="git-commit-action-btn revert" data-hash="${escapeAttr(commit.hash)}" title="Revert this commit"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10a5 5 0 0 1 0 10H14"/><polyline points="3 10 7 6"/><polyline points="3 10 7 14"/></svg></button>
      </div>
  ` : '';
  return `
    <div class="git-commit-item ${isOutgoing ? 'outgoing' : 'incoming'}" data-hash="${escapeAttr(commit.hash)}">
      <span class="git-commit-graph">${escapeHtml(graphLane)}</span>
      <span class="git-commit-hash">${escapeHtml(commit.shortHash)}</span>
      <span class="git-commit-message">${escapeHtml(commit.message)}</span>
      <span class="git-commit-meta">${escapeHtml(commit.author)} &middot; ${escapeHtml(commit.relativeTime)}</span>
      ${actions}
    </div>
  `;
}

function renderChangeItem(file, diffType, pathApi) {
  const fileName = pathApi.basename(file.path);
  const dirName = pathApi.dirname(file.path);
  const dirPath = dirName && dirName !== '.' ? `${dirName}${pathApi.sep}` : '';
  const statusClass = diffType === 'conflict'
    ? 'conflict'
    : file.status === 'M'
      ? 'modified'
      : file.status === 'A'
        ? 'added'
        : file.status === 'D'
          ? 'deleted'
          : file.status === 'R'
            ? 'renamed'
            : 'untracked';

  const discardBtn = diffType === 'conflict'
    ? ''
    : `<button class="git-change-action-btn discard" data-path="${escapeAttr(file.path)}" data-diff-type="${diffType}" title="Discard changes"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>`;

  const stashBtn = diffType === 'unstaged'
    ? `<button class="git-change-action-btn stash-file" data-path="${escapeAttr(file.path)}" title="Stash file"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg></button>`
    : '';

  const stageBtn = diffType === 'unstaged' || diffType === 'untracked' || diffType === 'conflict'
    ? `<button class="git-change-action-btn stage" data-path="${escapeAttr(file.path)}" title="Stage file">+</button>`
    : '';
  const unstageBtn = diffType === 'staged'
    ? `<button class="git-change-action-btn unstage" data-path="${escapeAttr(file.path)}" title="Unstage file">−</button>`
    : '';

  return `
    <div class="git-change-item" data-path="${escapeAttr(file.path)}" data-diff-type="${diffType}">
      <span class="git-change-status ${statusClass}">${escapeHtml(file.status)}</span>
      <div class="git-change-file">
        <span class="git-change-filename">${escapeHtml(fileName)}</span>
        ${dirPath ? `<span class="git-change-dir">${escapeHtml(dirPath)}</span>` : ''}
        ${file.oldPath ? `<span class="git-change-dir">renamed from ${escapeHtml(file.oldPath)}</span>` : ''}
      </div>
      <div class="git-change-actions">
        ${discardBtn}${stashBtn}${stageBtn}${unstageBtn}
      </div>
    </div>
  `;
}

module.exports = {
  renderCommitItem,
  renderChangeItem
};
