"use client";

const NEW_DOCUMENT_TITLE_FOCUS_KEY = "mushpot:new-document-title-focus";

let temporaryFocusHolder: HTMLInputElement | null = null;

export function markNewDocumentForTitleFocus(documentId: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(NEW_DOCUMENT_TITLE_FOCUS_KEY, documentId);
}

export function consumeNewDocumentTitleFocus(documentId: string) {
  if (typeof window === "undefined") {
    return false;
  }

  const pendingDocumentId = window.sessionStorage.getItem(
    NEW_DOCUMENT_TITLE_FOCUS_KEY,
  );

  if (pendingDocumentId !== documentId) {
    return false;
  }

  window.sessionStorage.removeItem(NEW_DOCUMENT_TITLE_FOCUS_KEY);
  return true;
}

// Synchronously focus an off-screen input so the mobile virtual keyboard
// opens while we're still inside the user's tap gesture. iOS Safari only
// opens the keyboard when focus() happens in direct response to a trusted
// user event, so we can't wait for the async document creation and
// navigation to finish. The temporary input holds the keyboard open until
// the real title input mounts and takes over focus.
export function openKeyboardForNewDocument() {
  if (typeof document === "undefined") {
    return;
  }

  releaseTemporaryKeyboardHolder();

  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  input.style.position = "fixed";
  input.style.top = "0";
  input.style.left = "0";
  input.style.width = "1px";
  input.style.height = "1px";
  input.style.opacity = "0";
  input.style.pointerEvents = "none";
  document.body.appendChild(input);
  input.focus({ preventScroll: true });
  temporaryFocusHolder = input;
}

export function releaseTemporaryKeyboardHolder() {
  if (temporaryFocusHolder) {
    temporaryFocusHolder.remove();
    temporaryFocusHolder = null;
  }
}
