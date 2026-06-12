/**
 * Git operation handlers for the GitHub panel "Changes" tab.
 * Every operation follows the same flow: guard on the panel's shared
 * in-progress flag, optionally confirm, invoke an IPC channel, toast the
 * outcome, then force-reload changes.
 */

function createGitOperations({ ipcRenderer, IPC, showToast, loadChanges, getProjectPath, isBusy, setBusy }) {
  async function run({ confirmMessage = null, channel, buildPayload, successToast, failureToast, showResultError = false }) {
    if (isBusy()) return;
    if (confirmMessage && !confirm(confirmMessage)) return;

    setBusy(true);
    const projectPath = getProjectPath();

    try {
      const result = await ipcRenderer.invoke(channel, buildPayload(projectPath));
      if (result.error) {
        showToast(showResultError ? (result.error || 'Operation failed') : 'Operation failed', 'error');
        return;
      }
      const toast = typeof successToast === 'function' ? successToast(result) : { text: successToast };
      showToast(toast.text, toast.type || 'success');
      await loadChanges(true);
    } catch {
      showToast(failureToast, 'error');
    } finally {
      setBusy(false);
    }
  }

  function stashChanges(filePath) {
    if (isBusy()) return;
    const message = prompt('Stash message (optional):');
    if (message === null) return; // cancelled

    return run({
      channel: IPC.STASH_CHANGES,
      buildPayload: (projectPath) => ({ projectPath, filePath, message: message || undefined }),
      successToast: filePath ? 'File stashed' : 'Changes stashed',
      failureToast: filePath ? 'Failed to stash file' : 'Failed to stash changes'
    });
  }

  return {
    stageFile: (filePath) => run({
      channel: IPC.STAGE_GIT_FILE,
      buildPayload: (projectPath) => ({ projectPath, filePath }),
      successToast: 'File staged',
      failureToast: 'Failed to stage file'
    }),

    unstageFile: (filePath) => run({
      channel: IPC.UNSTAGE_GIT_FILE,
      buildPayload: (projectPath) => ({ projectPath, filePath }),
      successToast: 'File unstaged',
      failureToast: 'Failed to unstage file'
    }),

    discardFile: (filePath, diffType) => run({
      confirmMessage: `Are you sure you want to ${diffType === 'untracked' ? 'delete' : 'discard changes for'} "${filePath}"?\n\nThis cannot be undone.`,
      channel: IPC.DISCARD_GIT_FILE,
      buildPayload: (projectPath) => ({ projectPath, filePath, diffType }),
      successToast: 'Changes discarded',
      failureToast: 'Failed to discard changes'
    }),

    stashFile: (filePath) => stashChanges(filePath),

    stageAll: () => run({
      channel: IPC.STAGE_ALL_GIT,
      buildPayload: (projectPath) => projectPath,
      successToast: 'All files staged',
      failureToast: 'Failed to stage all'
    }),

    unstageAll: () => run({
      channel: IPC.UNSTAGE_ALL_GIT,
      buildPayload: (projectPath) => projectPath,
      successToast: 'All files unstaged',
      failureToast: 'Failed to unstage all'
    }),

    discardAllUnstaged: () => run({
      confirmMessage: 'Discard ALL unstaged changes?\n\nThis cannot be undone.',
      channel: IPC.DISCARD_ALL_UNSTAGED,
      buildPayload: (projectPath) => projectPath,
      successToast: 'All unstaged changes discarded',
      failureToast: 'Failed to discard changes'
    }),

    stashAll: () => stashChanges(undefined),

    undoLastCommit: () => run({
      confirmMessage: 'Undo last commit?\n\nChanges will be kept staged.',
      channel: IPC.UNDO_LAST_COMMIT,
      buildPayload: (projectPath) => projectPath,
      successToast: 'Commit undone, changes kept staged',
      failureToast: 'Failed to undo commit',
      showResultError: true
    }),

    revertCommit: (hash) => run({
      confirmMessage: `Revert commit ${hash.substring(0, 7)}?\n\nThis will create a new commit that undoes the changes.`,
      channel: IPC.REVERT_COMMIT,
      buildPayload: (projectPath) => ({ projectPath, commitHash: hash }),
      successToast: `Commit ${hash.substring(0, 7)} reverted`,
      failureToast: 'Failed to revert commit',
      showResultError: true
    }),

    stashApply: (stashRef) => run({
      channel: IPC.STASH_APPLY,
      buildPayload: (projectPath) => ({ projectPath, stashRef }),
      successToast: (result) => result.conflicts
        ? { text: 'Applied with conflicts - resolve manually', type: 'error' }
        : { text: 'Stash applied' },
      failureToast: 'Failed to apply stash'
    }),

    stashPop: (stashRef) => run({
      channel: IPC.STASH_POP,
      buildPayload: (projectPath) => ({ projectPath, stashRef }),
      successToast: (result) => result.conflicts
        ? { text: 'Popped with conflicts - stash kept', type: 'error' }
        : { text: 'Stash popped' },
      failureToast: 'Failed to pop stash'
    }),

    stashDrop: (stashRef) => run({
      confirmMessage: `Drop ${stashRef}?\n\nThis cannot be undone.`,
      channel: IPC.STASH_DROP,
      buildPayload: (projectPath) => ({ projectPath, stashRef }),
      successToast: 'Stash dropped',
      failureToast: 'Failed to drop stash'
    })
  };
}

module.exports = { createGitOperations };
