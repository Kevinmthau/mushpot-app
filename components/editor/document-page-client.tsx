"use client";

import { useEffect } from "react";

import { EditorClient } from "@/components/editor/editor-lazy";
import { putCachedDocument, setLastActiveOwner } from "@/lib/doc-cache";
import type { EditorDocument } from "@/components/editor/editor-client";

type DocumentPageClientProps = {
  initialDocument: EditorDocument;
};

export function DocumentPageClient({ initialDocument }: DocumentPageClientProps) {
  useEffect(() => {
      void putCachedDocument({
        ...initialDocument,
        _dirty: false,
      });
      void setLastActiveOwner(initialDocument.owner);
    }, [initialDocument]);

  return <EditorClient initialDocument={initialDocument} />;
}
