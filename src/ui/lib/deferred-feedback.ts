/**
 * Schedule UI feedback after modal close so inert/focus cleanup runs first.
 * Used by explorer dialogs after successful mutations.
 */
export function scheduleDeferredFeedback(callback: () => void): void {
  queueMicrotask(callback);
}
