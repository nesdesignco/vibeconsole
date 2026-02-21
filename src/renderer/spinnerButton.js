/**
 * Spinner Button Utility
 * Adds .spinning class + disabled state during async operations
 */

async function withSpinner(buttonElement, asyncFn) {
  if (!buttonElement) return asyncFn();

  try {
    buttonElement.classList.add('spinning');
    buttonElement.disabled = true;
    return await asyncFn();
  } finally {
    buttonElement.classList.remove('spinning');
    buttonElement.disabled = false;
  }
}

module.exports = { withSpinner };
