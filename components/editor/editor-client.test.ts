import { describe, expect, it, vi } from "vitest";

import {
  applyShareUpdateWithLocalEditSignal,
  navigateToDocumentsAfterDraftFlush,
} from "@/components/editor/editor-client";

describe("editor share reconciliation handoff", () => {
  it("signals a local mutation before applying confirmed share state", () => {
    const events: string[] = [];
    const onLocalEdit = vi.fn(() => events.push("local-edit"));
    const updateShareState = vi.fn(() => events.push("share-update"));

    applyShareUpdateWithLocalEditSignal(
      onLocalEdit,
      updateShareState,
      true,
      "share-token",
      "2026-08-17T14:00:00.000Z",
    );

    expect(events).toEqual(["local-edit", "share-update"]);
    expect(updateShareState).toHaveBeenCalledWith(
      true,
      "share-token",
      "2026-08-17T14:00:00.000Z",
    );
  });
});

describe("editor document-list navigation", () => {
  it("waits for the local draft flush before navigating", async () => {
    let finishFlush!: () => void;
    const flushLatestDraft = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = resolve;
        }),
    );
    const navigate = vi.fn();

    const navigation = navigateToDocumentsAfterDraftFlush(
      flushLatestDraft,
      navigate,
    );

    expect(flushLatestDraft).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();

    finishFlush();
    await navigation;

    expect(navigate).toHaveBeenCalledOnce();
  });
});
