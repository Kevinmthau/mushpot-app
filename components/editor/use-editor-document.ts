"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { EditorDocument } from "@/components/editor/editor-types";
import {
  activateDocumentCacheForOwner,
  getDocumentCacheWriteToken,
  getCachedDocumentForOwner,
  reconcileCachedDocumentWithServer,
  type DocumentCacheWriteToken,
} from "@/lib/doc-cache";
import {
  areEditorDocumentsEqual,
  EDITOR_DOCUMENT_SELECT,
  toEditorDocument,
} from "@/lib/documents";
import { queryWithCloneStatusFallback } from "@/lib/supabase/clone-status-compat";

type EditorDocumentState = {
  document: EditorDocument | null;
  error: string | null;
  hasResolvedRemoteState: boolean;
  notFound: boolean;
};

type EditorDocumentResult = EditorDocumentState & {
  markLocallyEdited: () => void;
};

type OwnedEditorDocumentState = EditorDocumentState & {
  owner: string | null;
};

type EditorCacheSnapshot = {
  document: EditorDocument | null;
  token: DocumentCacheWriteToken | null;
};

type EditorRemoteResult =
  | { document: EditorDocument; error: null }
  | { document: null; error: string | null };

export type EditorDocumentResolution = {
  document: EditorDocument | null;
  error: string | null;
  notFound: boolean;
};

type EditorDocumentLoadOptions = {
  hasLocalEdits?: () => boolean;
  isCurrent: () => boolean;
  loadCache: () => Promise<EditorCacheSnapshot>;
  loadRemote: () => Promise<EditorRemoteResult>;
  onCache: (document: EditorDocument) => void;
  onResolved: (resolution: EditorDocumentResolution) => void;
  reconcileRemote: (
    document: EditorDocument,
    token: DocumentCacheWriteToken | null,
    canWrite: () => boolean,
  ) => Promise<EditorDocument>;
};

const EDITOR_LOAD_ERROR =
  "Unable to load document. Please check your connection.";

/**
 * Starts the remote document query immediately, then validates the owner cache
 * before consuming it. Remote publication waits for dirty-aware cache
 * reconciliation, so a faster clean server row can never reset a local draft.
 */
export async function loadEditorDocument({
  hasLocalEdits = () => false,
  isCurrent,
  loadCache,
  loadRemote,
  onCache,
  onResolved,
  reconcileRemote,
}: EditorDocumentLoadOptions) {
  const remotePromise = (async (): Promise<EditorRemoteResult> => {
    try {
      return await loadRemote();
    } catch {
      return { document: null, error: EDITOR_LOAD_ERROR };
    }
  })();

  let cacheSnapshot: EditorCacheSnapshot = {
    document: null,
    token: null,
  };

  try {
    cacheSnapshot = await loadCache();
  } catch {
    // IndexedDB is best-effort. Remote state can still resolve the editor.
  }

  if (!isCurrent()) {
    return;
  }

  if (cacheSnapshot.document) {
    onCache(cacheSnapshot.document);
  }

  const remoteResult = await remotePromise;
  if (!isCurrent()) {
    return;
  }

  if (remoteResult.error !== null) {
    onResolved({
      document: cacheSnapshot.document,
      error: cacheSnapshot.document ? null : remoteResult.error,
      notFound: false,
    });
    return;
  }

  if (!remoteResult.document) {
    const dirtyCachedDraft =
      cacheSnapshot.document?._dirty === true || hasLocalEdits()
        ? cacheSnapshot.document
        : null;

    onResolved({
      document: dirtyCachedDraft,
      error: null,
      notFound: !dirtyCachedDraft,
    });
    return;
  }

  // An offline-dirty snapshot was already authoritative when this load began.
  // Do not let a remote response read or write through cache reconciliation.
  if (cacheSnapshot.document?._dirty === true) {
    onResolved({
      document: cacheSnapshot.document,
      error: null,
      notFound: false,
    });
    return;
  }

  // Current-session edits live in useDocumentDraft until its debounced cache
  // write runs. Publish the raw row for field merging without allowing this
  // older response to write into the cache first.
  if (hasLocalEdits()) {
    onResolved({
      document: remoteResult.document,
      error: null,
      notFound: false,
    });
    return;
  }

  try {
    const reconciledDocument = await reconcileRemote(
      remoteResult.document,
      cacheSnapshot.token,
      () => isCurrent() && !hasLocalEdits(),
    );

    if (!isCurrent()) {
      return;
    }

    // An edit can begin while IndexedDB reconciliation is awaiting completion.
    // In that case, still publish the raw row so useDocumentDraft can preserve
    // local fields and merge untouched remote fields against their baselines.
    const resolvedDocument = hasLocalEdits()
      ? remoteResult.document
      : reconciledDocument;

    onResolved({
      document: resolvedDocument,
      error: null,
      notFound: false,
    });
  } catch {
    if (!isCurrent()) {
      return;
    }

    onResolved({
      document: cacheSnapshot.document,
      error: cacheSnapshot.document ? null : EDITOR_LOAD_ERROR,
      notFound: false,
    });
  }
}

