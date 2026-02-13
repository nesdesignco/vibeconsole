/**
 * Shared dropdown used in panel headers (Plugins, Source Control, Saved Prompts).
 */

function createPanelHeaderDropdown(rootElement, options = {}) {
  if (!rootElement) return null;

  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const triggerElement = rootElement.querySelector('.panel-header-dropdown-trigger');
  const labelElement = rootElement.querySelector('[data-dropdown-label]');
  const itemElements = Array.from(rootElement.querySelectorAll('[data-dropdown-item]'));

  if (!triggerElement || itemElements.length === 0) {
    return null;
  }

  let currentValue = null;

  function getItemByValue(value) {
    return itemElements.find((item) => item.dataset.value === value) || null;
  }

  function syncExpandedState() {
    triggerElement.setAttribute('aria-expanded', rootElement.classList.contains('open') ? 'true' : 'false');
  }

  function close() {
    rootElement.classList.remove('open');
    syncExpandedState();
  }

  function toggleOpen() {
    rootElement.classList.toggle('open');
    syncExpandedState();
  }

  function setValue(nextValue, controlOptions = {}) {
    const { emit = false } = controlOptions;
    const nextItem = getItemByValue(nextValue) || itemElements[0];
    if (!nextItem) return null;

    currentValue = nextItem.dataset.value;

    itemElements.forEach((item) => {
      item.classList.toggle('active', item === nextItem);
      item.setAttribute('aria-selected', item === nextItem ? 'true' : 'false');
    });

    if (labelElement) {
      labelElement.textContent = nextItem.textContent.trim();
    }

    if (emit && onChange) {
      onChange(currentValue);
    }

    return currentValue;
  }

  function handleRootClick(event) {
    const item = event.target.closest('[data-dropdown-item]');
    if (item) {
      event.preventDefault();
      event.stopPropagation();
      setValue(item.dataset.value, { emit: true });
      close();
      return;
    }

    if (event.target.closest('.panel-header-dropdown-trigger')) {
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    }
  }

  function handleDocumentClick(event) {
    if (!rootElement.contains(event.target)) {
      close();
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      close();
      return;
    }

    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    if (!rootElement.contains(event.target)) {
      return;
    }

    event.preventDefault();
    toggleOpen();
  }

  rootElement.addEventListener('click', handleRootClick);
  rootElement.addEventListener('keydown', handleKeydown);
  document.addEventListener('click', handleDocumentClick);

  const initiallyActive = itemElements.find((item) => item.classList.contains('active'));
  setValue(initiallyActive ? initiallyActive.dataset.value : itemElements[0].dataset.value);
  syncExpandedState();

  return {
    setValue(value) {
      return setValue(value, { emit: false });
    },
    getValue() {
      return currentValue;
    },
    destroy() {
      rootElement.removeEventListener('click', handleRootClick);
      rootElement.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('click', handleDocumentClick);
    },
    close
  };
}

module.exports = {
  createPanelHeaderDropdown
};
