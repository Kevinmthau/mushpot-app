"use client";

import { useEffect, useState } from "react";

import type { EditorDocument } from "@/components/editor/editor-types";
import {
  activateDocumentCacheForOwner,
  getDocumentCacheWriteToken,
  getCachedDocumentForOwner,
  reconcileCachedDocumentWithServer,
  type CachedCompleteDocument,
} from "@/lib/doc-cache";
import {
  areEditorDocumentsEqual,
  EDITOR_DOCUMENT_SELECT,
  toEditorDocument,
} from "@/lib/documents";

type EditorDocumentState = {
  document: EditorDocument | null;
  error: string | null;
  hasResolvedRemoteState: boolean;
  notFound: boolean;
};

type OwnedEditorDocumentState = EditorDocumentState & {
  owner: string | null;
};

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
): EditorDocumentState {
  const [state, setState] =
    useState<OwnedEditorDocumentState>(INITIAL_DOCUMENT_STATE);

  useEffect(() => {
    let isActive = true;

    setState({
      ...INITIAL_DOCUMENT_STATE,
      owner: userId,
    });

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

    void (async () => {
      let cachedDocument: CachedCompleteDocument | null = null;
      let hasValidatedCachedDocument = false;

      try {
        const supabaseModulePromise = import("@/lib/supabase/client");

        if (!userId) {
          cachedDocument = null;
          setState((current) => ({
            ...current,
            document: null,
            hasResolvedRemoteState: true,
            owner: null,
          }));
          return;
        }

        await activateDocumentCacheForOwner(userId);

        if (!isActive) {
          return;
        }

        const cacheWriteToken = getDocumentCacheWriteToken(userId);

        cachedDocument = await getCachedDocumentForOwner(
          documentId,
          userId,
          cacheWriteToken,
        );

        if (!isActive) {
          return;
        }

        if (cachedDocument) {
          hasValidatedCachedDocument = true;
          setDocumentIfChanged(toEditorDocument(cachedDocument));
        }

        const { getSupabaseBrowserClient } = await supabaseModulePromise;
        const supabase = await getSupabaseBrowserClient();

        const { data: serverDocument, error: fetchError } = await supabase
          .from("documents")
          .select(EDITOR_DOCUMENT_SELECT)
          .eq("id", documentId)
          .eq("owner", userId)
          .is("clone_status", null)
          .maybeSingle();

        if (!isActive) {
          return;
        }

        setState((current) =>
          current.owner === userId
            ? { ...current, hasResolvedRemoteState: true }
            : current,
        );

        if (fetchError) {
          if (!hasValidatedCachedDocument) {
            setState((current) =>
              current.owner === userId
                ? { ...current, error: fetchError.message }
                : current,
            );
          }
          return;
        }

        if (!serverDocument) {
          if (!hasValidatedCachedDocument) {
            setState((current) =>
              current.owner === userId
                ? { ...current, notFound: true }
                : current,
            );
          }
          return;
        }

        const reconciled = await reconcileCachedDocumentWithServer(
          {
            ...serverDocument,
            _dirty: false,
          },
          cacheWriteToken,
        );

        if (!isActive) {
          return;
        }

        setDocumentIfChanged(toEditorDocument(reconciled));
      } catch {
        if (!isActive) {
          return;
        }

        setState((current) =>
          current.owner === userId
            ? {
                ...current,
                document: hasValidatedCachedDocument ? current.document : null,
                error: hasValidatedCachedDocument
                  ? current.error
                  : "Unable to load document. Please check your connection.",
                hasResolvedRemoteState: true,
              }
            : current,
        );
      }
    })();

    return () => {
      isActive = false;
    };
  }, [documentId, userId]);

  if (state.owner !== userId) {
    return INITIAL_DOCUMENT_STATE;
  }

  return state;
}
