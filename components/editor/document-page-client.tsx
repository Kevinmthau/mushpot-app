"use client";

import { useEffect, useState } from "react";

import { EditorClient } from "@/components/editor/editor-lazy";
import { MissingDocumentFallback } from "@/components/editor/missing-document-fallback";
import type { EditorDocument } from "@/components/editor/editor-types";
import {
  reconcileCachedDocumentWithServer,
  setLastActiveOwner,
  type CachedDocument,
} from "@/lib/doc-cache";

type DocumentPageClientProps = {
  initialDocument: EditorDocument;
};

function toEditorDocument(document: CachedDocument): EditorDocument {
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

function areDocumentsEqual(left: EditorDocument, right: EditorDocument) {
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

export function DocumentPageClient(props: DocumentPageClientProps) {
  const initialDocument = props?.initialDocument;

  if (!initialDocument) {
    return <MissingDocumentFallback />;
  }

  return (
    <DocumentPageClientInner
      key={initialDocument.id}
      initialDocument={initialDocument}
    />
  );
}

function DocumentPageClientInner({ initialDocument }: DocumentPageClientProps) {
  const [document, setDocument] = useState(initialDocument);

  useEffect(() => {
    void setLastActiveOwner(initialDocument.owner);

    let isActive = true;

    void (async () => {
      const resolvedDocument = await reconcileCachedDocumentWithServer({
        ...initialDocument,
        _dirty: false,
      });

      if (!isActive) {
        return;
      }

      const nextDocument = toEditorDocument(resolvedDocument);
      setDocument((currentDocument) =>
        areDocumentsEqual(currentDocument, nextDocument) ? currentDocument : nextDocument,
      );
    })();

    return () => {
      isActive = false;
    };
  }, [initialDocument]);

  return <EditorClient initialDocument={document} />;
}
