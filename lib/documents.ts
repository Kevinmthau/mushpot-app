import type { CachedDocument } from "@/lib/doc-cache";
import type { DocumentRow } from "@/lib/supabase/types";

export const DOCUMENT_LIST_SELECT = "id, title, updated_at" as const;
export const EDITOR_DOCUMENT_SELECT =
  "id, owner, title, content, updated_at, share_enabled, share_token" as const;

export type DocumentListItem = Pick<DocumentRow, "id" | "title" | "updated_at">;

export type EditorDocument = Pick<
  DocumentRow,
  | "id"
  | "owner"
  | "title"
  | "content"
  | "updated_at"
  | "share_enabled"
  | "share_token"
>;

export function getDocumentDisplayTitle(title: string) {
  return title || "Untitled";
}

export function toCachedDocument(document: EditorDocument): CachedDocument {
  return {
    ...document,
    _dirty: false,
  };
}

export function toEditorDocument(document: EditorDocument): EditorDocument {
  return {
    id: document.id,
    owner: document.owner,
    title: document.title,
    content: document.content,
    updated_at: document.updated_at,
    share_enabled: document.share_enabled,
    share_token: document.share_token,
  };
}

export function areEditorDocumentsEqual(
  left: EditorDocument,
  right: EditorDocument,
) {
  return (
    left.id === right.id &&
    left.owner === right.owner &&
    left.title === right.title &&
    left.content === right.content &&
    left.updated_at === right.updated_at &&
    left.share_enabled === right.share_enabled &&
    left.share_token === right.share_token
  );
}
