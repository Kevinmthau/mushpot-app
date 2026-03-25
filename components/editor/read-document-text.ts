"use client";

import { type Text } from "@codemirror/state";

export function readDocumentText(doc: Text | string) {
  return typeof doc === "string" ? doc : doc.toString();
}