const INITIAL_DOCUMENT_STATE: OwnedEditorDocumentState = {
  document: null,
  error: null,
  hasResolvedRemoteState: false,
  notFound: false,
  owner: null,
};

export function useEditorDocument(
  documentId: string,
  userId: string | null,
): EditorDocumentResult {
  const [state, setState] =
    useState<OwnedEditorDocumentState>(INITIAL_DOCUMENT_STATE);
  const localEditStateRef = useRef<{
    documentId: string;
    edited: boolean;
    owner: string | null;
  } | null>(null);
  const markLocallyEdited = useCallback(() => {
    const localEditState = localEditStateRef.current;
    if (
      localEditState?.documentId === documentId &&
      localEditState.owner === userId
    ) {
      localEditState.edited = true;
    }
  }, [documentId, userId]);

  useEffect(() => {
    let isActive = true;
    const localEditState = {
      documentId,
      edited: false,
      owner: userId,
    };
    localEditStateRef.current = localEditState;

    setState({
      ...INITIAL_DOCUMENT_STATE,
      owner: userId,
    });

    if (!userId) {
      setState({
        ...INITIAL_DOCUMENT_STATE,
        hasResolvedRemoteState: true,
        owner: null,
      });
      return () => {
        isActive = false;
        if (localEditStateRef.current === localEditState) {
          localEditStateRef.current = null;
        }
      };
    }

    const setDocumentIfChanged = (nextDocument: EditorDocument) => {
      setState((current) =>
        current.owner === userId
          ? {
              ...current,
              document:
                current.document &&
                areEditorDocumentsEqual(current.document, nextDocument)
                  ? current.document
                  : nextDocument,
            }
          : current,
      );
    };

    const resolveDocument = (resolution: EditorDocumentResolution) => {
      setState((current) => {
        if (current.owner !== userId) {
          return current;
        }

        const nextDocument =
          current.document &&
          resolution.document &&
          areEditorDocumentsEqual(current.document, resolution.document)
            ? current.document
            : resolution.document;

        return {
          document: nextDocument,
          error: resolution.error,
          hasResolvedRemoteState: true,
          notFound: resolution.notFound,
          owner: userId,
        };
      });
    };

    void loadEditorDocument({
      hasLocalEdits: () =>
        localEditStateRef.current === localEditState && localEditState.edited,
      isCurrent: () => isActive,
      loadCache: async () => {
        await activateDocumentCacheForOwner(userId);
        const token = getDocumentCacheWriteToken(userId);
        const cachedDocument = await getCachedDocumentForOwner(
          documentId,
          userId,
          token,
        );

        return {
          document: cachedDocument ? toEditorDocument(cachedDocument) : null,
          token,
        };
      },
      loadRemote: async () => {
        try {
          const { getSupabaseBrowserClient } = await import(
            "@/lib/supabase/client"
          );
          const supabase = await getSupabaseBrowserClient();
          const { data, error } = await queryWithCloneStatusFallback(
            () =>
              supabase
                .from("documents")
                .select(EDITOR_DOCUMENT_SELECT)
                .eq("id", documentId)
                .eq("owner", userId)
                .is("clone_status", null)
                .maybeSingle(),
            () =>
              supabase
                .from("documents")
                .select(EDITOR_DOCUMENT_SELECT)
                .eq("id", documentId)
                .eq("owner", userId)
                .maybeSingle(),
          );

          return error
            ? { document: null, error: error.message }
            : { document: data, error: null };
        } catch {
          return { document: null, error: EDITOR_LOAD_ERROR };
        }
      },
      onCache: setDocumentIfChanged,
      onResolved: resolveDocument,
      reconcileRemote: async (serverDocument, token, canWrite) => {
        const reconciled = await reconcileCachedDocumentWithServer(
          {
            ...serverDocument,
            _dirty: false,
          },
          token,
          canWrite,
        );
        return toEditorDocument(reconciled);
      },
    });

    return () => {
      isActive = false;
      if (localEditStateRef.current === localEditState) {
        localEditStateRef.current = null;
      }
    };
  }, [documentId, userId]);

  if (state.owner !== userId) {
    return { ...INITIAL_DOCUMENT_STATE, markLocallyEdited };
  }

  return { ...state, markLocallyEdited };
}
