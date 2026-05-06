"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getCachedDocumentListForOwner,
  setLastActiveOwner,
  syncDocumentList,
} from "@/lib/doc-cache";
import { DOCUMENT_LIST_SELECT, type DocumentListItem } from "@/lib/documents";

type DocumentListState = {
  documents: DocumentListItem[];
  error: string | null;
  refreshDocuments: () => Promise<void>;
};

export function useDocumentList(userId: string): DocumentListState {
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const hasDocumentsRef = useRef(false);
  const supabaseModuleRef =
    useRef<Promise<typeof import("@/lib/supabase/client")> | null>(null);

  hasDocumentsRef.current = documents.length > 0;

  if (!supabaseModuleRef.current) {
    supabaseModuleRef.current = import("@/lib/supabase/client");
  }

  const refreshDocuments = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setError(null);

    try {
      const { getSupabaseBrowserClient } = await supabaseModuleRef.current!;
      const supabase = await getSupabaseBrowserClient();
      const { data, error: fetchError } = await supabase
        .from("documents")
        .select(DOCUMENT_LIST_SELECT)
        .eq("owner", userId)
        .order("updated_at", { ascending: false });

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (fetchError) {
        if (!hasDocumentsRef.current) {
          setError(fetchError.message);
        }
        return;
      }

      const nextDocuments = data ?? [];
      setDocuments(nextDocuments);
      void syncDocumentList(nextDocuments, userId);
    } catch {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!hasDocumentsRef.current) {
        setError("Unable to load documents. Please check your connection.");
      }
    }
  }, [userId]);

  useEffect(() => {
    let isActive = true;

    void setLastActiveOwner(userId);

    void getCachedDocumentListForOwner(userId).then((cachedDocuments) => {
      if (!isActive || cachedDocuments.length === 0) {
        return;
      }

      setDocuments(cachedDocuments);
    });

    void refreshDocuments();

    return () => {
      isActive = false;
      requestIdRef.current += 1;
    };
  }, [userId, refreshDocuments]);

  return {
    documents,
    error,
    refreshDocuments,
  };
}
