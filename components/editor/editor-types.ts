import type { EditorDocument } from "@/lib/documents";

export type { EditorDocument };

export type EditorClientProps = {
  hasResolvedRemoteState: boolean;
  initialDocument: EditorDocument;
  onLocalEdit?: () => void;
};
