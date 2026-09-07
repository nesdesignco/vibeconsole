/**
 * Spinner Button Utility
 * Adds .spinning class + disabled state during async operations
 */

async function withSpinner(buttonElement, asyncFn) {
  if (!buttonElement) return asyncFn();
  if (buttonElement.disabled) return;
  const started = Date.now();
  const label = buttonElement.getAttribute('aria-label');

  try {
    buttonElement.classList.add('spinning');
    buttonElement.disabled = true;
    buttonElement.setAttribute('aria-busy', 'true');
    if (label) buttonElement.setAttribute('aria-label', `${label} — working`);
    return await asyncFn();
  } finally {
    // Fast local reads still need one visible turn of feedback.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 450 - (Date.now() - started))));
    buttonElement.classList.remove('spinning');
    buttonElement.disabled = false;
    buttonElement.removeAttribute('aria-busy');
    if (label) buttonElement.setAttribute('aria-label', label);
  }
}

module.exports = { withSpinner };
