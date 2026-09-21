export type CachedDocumentBase = {
  id: string;
  owner: string;
  title: string;
  updated_at: string;
};

/**
 * Complete editor data accepted by cache writers. `kind` remains optional at
 * this boundary so existing document mapping helpers do not need to know about
 * the storage representation.
 */
export type CachedDocument = CachedDocumentBase & {
  kind?: "complete";
  content: string;
  share_enabled: boolean;
  share_token: string | null;
  /** Timestamp of last local write – used to detect dirty docs. */
  _localUpdatedAt?: number;
  /** True when local changes have not been persisted to the server yet. */
  _dirty?: boolean;
  /** Legacy cache revisions may have come from metadata without the body. */
  _baseVersionUntrusted?: boolean;
  /** Numeric IndexedDB key for dirty-document lookups. */
  _dirtyKey?: 1;
  /** List metadata never changes the content snapshot or its server revision. */
  _listMetadata?: Pick<CachedDocumentListItem, "title" | "updated_at">;
};

export type CachedCompleteDocument = CachedDocument & {
  kind: "complete";
};

export type CachedMetadataDocument = CachedDocumentBase & {
  kind: "metadata";
};

/** The discriminated record shape persisted in IndexedDB. */
export type CachedDocumentRecord =
  | CachedCompleteDocument
  | CachedMetadataDocument;

export type CachedDocumentListItem = {
  id: string;
  title: string;
  updated_at: string;
};

export function isCompleteDocument(
  document: CachedDocumentRecord | null | undefined,
): document is CachedCompleteDocument {
  return document?.kind === "complete";
}

export function toMetadataDocument(
  document: CachedDocumentBase,
): CachedMetadataDocument {
  return {
    id: document.id,
    kind: "metadata",
    owner: document.owner,
    title: document.title,
    updated_at: document.updated_at,
  };
}

export function toStoredCompleteDocument(
  document: CachedDocument,
): CachedCompleteDocument {
  const storedDocument: CachedCompleteDocument = {
    ...document,
    kind: "complete",
  };

  if (storedDocument._dirty) {
    storedDocument._dirtyKey = 1;
  } else {
    delete storedDocument._dirtyKey;
  }

  return storedDocument;
}

function documentsHaveDifferentEditorState(
  left: CachedCompleteDocument,
  right: CachedCompleteDocument,
) {
  const leftTitle = left.title.trim() || "Untitled";
  const rightTitle = right.title.trim() || "Untitled";

  return (
    leftTitle !== rightTitle ||
    left.content !== right.content ||
    left.share_enabled !== right.share_enabled ||
    left.share_token !== right.share_token
  );
}

export function isCachedDocumentNewerThanServerListItem(
  cachedDocument: Pick<CachedDocumentListItem, "updated_at">,
  serverDocument: CachedDocumentListItem,
) {
  const cachedUpdatedAt = Date.parse(cachedDocument.updated_at);
  const serverUpdatedAt = Date.parse(serverDocument.updated_at);

  return (
    !Number.isNaN(cachedUpdatedAt) &&
    (Number.isNaN(serverUpdatedAt) || cachedUpdatedAt > serverUpdatedAt)
  );
}

/** Project display metadata without changing the editor's optimistic revision. */
export function toDocumentListItem(
  document: CachedDocumentRecord,
): CachedDocumentListItem {
  const complete = isCompleteDocument(document);
  const metadata = complete ? document._listMetadata : undefined;
  const useMetadata = metadata && !isCachedDocumentNewerThanServerListItem(
    document,
    { id: document.id, ...metadata },
  );
  return {
    id: document.id,
    title: useMetadata && !(complete && document._dirty)
      ? metadata.title
      : document.title,
    updated_at: useMetadata ? metadata.updated_at : document.updated_at,
  };
}

export function mergeDocumentListMetadata(
  document: CachedCompleteDocument,
  metadata: CachedCompleteDocument["_listMetadata"],
): CachedCompleteDocument {
  if (!metadata || isCachedDocumentNewerThanServerListItem(
    document,
    { id: document.id, ...metadata },
  )) {
    return document;
  }
  const current = document._listMetadata;
  if (current && (
    Date.parse(current.updated_at) > Date.parse(metadata.updated_at) ||
    (current.updated_at === metadata.updated_at && current.title === metadata.title)
  )) {
    return document;
  }
  return { ...document, _listMetadata: { ...metadata } };
}

export function compareDocumentListItems(
  left: CachedDocumentListItem,
  right: CachedDocumentListItem,
) {
  return right.updated_at.localeCompare(left.updated_at) ||
    right.id.localeCompare(left.id);
}

export function shouldPreserveExistingDocument(
  existing: CachedDocumentRecord | undefined,
  incoming: CachedCompleteDocument,
) {
  if (!isCompleteDocument(existing)) {
    return false;
  }

  // Equal text can still represent a newer revert. Keep its revision and dirty
  // state until it is acknowledged, so delayed intermediate edits stay stale.
  if (
    existing._localUpdatedAt !== undefined &&
    incoming._localUpdatedAt !== undefined &&
    existing._localUpdatedAt > incoming._localUpdatedAt
  ) {
    return true;
  }

  if (!documentsHaveDifferentEditorState(existing, incoming)) {
    return false;
  }

  // Never let a remote reconciliation or completed save replace different,
  // unsynced local content.
  if (!incoming._dirty && existing._dirty) {
    return true;
  }

  // Different content at the same local revision is not a confirmation of the
  // cached snapshot. A clean completion must not replace it.
  return (
    existing._localUpdatedAt !== undefined &&
    incoming._localUpdatedAt !== undefined &&
    !incoming._dirty &&
    existing._localUpdatedAt === incoming._localUpdatedAt
  );
}
