"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  activateDocumentCacheForOwner,
  getDocumentCacheWriteToken,
  getCachedDocumentListForOwner,
  syncDocumentList,
  type DocumentCacheWriteToken,
} from "@/lib/doc-cache";
import { DOCUMENT_LIST_SELECT, type DocumentListItem } from "@/lib/documents";
import { queryWithCloneStatusFallback } from "@/lib/supabase/clone-status-compat";

type DocumentListState = {
  documents: DocumentListItem[];
  error: string | null;
  isLoading: boolean;
  refreshDocuments: () => Promise<void>;
};

export type OwnedDocumentListState = {
  documents: DocumentListItem[];
  error: string | null;
  isLoading: boolean;
  owner: string | null;
};

export type DocumentListLoadEvent =
  | { owner: string; type: "begin" }
  | { documents: DocumentListItem[]; owner: string; type: "cache" }
  | { documents: DocumentListItem[]; owner: string; type: "remote-success" }
  | { error: string; owner: string; type: "remote-error" }
  | { type: "reset" };

export function reduceDocumentListLoadState(
  current: OwnedDocumentListState,
  event: DocumentListLoadEvent,
): OwnedDocumentListState {
  if (event.type === "reset") {
    return {
      documents: [],
      error: null,
      isLoading: false,
      owner: null,
    };
  }

  if (event.type === "begin") {
    return {
      documents: [],
      error: null,
      isLoading: true,
      owner: event.owner,
    };
  }

  if (current.owner !== event.owner) {
    return current;
  }

  if (event.type === "cache") {
    if (event.documents.length === 0) {
      return current;
    }

    return {
      documents: event.documents,
      error: null,
      isLoading: false,
      owner: event.owner,
    };
  }

  if (event.type === "remote-success") {
    return {
      documents: event.documents,
      error: null,
      isLoading: false,
      owner: event.owner,
    };
  }

  return {
    ...current,
    error: current.documents.length === 0 ? event.error : null,
    isLoading: false,
  };
}

export function beginDocumentListRefresh(
  current: OwnedDocumentListState,
  owner: string,
) {
  return current.owner === owner
    ? {
        ...current,
        error: null,
        isLoading: current.documents.length === 0,
      }
    : reduceDocumentListLoadState(current, {
        owner,
        type: "begin",
      });
}

export function selectDocumentListView(
  state: OwnedDocumentListState,
  userId: string | null,
) {
  const isOwnedByCurrentUser = state.owner === userId;

  return {
    documents: isOwnedByCurrentUser ? state.documents : [],
    error: isOwnedByCurrentUser ? state.error : null,
    isLoading: Boolean(
      userId && (!isOwnedByCurrentUser || state.isLoading),
    ),
  };
}

type DocumentListRemoteResult =
  | { documents: DocumentListItem[]; error: null }
  | { documents: null; error: string };

type DocumentListCacheSnapshot = {
  documents: DocumentListItem[];
  token: DocumentCacheWriteToken | null;
};

type InitialDocumentListLoadOptions = {
  isCurrent: () => boolean;
  loadCache: () => Promise<DocumentListCacheSnapshot>;
  loadRemote: () => Promise<DocumentListRemoteResult>;
  onCache: (documents: DocumentListItem[]) => void;
  onRemoteError: (error: string) => void;
  onRemoteSuccess: (documents: DocumentListItem[]) => void;
  syncRemote: (
    documents: DocumentListItem[],
    token: DocumentCacheWriteToken | null,
  ) => void;
};

type DocumentListRefreshOptions = {
  activateCache: () => Promise<void>;
  getCacheWriteToken: () => DocumentCacheWriteToken | null;
  isCurrent: () => boolean;
  loadRemote: () => Promise<DocumentListRemoteResult>;
  onRemoteError: (error: string) => void;
  onRemoteSuccess: (documents: DocumentListItem[]) => void;
  syncRemote: (
    documents: DocumentListItem[],
    token: DocumentCacheWriteToken | null,
  ) => void;
};

const DOCUMENT_LIST_LOAD_ERROR =
  "Unable to load documents. Please check your connection.";

/**
 * Starts the remote list request before waiting for IndexedDB, then consumes
 * cache and remote results in that order. This removes the cache/network
 * waterfall without allowing a slow cache read to overwrite fresher remote
 * state. The caller owns request/owner cancellation through `isCurrent`.
 */
export async function loadInitialDocumentList({
  isCurrent,
  loadCache,
  loadRemote,
  onCache,
  onRemoteError,
  onRemoteSuccess,
  syncRemote,
}: InitialDocumentListLoadOptions) {
  const remotePromise = (async (): Promise<DocumentListRemoteResult> => {
    try {
      return await loadRemote();
    } catch {
      return { documents: null, error: DOCUMENT_LIST_LOAD_ERROR };
    }
  })();

  let cacheSnapshot: DocumentListCacheSnapshot = {
    documents: [],
    token: null,
  };

  try {
    cacheSnapshot = await loadCache();
  } catch {
    // IndexedDB is best-effort. The already-started remote request remains the
    // authoritative fallback.
  }

  if (!isCurrent()) {
    return;
  }

  if (cacheSnapshot.documents.length > 0) {
    onCache(cacheSnapshot.documents);
  }

  const remoteResult = await remotePromise;
  if (!isCurrent()) {
    return;
  }

  if (remoteResult.error !== null) {
    onRemoteError(remoteResult.error);
    return;
  }

  onRemoteSuccess(remoteResult.documents);
  syncRemote(remoteResult.documents, cacheSnapshot.token);
}

