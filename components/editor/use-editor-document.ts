"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { EditorDocument } from "@/components/editor/editor-types";
import {
  getCachedDocumentForOwner,
  getLastActiveOwner,
  reconcileCachedDocumentWithServer,
  setLastActiveOwner,
  type CachedDocument,
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

const INITIAL_DOCUMENT_STATE: EditorDocumentState = {
  document: null,
  error: null,
  hasResolvedRemoteState: false,
  notFound: false,
};

export function useEditorDocument(documentId: string): EditorDocumentState {
  const router = useRouter();
  const [state, setState] = useState<EditorDocumentState>(INITIAL_DOCUMENT_STATE);

  useEffect(() => {
    let isActive = true;

    setState(INITIAL_DOCUMENT_STATE);

    const setDocumentIfChanged = (nextDocument: EditorDocument) => {
      setState((current) => ({
        ...current,
        document:
          current.document && areEditorDocumentsEqual(current.document, nextDocument)
            ? current.document
            : nextDocument,
      }));
    };

    void (async () => {
      let cachedDocument: CachedDocument | null = null;
      let cachedOwner: string | null = null;
      let hasValidatedCachedDocument = false;

      try {
        const supabaseModulePromise = import("@/lib/supabase/client");

        cachedOwner = await getLastActiveOwner();

        if (!isActive) {
          return;
        }

        if (cachedOwner) {
          cachedDocument = await getCachedDocumentForOwner(documentId, cachedOwner);
          if (!isActive) {
            return;
          }
        }

        const { getSupabaseBrowserClient } = await supabaseModulePromise;
        const supabase = await getSupabaseBrowserClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!isActive) {
          return;
        }

        const userId = session?.user?.id ?? null;
        if (!userId) {
          cachedDocument = null;
          setState((current) => ({
            ...current,
            document: null,
            hasResolvedRemoteState: true,
          }));
          router.replace(`/auth?next=/doc/${documentId}`);
          return;
        }

        void setLastActiveOwner(userId);

        if (cachedOwner !== userId) {
          cachedDocument = null;
          setState((current) => ({
            ...current,
            document: current.document?.owner === userId ? current.document : null,
          }));
        } else if (cachedDocument) {
          hasValidatedCachedDocument = true;
          setDocumentIfChanged(toEditorDocument(cachedDocument));
        }

        if (cachedOwner !== userId || !cachedDocument) {
          const ownerScopedCachedDocument = await getCachedDocumentForOwner(
            documentId,
            userId,
          );
          if (!isActive) {
            return;
          }

          if (ownerScopedCachedDocument) {
            cachedDocument = ownerScopedCachedDocument;
            hasValidatedCachedDocument = true;
            setDocumentIfChanged(toEditorDocument(ownerScopedCachedDocument));
          }
        }

        const { data: serverDocument, error: fetchError } = await supabase
          .from("documents")
          .select(EDITOR_DOCUMENT_SELECT)
          .eq("id", documentId)
          .eq("owner", userId)
          .maybeSingle();

        if (!isActive) {
          return;
        }

        setState((current) => ({ ...current, hasResolvedRemoteState: true }));

        if (fetchError) {
          if (!hasValidatedCachedDocument) {
            setState((current) => ({ ...current, error: fetchError.message }));
          }
          return;
        }

        if (!serverDocument) {
          if (!hasValidatedCachedDocument) {
            setState((current) => ({ ...current, notFound: true }));
          }
          return;
        }

        const reconciled = await reconcileCachedDocumentWithServer({
          ...serverDocument,
          _dirty: false,
        });

        if (!isActive) {
          return;
        }

        setDocumentIfChanged(toEditorDocument(reconciled));
      } catch {
        if (!isActive) {
          return;
        }

        setState((current) => ({
          ...current,
          document: hasValidatedCachedDocument ? current.document : null,
          error: hasValidatedCachedDocument
            ? current.error
            : "Unable to load document. Please check your connection.",
          hasResolvedRemoteState: true,
        }));
      }
    })();

    return () => {
      isActive = false;
    };
  }, [documentId, router]);

  return state;
}
