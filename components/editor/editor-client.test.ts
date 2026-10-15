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
      undefined,
    );
  });
});

describe("editor document-list navigation", () => {
  it("waits for the local draft flush before navigating", async () => {
    let finishFlush!: (flushed: boolean) => void;
    const flushLatestDraft = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
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

    finishFlush(true);
    await navigation;

    expect(navigate).toHaveBeenCalledOnce();
  });

  it("stays in the editor when the latest draft cannot be serialized", async () => {
    const flushLatestDraft = vi.fn(async () => false);
    const navigate = vi.fn();

    await expect(
      navigateToDocumentsAfterDraftFlush(flushLatestDraft, navigate),
    ).resolves.toBe(false);

    expect(navigate).not.toHaveBeenCalled();
  });
});