/**
 * Keeps the remote refresh in parallel with cache activation, but does not
 * capture a cache generation until activation has settled. This lets a manual
 * refresh safely supersede the initial load during cold startup.
 */
export async function loadDocumentListRefresh({
  activateCache,
  getCacheWriteToken,
  isCurrent,
  loadRemote,
  onRemoteError,
  onRemoteSuccess,
  syncRemote,
}: DocumentListRefreshOptions) {
  const remotePromise = (async (): Promise<DocumentListRemoteResult> => {
    try {
      return await loadRemote();
    } catch {
      return { documents: null, error: DOCUMENT_LIST_LOAD_ERROR };
    }
  })();

  try {
    await activateCache();
  } catch {
    // Cache activation is best-effort. The remote result can still update the
    // in-memory list, while a null token prevents an unauthorized cache write.
  }

  if (!isCurrent()) {
    return;
  }

  const cacheWriteToken = getCacheWriteToken();
  const remoteResult = await remotePromise;
  if (!isCurrent()) {
    return;
  }

  if (remoteResult.error !== null) {
    onRemoteError(remoteResult.error);
    return;
  }

  onRemoteSuccess(remoteResult.documents);
  syncRemote(remoteResult.documents, cacheWriteToken);
}

const INITIAL_STATE: OwnedDocumentListState = {
  documents: [],
  error: null,
  isLoading: false,
  owner: null,
};

export function useDocumentList(userId: string | null): DocumentListState {
  const [state, setState] = useState<OwnedDocumentListState>(INITIAL_STATE);
  const requestIdRef = useRef(0);
  const supabaseModuleRef =
    useRef<Promise<typeof import("@/lib/supabase/client")> | null>(null);

  const visibleState = selectDocumentListView(state, userId);

  if (!supabaseModuleRef.current) {
    supabaseModuleRef.current = import("@/lib/supabase/client");
  }

  const loadRemoteDocuments = useCallback(
    async (owner: string): Promise<DocumentListRemoteResult> => {
      try {
        const { getSupabaseBrowserClient } = await supabaseModuleRef.current!;
        const supabase = await getSupabaseBrowserClient();
        const { data, error } = await queryWithCloneStatusFallback(
          () =>
            supabase
              .from("documents")
              .select(DOCUMENT_LIST_SELECT)
              .eq("owner", owner)
              .is("clone_status", null)
              .order("updated_at", { ascending: false }),
          () =>
            supabase
              .from("documents")
              .select(DOCUMENT_LIST_SELECT)
              .eq("owner", owner)
              .order("updated_at", { ascending: false }),
        );

        return error
          ? { documents: null, error: error.message }
          : { documents: data ?? [], error: null };
      } catch {
        return { documents: null, error: DOCUMENT_LIST_LOAD_ERROR };
      }
    },
    [],
  );

  const refreshDocuments = useCallback(async () => {
    if (!userId) {
      setState((current) =>
        reduceDocumentListLoadState(current, { type: "reset" }),
      );
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setState((current) => beginDocumentListRefresh(current, userId));

    await loadDocumentListRefresh({
      activateCache: () => activateDocumentCacheForOwner(userId),
      getCacheWriteToken: () => getDocumentCacheWriteToken(userId),
      isCurrent: () => requestId === requestIdRef.current,
      loadRemote: () => loadRemoteDocuments(userId),
      onRemoteError: (error) => {
        setState((current) =>
          reduceDocumentListLoadState(current, {
            error,
            owner: userId,
            type: "remote-error",
          }),
        );
      },
      onRemoteSuccess: (documents) => {
        setState((current) =>
          reduceDocumentListLoadState(current, {
            documents,
            owner: userId,
            type: "remote-success",
          }),
        );
      },
      syncRemote: (documents, token) => {
        void syncDocumentList(documents, userId, token);
      },
    });
  }, [loadRemoteDocuments, userId]);

  useEffect(() => {
    if (!userId) {
      setState((current) =>
        reduceDocumentListLoadState(current, { type: "reset" }),
      );
      return;
    }

    let isActive = true;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setState((current) =>
      reduceDocumentListLoadState(current, {
        owner: userId,
        type: "begin",
      }),
    );

    void loadInitialDocumentList({
      isCurrent: () => isActive && requestId === requestIdRef.current,
      loadCache: async () => {
        await activateDocumentCacheForOwner(userId);
        const token = getDocumentCacheWriteToken(userId);
        const documents = await getCachedDocumentListForOwner(userId, token);
        return { documents, token };
      },
      loadRemote: () => loadRemoteDocuments(userId),
      onCache: (documents) => {
        setState((current) =>
          reduceDocumentListLoadState(current, {
            documents,
            owner: userId,
            type: "cache",
          }),
        );
      },
      onRemoteError: (error) => {
        setState((current) =>
          reduceDocumentListLoadState(current, {
            error,
            owner: userId,
            type: "remote-error",
          }),
        );
      },
      onRemoteSuccess: (documents) => {
        setState((current) =>
          reduceDocumentListLoadState(current, {
            documents,
            owner: userId,
            type: "remote-success",
          }),
        );
      },
      syncRemote: (documents, token) => {
        void syncDocumentList(documents, userId, token);
      },
    });

    return () => {
      isActive = false;
      requestIdRef.current += 1;
    };
  }, [loadRemoteDocuments, userId]);

  return {
    documents: visibleState.documents,
    error: visibleState.error,
    isLoading: visibleState.isLoading,
    refreshDocuments,
  };
}
