"use client";

const NEW_DOCUMENT_TITLE_FOCUS_KEY = "mushpot:new-document-title-focus";

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
