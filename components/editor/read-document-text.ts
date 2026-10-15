"use client";

import { type Text } from "@codemirror/state";

export type DocumentTextSource = string | Text | { toString(): string };

export function readDocumentText(doc: DocumentTextSource) {
  return typeof doc === "string" ? doc : doc.toString();
}
