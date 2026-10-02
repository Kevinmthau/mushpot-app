import type { CachedDocumentListItem } from "@/lib/document-cache-record";
import type { DocumentCacheWriteToken } from "@/lib/doc-cache";

export type DocumentCacheChange =
  | { type: "upsert"; token: DocumentCacheWriteToken; document: CachedDocumentListItem; dirty?: boolean }
  | { type: "delete"; token: DocumentCacheWriteToken; documentId: string }
  | { type: "replace"; token: DocumentCacheWriteToken; documents: CachedDocumentListItem[] }
  | { type: "invalidate"; owner: string };

const listeners = new Set<(change: DocumentCacheChange) => void>();

export function subscribeToDocumentCacheChanges(
  listener: (change: DocumentCacheChange) => void,
) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Only committed, authorized metadata may reach a retained private list. */
export function announceDocumentCacheChange(change: DocumentCacheChange) {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // An observer must never change the result of a durable cache operation.
    }
  }
}
