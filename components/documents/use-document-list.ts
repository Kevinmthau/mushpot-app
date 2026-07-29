"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  activateDocumentCacheForOwner,
  getDocumentCacheWriteToken,
  getCachedDocumentListForOwner,
  syncDocumentList,
} from "@/lib/doc-cache";
import { DOCUMENT_LIST_SELECT, type DocumentListItem } from "@/lib/documents";

type DocumentListState = {
  documents: DocumentListItem[];
  error: string | null;
  refreshDocuments: () => Promise<void>;
};

type OwnedDocumentListState = {
  documents: DocumentListItem[];
  error: string | null;
  owner: string | null;
};

export function useDocumentList(userId: string | null): DocumentListState {
  const [state, setState] = useState<OwnedDocumentListState>({
    documents: [],
    error: null,
    owner: null,
  });
  const requestIdRef = useRef(0);
  const hasDocumentsRef = useRef(false);
  const supabaseModuleRef =
    useRef<Promise<typeof import("@/lib/supabase/client")> | null>(null);

  const isStateOwnedByCurrentUser = state.owner === userId;
  const visibleDocuments = isStateOwnedByCurrentUser ? state.documents : [];
  const visibleError = isStateOwnedByCurrentUser ? state.error : null;

  hasDocumentsRef.current = visibleDocuments.length > 0;

  if (!supabaseModuleRef.current) {
    supabaseModuleRef.current = import("@/lib/supabase/client");
  }

  const refreshDocuments = useCallback(async () => {
    if (!userId) {
      setState({
        documents: [],
        error: null,
        owner: null,
      });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const cacheWriteToken = getDocumentCacheWriteToken(userId);

    setState((current) =>
      current.owner === userId
        ? { ...current, error: null }
        : { documents: [], error: null, owner: userId },
    );

    try {
      const { getSupabaseBrowserClient } = await supabaseModuleRef.current!;
      const supabase = await getSupabaseBrowserClient();
      const { data, error: fetchError } = await supabase
        .from("documents")
        .select(DOCUMENT_LIST_SELECT)
        .eq("owner", userId)
        .is("clone_status", null)
        .order("updated_at", { ascending: false });

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (fetchError) {
        if (!hasDocumentsRef.current) {
          setState((current) =>
            current.owner === userId
              ? { ...current, error: fetchError.message }
              : current,
          );
        }
        return;
      }

      const nextDocuments = data ?? [];
      setState({
        documents: nextDocuments,
        error: null,
        owner: userId,
      });
      void syncDocumentList(nextDocuments, userId, cacheWriteToken);
    } catch {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!hasDocumentsRef.current) {
        setState((current) =>
          current.owner === userId
            ? {
                ...current,
                error: "Unable to load documents. Please check your connection.",
              }
            : current,
        );
      }
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setState({
        documents: [],
        error: null,
        owner: null,
      });
      return;
    }

    let isActive = true;
    setState({
      documents: [],
      error: null,
      owner: userId,
    });

    void (async () => {
      await activateDocumentCacheForOwner(userId);

      if (!isActive) {
        return;
      }

      const cacheReadToken = getDocumentCacheWriteToken(userId);
      const cachedDocuments = await getCachedDocumentListForOwner(
        userId,
        cacheReadToken,
      );
      if (isActive && cachedDocuments.length > 0) {
        setState({
          documents: cachedDocuments,
          error: null,
          owner: userId,
        });
      }

      if (isActive) {
        void refreshDocuments();
      }
    })();

    return () => {
      isActive = false;
      requestIdRef.current += 1;
    };
  }, [userId, refreshDocuments]);

  return {
    documents: visibleDocuments,
    error: visibleError,
    refreshDocuments,
  };
}
