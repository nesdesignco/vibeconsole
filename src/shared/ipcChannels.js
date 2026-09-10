/**
 * IPC Channel Constants
 * Single source of truth for all IPC channel names
 */

const IPC = {
  // Project
  SELECT_PROJECT_FOLDER: 'select-project-folder',
  CREATE_NEW_PROJECT: 'create-new-project',
  PROJECT_SELECTED: 'project-selected',
  GET_PROJECT_CONTEXT_STATUS: 'get-project-context-status',

  // File Tree
  LOAD_FILE_TREE: 'load-file-tree',
  FILE_TREE_DATA: 'file-tree-data',
  DELETE_FILE: 'delete-file',
  FILE_DELETED: 'file-deleted',
  CREATE_FILE: 'create-file',
  CREATE_FOLDER: 'create-folder',
  RENAME_FILE: 'rename-file',
  REVEAL_IN_FINDER: 'reveal-in-finder',
  START_FILE_TREE_WATCH: 'start-file-tree-watch',
  STOP_FILE_TREE_WATCH: 'stop-file-tree-watch',

  // History
  LOAD_PROMPT_HISTORY: 'load-prompt-history',
  PROMPT_HISTORY_DATA: 'prompt-history-data',
  TOGGLE_HISTORY_PANEL: 'toggle-history-panel',

  // Layout
  TOGGLE_SIDEBAR: 'toggle-sidebar',
  SAVE_APPEARANCE: 'save-appearance',
  APPEARANCE_CHANGED: 'appearance-changed',

  // Commands
  RUN_COMMAND: 'run-command',

  // Workspace
  LOAD_WORKSPACE: 'load-workspace',
  WORKSPACE_DATA: 'workspace-data',
  WORKSPACE_UPDATED: 'workspace-updated',
  ADD_PROJECT_TO_WORKSPACE: 'add-project-to-workspace',
  REMOVE_PROJECT_FROM_WORKSPACE: 'remove-project-from-workspace',

  // File Editor
  READ_FILE: 'read-file',
  FILE_CONTENT: 'file-content',
  READ_FILE_DATA_URL: 'read-file-data-url',
  FILE_DATA_URL: 'file-data-url',
  WRITE_FILE: 'write-file',
  FILE_SAVED: 'file-saved',
  OPEN_VIDEO: 'open-video',

  // Multi-Terminal
  TERMINAL_CREATE: 'terminal-create',
  TERMINAL_DESTROY: 'terminal-destroy',
  TERMINAL_DESTROYED: 'terminal-destroyed',
  TERMINAL_INPUT_ID: 'terminal-input-id',
  TERMINAL_OUTPUT_ID: 'terminal-output-id',
  TERMINAL_RESIZE_ID: 'terminal-resize-id',
  TERMINAL_AI_TOOL_DETECTED: 'terminal-ai-tool-detected',
  GET_AVAILABLE_SHELLS: 'get-available-shells',

  LOAD_SKILLS: 'load-skills',
  ADD_SKILL_REPOSITORY: 'add-skill-repository',
  REMOVE_SKILL_REPOSITORY: 'remove-skill-repository',
  INSTALL_SKILL: 'install-skill',
  TOGGLE_SKILL: 'toggle-skill',
  GET_SKILL_COMMAND: 'get-skill-command',
  CHECK_SKILL_UPDATE: 'check-skill-update',
  APPLY_SKILL_UPDATE: 'apply-skill-update',
  ROLLBACK_SKILL_UPDATE: 'rollback-skill-update',
  OPEN_SKILL_BACKUP: 'open-skill-backup',

  // AI Tool Usage (generic - per-terminal)
  LOAD_AI_USAGE: 'load-ai-usage',
  AI_USAGE_DATA: 'ai-usage-data',
  REFRESH_AI_USAGE: 'refresh-ai-usage',

  // Git Branches Panel
  LOAD_GIT_BRANCHES: 'load-git-branches',
  SWITCH_GIT_BRANCH: 'switch-git-branch',
  CREATE_GIT_BRANCH: 'create-git-branch',
  DELETE_GIT_BRANCH: 'delete-git-branch',
  LOAD_GIT_WORKTREES: 'load-git-worktrees',
  ADD_GIT_WORKTREE: 'add-git-worktree',
  REMOVE_GIT_WORKTREE: 'remove-git-worktree',

  // Git Changes
  LOAD_GIT_CHANGES: 'load-git-changes',
  LOAD_GIT_DIFF: 'load-git-diff',
  LOAD_GIT_IMAGE_DIFF: 'load-git-image-diff',
  LOAD_COMMIT_DIFF: 'load-commit-diff',
  APPLY_GIT_HUNK: 'apply-git-hunk',
  LOAD_GIT_CONFLICT: 'load-git-conflict',
  RESOLVE_GIT_CONFLICT: 'resolve-git-conflict',
  STAGE_GIT_FILE: 'stage-git-file',
  UNSTAGE_GIT_FILE: 'unstage-git-file',
  DISCARD_GIT_FILE: 'discard-git-file',
  DISCARD_ALL_UNSTAGED: 'discard-all-unstaged',
  STAGE_ALL_GIT: 'stage-all-git',
  UNSTAGE_ALL_GIT: 'unstage-all-git',
  UNDO_LAST_COMMIT: 'undo-last-commit',
  REVERT_COMMIT: 'revert-commit',
  STASH_CHANGES: 'stash-git-changes',
  STASH_LIST: 'stash-git-list',
  STASH_APPLY: 'stash-git-apply',
  STASH_POP: 'stash-git-pop',
  STASH_DROP: 'stash-git-drop',
  STASH_SHOW: 'stash-git-show',
  GIT_COMMIT: 'git-commit',
  GIT_COMMIT_AMEND: 'git-commit-amend',
  GIT_PUSH: 'git-push',
  GIT_PULL: 'git-pull',
  GIT_FETCH: 'git-fetch',
  GIT_AHEAD_BEHIND: 'git-ahead-behind',

  // Saved Prompts
  LOAD_SAVED_PROMPTS: 'load-saved-prompts',
  SAVED_PROMPTS_DATA: 'saved-prompts-data',
  ADD_SAVED_PROMPT: 'add-saved-prompt',
  UPDATE_SAVED_PROMPT: 'update-saved-prompt',
  DELETE_SAVED_PROMPT: 'delete-saved-prompt',
  SAVED_PROMPT_UPDATED: 'saved-prompt-updated',

  // AI Tool Settings
  GET_AI_TOOL_CONFIG: 'get-ai-tool-config',
  SET_AI_TOOL: 'set-ai-tool',
  AI_TOOL_CHANGED: 'ai-tool-changed',

  // Auto Update
  CHECK_FOR_UPDATES: 'check-for-updates',
  UPDATE_CHECKING: 'update-checking',
  UPDATE_AVAILABLE: 'update-available',
  UPDATE_NOT_AVAILABLE: 'update-not-available',
  DOWNLOAD_UPDATE: 'download-update',
  UPDATE_DOWNLOAD_PROGRESS: 'update-download-progress',
  UPDATE_DOWNLOADED: 'update-downloaded',
  UPDATE_ERROR: 'update-error',
  UPDATE_CANCEL: 'update-cancel',
  UPDATE_CANCELLED: 'update-cancelled',
  INSTALL_UPDATE: 'install-update',
  GET_UPDATE_STATE: 'get-update-state',
  OPEN_UPDATER_MODAL: 'open-updater-modal',

  // External URLs
  OPEN_EXTERNAL_URL: 'open-external-url',

  // Drag & Drop
  SAVE_DROPPED_FILE: 'save-dropped-file',
  DOWNLOAD_URL_TO_TEMP: 'download-url-to-temp'
};

module.exports = { IPC };
