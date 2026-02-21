function bindDelegatedEvents(contentElement, handlers) {
  if (!contentElement || contentElement.__vibeGitDelegatedBound) return;

  contentElement.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const sectionActionBtn = target.closest('.git-section-action-btn');
    if (sectionActionBtn) {
      event.stopPropagation();
      await handlers.onSectionAction(sectionActionBtn.dataset.action);
      return;
    }

    const changeActionBtn = target.closest('.git-change-action-btn');
    if (changeActionBtn) {
      event.stopPropagation();
      await handlers.onChangeAction(
        changeActionBtn.classList,
        changeActionBtn.dataset.path,
        changeActionBtn.dataset.diffType
      );
      return;
    }

    const commitActionBtn = target.closest('.git-commit-action-btn');
    if (commitActionBtn) {
      event.stopPropagation();
      await handlers.onCommitAction(commitActionBtn.classList, commitActionBtn.dataset.hash);
      return;
    }

    const stashActionBtn = target.closest('.git-stash-action-btn');
    if (stashActionBtn) {
      event.stopPropagation();
      await handlers.onStashAction(stashActionBtn.classList, stashActionBtn.dataset.ref);
      return;
    }

    const sectionToggle = target.closest('[data-section-toggle]');
    if (sectionToggle) {
      const sectionId = sectionToggle.dataset.sectionToggle;
      if (sectionId) handlers.onToggleSection(sectionId);
      return;
    }

    const changeItem = target.closest('.git-change-item');
    if (changeItem) {
      const filePath = changeItem.dataset.path;
      const diffType = changeItem.dataset.diffType;
      if (!filePath || !diffType) return;
      if (diffType === 'conflict') {
        handlers.onOpenConflict(filePath);
      } else {
        handlers.onOpenFileDiff(filePath, diffType);
      }
      return;
    }

    const commitItem = target.closest('.git-commit-item');
    if (commitItem) {
      const hash = commitItem.dataset.hash;
      if (hash) handlers.onOpenCommitDiff(hash);
      return;
    }

    const stashItem = target.closest('.git-stash-item');
    if (stashItem) {
      const ref = stashItem.dataset.ref;
      if (ref) handlers.onOpenStashDiff(ref);
    }
  });

  contentElement.__vibeGitDelegatedBound = true;
}

module.exports = { bindDelegatedEvents };
