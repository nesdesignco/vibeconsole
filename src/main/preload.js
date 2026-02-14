/**
 * Preload bridge for renderer.
 * Exposes a minimal, explicit API surface with contextIsolation enabled.
 */

const { contextBridge, ipcRenderer, clipboard } = require('electron');

// Keep this list in sync with src/shared/ipcChannels.js.
const allowedChannels = new Set([
  'select-project-folder',
  'create-new-project',
  'project-selected',
  'load-file-tree',
  'file-tree-data',
  'delete-file',
  'file-deleted',
  'create-file',
  'create-folder',
  'rename-file',
  'reveal-in-finder',
  'load-prompt-history',
  'prompt-history-data',
  'toggle-history-panel',
  'run-command',
  'load-workspace',
  'workspace-data',
  'workspace-updated',
  'add-project-to-workspace',
  'remove-project-from-workspace',
  'read-file',
  'file-content',
  'read-file-data-url',
  'file-data-url',
  'write-file',
  'file-saved',
  'terminal-create',
  'terminal-created',
  'terminal-destroy',
  'terminal-destroyed',
  'terminal-input-id',
  'terminal-output-id',
  'terminal-resize-id',
  'get-available-shells',
  'available-shells-data',
  'load-plugins',
  'toggle-plugin',
  'plugin-toggled',
  'toggle-plugins-panel',
  'refresh-plugins',
  'toggle-github-panel',
  'load-ai-usage',
  'ai-usage-data',
  'refresh-ai-usage',
  'load-git-branches',
  'switch-git-branch',
  'create-git-branch',
  'delete-git-branch',
  'load-git-worktrees',
  'add-git-worktree',
  'remove-git-worktree',
  'toggle-git-branches-panel',
  'load-git-changes',
  'load-git-diff',
  'load-commit-diff',
  'apply-git-hunk',
  'load-git-conflict',
  'resolve-git-conflict',
  'stage-git-file',
  'unstage-git-file',
  'discard-git-file',
  'discard-all-unstaged',
  'stage-all-git',
  'unstage-all-git',
  'undo-last-commit',
  'revert-commit',
  'stash-git-changes',
  'stash-git-list',
  'stash-git-apply',
  'stash-git-pop',
  'stash-git-drop',
  'stash-git-show',
  'generate-git-commit-message',
  'git-commit',
  'git-commit-amend',
  'git-push',
  'git-pull',
  'git-fetch',
  'git-ahead-behind',
  'load-saved-prompts',
  'saved-prompts-data',
  'add-saved-prompt',
  'update-saved-prompt',
  'delete-saved-prompt',
  'saved-prompt-updated',
  'toggle-saved-prompts-panel',
  'get-ai-tool-config',
  'set-ai-tool',
  'ai-tool-changed',
  'check-for-updates',
  'update-available',
  'download-update',
  'update-download-progress',
  'update-downloaded',
  'update-error',
  'install-update',
  'open-external-url'
]);

function isAllowedChannel(channel) {
  return typeof channel === 'string' && allowedChannels.has(channel);
}

contextBridge.exposeInMainWorld('vibe', {
  ipc: {
    send: (channel, ...args) => {
      if (!isAllowedChannel(channel)) return;
      ipcRenderer.send(channel, ...args);
    },
    invoke: (channel, ...args) => {
      if (!isAllowedChannel(channel)) {
        return Promise.reject(new Error('Blocked IPC channel'));
      }
      return ipcRenderer.invoke(channel, ...args);
    },
    on: (channel, listener) => {
      if (!isAllowedChannel(channel) || typeof listener !== 'function') return () => {};
      const wrapped = (_event, ...args) => listener(...args);
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    }
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text)
  }
});
